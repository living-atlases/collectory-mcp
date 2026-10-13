import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { validateXML } from "xmllint-wasm";
import { CollectoryError, entityOf, type CollectoryClient } from "./collectory-client.ts";

type Json = Record<string, unknown>;

/**
 * The EML collectory renders for a data resource (/ws/eml/{uid}), checked as GBIF checks it: against the GBIF EML
 * profile 1.1 schema (the one collectory declares in xsi:schemaLocation), plus the contact warning of GBIF's data
 * validator. Each problem says what fixes it: a field of the resource, collectory's config, or a newer collectory
 * (#303, fixed in 6.3.0 by #318; #310 by #311). The schemas are read from rs.gbif.org (they carry no licence to copy
 * them here) and compared with the versions this was tested with.
 */
export interface EmlProblem {
  severity: "error" | "warning" | "info";
  line?: number;
  element?: string;
  message: string;
  fix: string;
}

const PROFILE = "eml-gbif-profile/1.1/";
/** SHA-256 of the schema files as published at rs.gbif.org (2026-10). */
const SCHEMAS: Record<string, string> = {
  [`${PROFILE}eml.xsd`]: "c1306dc6e5cf3bd2dea2422d2b4ff177133cd598bb1989545b7a96260d46ea31",
  [`${PROFILE}eml-gbif-profile.xsd`]: "450abde6626d1a3a6c8c1410d31a6e163b05c63437bd36bf0c84c27dc121170f",
  [`${PROFILE}dc.xsd`]: "47b663ca11b893a24632f3e8568929d0e7720746198561c2a4f53d61f6990442",
  "xml.xsd": "2eafaa6bab254e61051901082d9bc7703c932c1c1675ec3b8dd9ce7140076397",
};
const VALIDATOR = "https://www.gbif.org/tool/81281/gbif-data-validator";
const LOADED = new Map<string, Schemas>();

export interface Schemas {
  main: { fileName: string; contents: string };
  preload: Array<{ fileName: string; contents: string }>;
  /** Files that differ from the tested versions (still used). */
  changed: string[];
}

/** Download the GBIF EML profile schemas and point their imports at each other, so validation needs no network. */
export async function loadSchemas(fetchText: (url: string) => Promise<string>, base: string): Promise<Schemas> {
  const files: Record<string, string> = {};
  const changed: string[] = [];
  for (const [path, sha] of Object.entries(SCHEMAS)) {
    const text = await fetchText(`${base}/${path}`);
    if (createHash("sha256").update(text).digest("hex") !== sha) changed.push(path);
    files[path] = text;
  }
  const local = (t: string) => t.replace(/schemaLocation="https?:\/\/[^"]*\/xml\.xsd"/g, 'schemaLocation="xml.xsd"');
  return {
    main: { fileName: "eml.xsd", contents: local(files[`${PROFILE}eml.xsd`]!) },
    preload: [
      { fileName: "eml-gbif-profile.xsd", contents: local(files[`${PROFILE}eml-gbif-profile.xsd`]!) },
      { fileName: "dc.xsd", contents: files[`${PROFILE}dc.xsd`]! },
      { fileName: "xml.xsd", contents: files["xml.xsd"]! },
    ],
    changed,
  };
}

export interface Context {
  uid: string;
  licenseType?: string;
}

/** Validate an EML document and explain each problem. */
export async function checkEml(xml: string, schemas: Schemas | undefined, ctx: Context): Promise<{ valid: boolean | null; problems: EmlProblem[] }> {
  const problems: EmlProblem[] = [];
  let valid: boolean | null = null;
  if (schemas) {
    const r = await validateXML({ xml: [{ fileName: `${ctx.uid}.xml`, contents: xml }], schema: [schemas.main], preload: schemas.preload });
    valid = r.valid;
    const paths = elementPaths(xml);
    const seen = new Set<string>();
    for (const e of r.errors) {
      const message = e.message.replace(/^.*?Schemas validity error : /, "").trim();
      const element = message.match(/Element '(?:\{[^}]*\})?([\w:.-]+)'/)?.[1] ?? "";
      const line = e.loc?.lineNumber;
      const key = `${line}:${element}`;
      if (seen.has(key)) continue; // libxml2 reports an empty NonEmptyString twice (minLength and pattern)
      seen.add(key);
      const path = paths.get(key) ?? element;
      problems.push({ severity: "error", ...(line ? { line } : {}), ...(path ? { element: path } : {}), message, fix: fixFor(element, path, message, ctx) });
    }
  }
  const $ = cheerio.load(xml, { xml: true });
  const contacts = $("dataset > contact");
  if (!contacts.length || contacts.toArray().every((c) => !$(c).find("individualName > surName").text().trim()))
    problems.push({
      severity: "warning",
      element: "dataset/contact",
      message: "RESOURCE_CONTACTS_MISSING_OR_INCOMPLETE: the resource contact has no individualName (GBIF data validator)",
      fix: `make a person with a last name the primary contact of ${ctx.uid} (collectory_add_contact or collectory_update_contact with primaryContact:true): without one collectory writes the portal's own organisation from its eml.* config`,
    });
  if (!$("dataset > abstract").text().trim()) problems.push({ severity: "info", element: "dataset/abstract", message: "the abstract is empty: GBIF shows no description", fix: "set pubDescription (collectory_save_entity)" });
  return { valid, problems };
}

/** Fetch and check the EML of data resources, and tell whether GBIF's copy of the metadata comes from it. */
export class EmlCheck {
  private schemas?: Promise<Schemas | undefined>;
  private schemaNote?: string;
  private oldRenderer = false;

  constructor(
    readonly client: CollectoryClient,
    readonly gbifApi: string,
    readonly schemaBase: string,
  ) {}

  async check(uid: string) {
    if (entityOf(uid) !== "dataResource") throw new Error(`${uid} is not a data resource (dr…)`);
    const dr = await this.client.get<Json>(uid, "dataResource");
    const ctx: Context = { uid, licenseType: dr["licenseType"] as string | undefined };
    const gbif = await this.gbif(uid, dr).catch((e: Error) => ({ source: "unknown" as const, note: e.message }));
    let xml: string;
    try {
      xml = await this.client.text(`/ws/eml/${encodeURIComponent(uid)}`, { accept: "application/xml" });
    } catch (e) {
      if (!(e instanceof CollectoryError)) throw e;
      const parse = /JsonException|expecting '}'|JsonSlurper/.test(e.body);
      return {
        uid,
        name: dr["name"],
        valid: false,
        problems: [{ severity: "error", message: `GET /ws/eml/${uid} -> ${e.status}: ${e.body.replace(/\s+/g, " ").slice(0, 300)}`, fix: parse ? "#310: the taxonomic hints are not valid JSON: rewrite them with collectory_set_taxonomy_hints, or upgrade to collectory 6.3.0 (#311)" : "see collectory's log; GBIF cannot read this resource's metadata" }],
        gbif,
      };
    }
    const schemas = await this.loadSchemas();
    const r = await checkEml(xml, schemas, ctx);
    if (r.problems.some((p) => / 6\.3\.0 fixed /.test(p.fix))) this.oldRenderer = true;
    return {
      uid,
      name: dr["name"],
      valid: r.valid,
      ...(r.valid === null ? { note: this.schemaNote } : {}),
      errors: r.problems.filter((p) => p.severity === "error").length,
      problems: r.problems,
      gbif,
    };
  }

  /** Common to all the resources checked. */
  async about(): Promise<Json> {
    const s = await this.loadSchemas();
    return {
      schema: s ? `GBIF EML profile 1.1 (${this.schemaBase}/${PROFILE})` : null,
      ...(s?.changed.length ? { schemaNote: `${s.changed.join(", ")} differ from the versions this was tested with` } : {}),
      ...(this.oldRenderer ? { collectory: "this collectory's EML renderer predates 6.3.0 (whatever version it reports): it writes elements the GBIF profile rejects whatever the data (#303); 6.3.0 fixes most of them (#318)" } : {}),
      fullCheck: `the GBIF data validator (${VALIDATOR}) also checks the data`,
    };
  }

  /** Loaded once per process; a failure only for this checker (one tool call). */
  private loadSchemas(): Promise<Schemas | undefined> {
    const loaded = LOADED.get(this.schemaBase);
    if (loaded) return Promise.resolve(loaded);
    this.schemas ??= loadSchemas((u) => this.client.external(u, "application/xml"), this.schemaBase).then(
      (s) => (LOADED.set(this.schemaBase, s), s),
      (e: Error) => {
        this.schemaNote = `the GBIF EML profile schema could not be read (${e.message.slice(0, 200)}): only the contact and abstract checks ran`;
        return undefined;
      },
    );
    return this.schemas;
  }

  /**
   * Where GBIF's metadata for the resource comes from. GBIF keeps the EML it last crawled (dataset/{key}/document);
   * collectory's renderer always writes {serverURL}/public/show/{uid} in it (the alaPublicUrl), so finding it there means GBIF's
   * copy is collectory's, through the archive collectory registered (gbifRegistryKey) or an export of it.
   */
  private async gbif(uid: string, dr: Json): Promise<{ source: "collectory" | "ipt" | "other" | "not-registered" | "unknown"; key?: string; note: string }> {
    const uuid = (v: unknown) => (typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : undefined);
    const key = uuid(dr["gbifRegistryKey"]) ?? uuid(dr["guid"]);
    if (!key) return { source: "not-registered", note: "no gbifRegistryKey and the guid is not a GBIF dataset key: as far as collectory knows, GBIF does not have this resource" };
    let ds: Json;
    try {
      ds = JSON.parse(await this.client.external(`${this.gbifApi}/dataset/${key}`)) as Json;
    } catch (e) {
      return { source: "unknown", key, note: `GBIF dataset ${key}: ${(e as Error).message.slice(0, 200)}` };
    }
    const doc = await this.client.external(`${this.gbifApi}/dataset/${key}/document`, "application/xml").catch(() => "");
    // the resource's own public page (any scheme); without alaPublicUrl, any host's /public/show/{uid}
    const page = typeof dr["alaPublicUrl"] === "string" && dr["alaPublicUrl"] ? (dr["alaPublicUrl"] as string).replace(/^https?:/, "") : `/public/show/${uid}`;
    if (doc.includes(`${page}<`) || doc.includes(`${page}"`))
      return { source: "collectory", key, note: "GBIF's copy of the metadata comes from this collectory: fixes here reach GBIF at its next crawl of the dataset" };
    const ik = ds["installationKey"] as string | undefined;
    const inst = ik ? ((JSON.parse(await this.client.external(`${this.gbifApi}/installation/${ik}`).catch(() => "{}")) as Json) ?? {}) : {};
    if (inst["type"] === "IPT_INSTALLATION") return { source: "ipt", key, note: `published by the IPT "${inst["title"] ?? ik}": GBIF reads the IPT's EML, so fix the metadata there (collectory_ipt_scan then copies it here)` };
    if (!doc) return { source: "unknown", key, note: "GBIF has no metadata document for this dataset" };
    return { source: "other", key, note: "GBIF's metadata for this dataset does not come from this collectory (another publisher or an older copy)" };
  }
}

/** "line:name" of each start tag -> its path below the root (dataset/contact/electronicMailAddress). */
function elementPaths(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  const stack: string[] = [];
  let line = 1;
  let last = 0;
  for (const m of xml.matchAll(/<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>/g)) {
    for (let i = last; i < m.index; i++) if (xml.charCodeAt(i) === 10) line++;
    last = m.index;
    const name = m[2]!.replace(/^\w+:/, "");
    if (m[1]) stack.pop();
    else {
      stack.push(name);
      if (!out.has(`${line}:${name}`)) out.set(`${line}:${name}`, stack.slice(1).join("/") || name);
      if (m[3]) stack.pop();
    }
  }
  return out;
}

/**
 * The fix for a schema error. What 6.3.0 fixed (#318) is told by the symptom, not by the version collectory reports
 * (ALA's production answers 5.1.1 in its OpenAPI document while rendering EML of a 6.3.0 pre-release).
 */
function fixFor(element: string, path: string, message: string, c: Context): string {
  const renderer = (what: string) => `this collectory ${what}, which collectory 6.3.0 fixed (#303, #318): upgrade`;
  const emptyIn63 = (fix: string) => `${fix}; collectory 6.3.0 or later omits it when empty (#318)`;
  if (element === "eml" && /packageId/.test(message)) return renderer("does not write packageId");
  if (element === "ulink") return `more than one licence has the acronym ${c.licenseType ?? "of licenseType"} (near-duplicates such as 4.0 and 4.x, #289) and this collectory writes them all: remove the near-duplicate (collectory_delete_licence), or upgrade: collectory 6.3.0 writes only one (#318)`;
  if (element === "methods") return emptyIn63("set methodStepDescription (collectory_save_entity)");
  if (element === "coverage")
    return "set geographicDescription with all four bounding coordinates, or beginDate and endDate (collectory_save_entity). Before 6.3.0 collectory writes an empty coverage when there is none (#318); 6.3.0 and develop still do when the bounding box is incomplete (westBoundingCoordinate without the other three)";
  if (/BoundingCoordinate$/.test(element)) return "set all four bounding coordinates (collectory_save_entity)";
  if (element === "generalTaxonomicCoverage") return "the taxonomic hints have no range: set one with collectory_set_taxonomy_hints (range:[…]); collectory writes generalTaxonomicCoverage from it even when empty (6.3.0 and develop)";
  if (element === "citation" && /not expected/.test(message)) return renderer("writes the GBIF metadata in the wrong order");
  if (element === "citation") return emptyIn63("set citation (collectory_save_entity)");
  if (element === "rights" && path.includes("gbif")) return renderer("writes a rights element the GBIF profile does not have");
  if (element === "intellectualRights") return emptyIn63("set rights, citation or licenseType (collectory_save_entity)");
  if (element === "electronicMailAddress")
    return path.includes("associatedParty")
      ? "the portal's own party has no email: set eml.electronicMailAddress in collectory's config"
      : "the resource contact has no email: set the primary contact's email, or eml.electronicMailAddress in collectory's config when collectory writes the portal's own organisation";
  if (element === "title") return "set the resource's name (collectory_save_entity)";
  return `see #303; ${VALIDATOR} gives the same schema errors`;
}
