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
  /** collectory version, e.g. 6.3 */
  major: number;
  minor: number;
  licenseType?: string;
  licenseVersion?: string;
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

  constructor(
    readonly client: CollectoryClient,
    readonly gbifApi: string,
    readonly schemaBase: string,
  ) {}

  async check(uid: string) {
    if (entityOf(uid) !== "dataResource") throw new Error(`${uid} is not a data resource (dr…)`);
    const v = await this.client.version().catch(() => ({ version: "unknown", major: 0, minor: 0 }));
    const dr = await this.client.get<Json>(uid, "dataResource");
    const ctx: Context = { uid, major: v.major, minor: v.minor, licenseType: dr["licenseType"] as string | undefined, licenseVersion: dr["licenseVersion"] as string | undefined };
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
        problems: [{ severity: "error", message: `GET /ws/eml/${uid} -> ${e.status}: ${e.body.replace(/\s+/g, " ").slice(0, 300)}`, fix: parse ? "#310: the taxonomic hints are not valid JSON: fix them in the admin UI (Edit > Taxonomic hints), or upgrade to collectory 6.3.0 (#311)" : "see collectory's log; GBIF cannot read this resource's metadata" }],
        gbif,
      };
    }
    const schemas = await this.loadSchemas();
    const r = await checkEml(xml, schemas, ctx);
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
    const v = await this.client.version().catch(() => undefined);
    return {
      schema: s ? `GBIF EML profile 1.1 (${this.schemaBase}/${PROFILE})` : null,
      ...(s?.changed.length ? { schemaNote: `${s.changed.join(", ")} differ from the versions this was tested with` } : {}),
      ...(v && (v.major < 6 || (v.major === 6 && v.minor < 3)) ? { collectory: `${v.version}: its EML renderer writes elements the GBIF profile rejects whatever the data (packageId, empty or misplaced elements, #303); 6.3.0 fixes most of them (#318)` } : {}),
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
   * collectory's renderer always writes {serverURL}/public/show/{uid} in it, so finding that URL there means GBIF's
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
    if (doc.includes(`/public/show/${uid}<`) || doc.includes(`/public/show/${uid}"`))
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

const before63 = (c: Context) => c.major < 6 || (c.major === 6 && c.minor < 3);

function fixFor(element: string, path: string, message: string, c: Context): string {
  const upgrade = (what: string) => (before63(c) ? `collectory before 6.3.0 ${what}: upgrade (#303, fixed by #318)` : `collectory ${c.major}.${c.minor} ${what} (#303)`);
  const orUpgrade = (fix: string, what: string) => (before63(c) ? `${fix}, or upgrade: collectory before 6.3.0 ${what} (#318)` : fix);
  if (element === "eml" && /packageId/.test(message)) return upgrade("does not write packageId");
  if (element === "ulink") return `more than one licence matches licenseType ${c.licenseType ?? "?"} ${c.licenseVersion ? `version ${c.licenseVersion}` : "(no licenseVersion: any version matches)"}: ${c.licenseVersion ? "" : "set licenseVersion (collectory_save_entity), or "}remove the near-duplicate licence (collectory_delete_licence, #289)${before63(c) ? "; collectory 6.3.0 writes only the first (#318)" : ""}`;
  if (element === "methods") return orUpgrade("set methodStepDescription (collectory_save_entity)", "writes an empty methods");
  if (element === "coverage")
    return orUpgrade(
      "set geographicDescription with all four bounding coordinates, or beginDate and endDate (collectory_save_entity). An incomplete bounding box (westBoundingCoordinate without the other three) also leaves coverage empty in 6.3.0 and develop",
      "writes an empty coverage when there is none",
    );
  if (/BoundingCoordinate$/.test(element)) return "set all four bounding coordinates (collectory_save_entity)";
  if (element === "generalTaxonomicCoverage") return "the taxonomic hints have no range: add one in the admin UI (Edit > Taxonomic hints); collectory writes generalTaxonomicCoverage from it even when empty (6.3.0 and develop)";
  if (element === "citation" && /not expected/.test(message)) return upgrade("writes the GBIF metadata in the wrong order");
  if (element === "citation") return orUpgrade("set citation (collectory_save_entity)", "writes it even when empty");
  if (element === "rights" && path.includes("gbif")) return upgrade("writes a rights element the GBIF profile does not have");
  if (element === "intellectualRights") return orUpgrade("set rights, citation or licenseType (collectory_save_entity)", "writes it even when empty");
  if (element === "electronicMailAddress")
    return path.includes("associatedParty")
      ? "the portal's own party has no email: set eml.electronicMailAddress in collectory's config"
      : "the resource contact has no email: set the primary contact's email, or eml.electronicMailAddress in collectory's config when collectory writes the portal's own organisation";
  if (element === "title") return "set the resource's name (collectory_save_entity)";
  return `see #303; ${VALIDATOR} gives the same schema errors`;
}
