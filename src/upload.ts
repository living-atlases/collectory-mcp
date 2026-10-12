import { openAsBlob, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import * as cheerio from "cheerio";
import { CollectoryError, type CollectoryClient } from "./collectory-client.ts";
import { findForm } from "./forms.ts";
import type { FullContactLink } from "./workflows.ts";
import { fileSource, readZip } from "./zip.ts";

type Json = Record<string, unknown>;

/**
 * Upload a data file to a data resource through /dataResource/uploadDataFile (the admin page's form), which is what
 * collectory does with it (DataImportService.importDataFileForDataResource, 6.3.0):
 * - every connection parameter of the protocol's profile is set from the request: one not sent becomes null (false for
 *   a boolean), termsForUniqueKey falls back to occurrenceID, and the url points to the uploaded file (#207, #208, #307);
 * - a Darwin Core Archive's eml.xml overwrites the resource's metadata (name, guid, description, rights, citation,
 *   coverage, licence…), clearing the fields whose element is missing (6.x: "EML is the source of truth");
 * - 6.x syncs the contacts with the EML: links the EML does not list are removed and their contacts deleted when no
 *   other entity uses them. A CSV, or an archive without eml.xml, removes every contact. 5.x only adds the EML's
 *   contacts, as primary contacts.
 * The MCP sends every parameter with its current value, refuses what would lose data unless asked, and checks after.
 */
export interface UploadInput {
  uid: string;
  file: string;
  protocol?: string;
  termsForUniqueKey?: string[];
  /** Other connection parameters of the protocol's profile, e.g. {incremental: true, csv_delimiter: ";"}. */
  set?: Record<string, string | boolean>;
  /** Accept a change of termsForUniqueKey (every record gets a new id). */
  allowKeyChange?: boolean;
  /** Upload although a termsForUniqueKey term is not a column of the file. */
  allowMissingKeyTerms?: boolean;
  /** What to do with the contact links collectory would remove: keep them out (accept) or re-create them (restore). */
  contacts?: "accept" | "restore";
}

const DEFAULT_LIMIT = 26_214_400;

/** Dataset elements of the EML each resource field is taken from (EmlImportService.emlFields, 6.3.0). */
const EML_FIELDS: Array<[string, (e: Eml) => string | undefined]> = [
  ["name", (e) => e.text("dataset > title")],
  ["guid", (e) => e.root.attr("packageId") || undefined],
  ["pubDescription", (e) => e.text("dataset > abstract")],
  ["email", (e) => e.text("dataset > contact > electronicMailAddress")],
  ["phone", (e) => e.text("dataset > contact > phone")],
  ["rights", (e) => e.text("dataset > intellectualRights")],
  ["citation", (e) => e.text("additionalMetadata > metadata > gbif > citation")],
  ["geographicDescription", (e) => e.text("dataset > coverage > geographicCoverage > geographicDescription")],
  ["northBoundingCoordinate", (e) => e.text("boundingCoordinates > northBoundingCoordinate")],
  ["southBoundingCoordinate", (e) => e.text("boundingCoordinates > southBoundingCoordinate")],
  ["eastBoundingCoordinate", (e) => e.text("boundingCoordinates > eastBoundingCoordinate")],
  ["westBoundingCoordinate", (e) => e.text("boundingCoordinates > westBoundingCoordinate")],
  ["beginDate", (e) => e.text("temporalCoverage beginDate calendarDate")],
  ["endDate", (e) => e.text("temporalCoverage endDate calendarDate")],
  ["purpose", (e) => e.text("dataset > purpose")],
  ["methodStepDescription", (e) => e.text("dataset > methods > methodStep")],
  ["qualityControlDescription", (e) => e.text("dataset > methods > qualityControl")],
  ["licenseType", (e) => e.text("dataset > intellectualRights")],
];

interface Eml {
  root: cheerio.Cheerio<any>;
  text(sel: string): string | undefined;
  parties: Array<{ element: string; firstName?: string; lastName?: string; email?: string; organization?: string; position?: string }>;
}

export function parseEml(xml: string): Eml {
  const $ = cheerio.load(xml, { xmlMode: true });
  const root = $.root().children().first();
  const text = (sel: string) => {
    const t = root.find(sel).first().text().replace(/\s+/g, " ").trim();
    return t || undefined;
  };
  const parties: Eml["parties"] = [];
  for (const el of ["creator", "contact", "metadataProvider"]) {
    root.find(`dataset > ${el}`).each((_, p) => {
      const g = (s: string) => $(p).find(s).first().text().trim() || undefined;
      const party = { element: el, firstName: g("individualName > givenName"), lastName: g("individualName > surName"), email: g("electronicMailAddress"), organization: g("organizationName"), position: g("positionName") };
      // collectory skips a party with neither surname, organisation nor position
      if (party.lastName || party.organization || party.position) parties.push(party);
    });
  }
  return { root, text, parties };
}

/** Core row type, id column and field terms (short names) of a Darwin Core Archive's meta.xml. */
export function parseMeta(xml: string) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const core = $("core").first();
  return {
    rowType: core.attr("rowType"),
    terms: core.find("field").toArray().map((f) => ($(f).attr("term") ?? "").replace(/^.*[/#]/, "")).filter(Boolean),
  };
}

export class DataUpload {
  constructor(
    readonly client: CollectoryClient,
    /** Every contact linked to an entity, unpublished ones included (Workflows.contactLinks). */
    readonly contactLinks: (uid: string) => Promise<{ links: FullContactLink[]; complete: boolean }>,
  ) {}

  async plan(input: UploadInput) {
    const errors: string[] = [];
    const warnings: string[] = [];
    const path = resolve(input.file);
    const st = statSync(path, { throwIfNoEntry: false });
    if (!st?.isFile()) throw new Error(`${input.file} is not a file`);
    const major = (await this.client.version().catch(() => ({ major: 6 }))).major;

    const dr = await this.client.get<Json>(input.uid, "dataResource");
    const cp = toObject(dr["connectionParameters"]);
    const page = await this.client.page(`/dataResource/upload/${input.uid}`);
    const $ = cheerio.load(page.html);
    const protocols = $("select#protocol option").toArray().map((o) => $(o).attr("value") ?? "");
    const protocol = input.protocol ?? (protocols.includes(String(cp["protocol"])) ? String(cp["protocol"]) : undefined);
    if (!protocol || !protocols.includes(protocol)) throw new Error(`choose a protocol: ${protocols.join(", ")}`);
    const params = $(`#profile-${protocol}`)
      .find("input[name]")
      .toArray()
      .map((i) => ({ name: $(i).attr("name")!, boolean: $(i).attr("type") === "checkbox" }))
      .filter((p) => !p.name.startsWith("_"));
    if (!params.length) throw new Error(`the upload page has no parameters for ${protocol}: the collectory admin UI may have changed (nothing was sent)`);
    const unknown = Object.keys(input.set ?? {}).filter((k) => !params.some((p) => p.name === k));
    if (unknown.length) throw new Error(`${unknown.join(", ")}: not parameters of ${protocol} (${params.map((p) => p.name).join(", ")})`);

    // Values sent: what is stored now (verbatim), unless asked otherwise. A parameter with no value is not sent.
    const beforeTerms = Array.isArray(cp["termsForUniqueKey"]) ? (cp["termsForUniqueKey"] as string[]) : undefined;
    const terms = input.termsForUniqueKey ?? beforeTerms;
    const send: Array<[string, string]> = [];
    const after: Json = { ...cp, protocol };
    for (const p of params) {
      const v = p.name === "termsForUniqueKey" ? terms : (input.set?.[p.name] ?? cp[p.name]);
      if (p.boolean) {
        const on = v === true || v === "true";
        if (on) send.push([p.name, "true"]);
        after[p.name] = on;
      } else if (v !== undefined && v !== null && !(Array.isArray(v) && !v.length)) {
        send.push([p.name, Array.isArray(v) ? v.join(",") : String(v)]);
        after[p.name] = p.name === "termsForUniqueKey" ? String(Array.isArray(v) ? v.join(",") : v).split(",").map((t) => t.trim()) : v;
      } else after[p.name] = null;
    }
    if (!after["termsForUniqueKey"] || !(after["termsForUniqueKey"] as string[]).length) {
      after["termsForUniqueKey"] = ["occurrenceID"];
      warnings.push("no termsForUniqueKey: collectory uses occurrenceID");
    }
    after["url"] = "(the uploaded file)";
    const afterTerms = after["termsForUniqueKey"] as string[];
    if (beforeTerms?.length && beforeTerms.join(",") !== afterTerms.join(",") && !input.allowKeyChange) errors.push(`termsForUniqueKey changes from ${beforeTerms.join(",")} to ${afterTerms.join(",")}: every record gets a new id, so the next load duplicates or replaces them all. Pass allowKeyChange:true if that is intended`);

    // The file
    const file: Json = { path, name: basename(path), size: st.size };
    if (st.size > DEFAULT_LIMIT) warnings.push(`${(st.size / 1048576).toFixed(1)} MB: collectory's default upload limit is 25 MB (grails.controllers.upload.maxFileSize/maxRequestSize); larger files are refused unless the portal raised it`);
    let columns: string[] | undefined;
    let eml: Eml | undefined;
    if (protocol === "DwCA") {
      const z = fileSource(path);
      try {
        const entries = readZip(z);
        const get = (n: string) => entries.find((e) => e.name.toLowerCase() === n || e.name.toLowerCase().endsWith(`/${n}`));
        file["entries"] = entries.length;
        const meta = get("meta.xml");
        if (!meta) errors.push("the archive has no meta.xml: it is not a Darwin Core Archive");
        else {
          const m = parseMeta(meta.read().toString("utf8"));
          columns = m.terms;
          file["core"] = m.rowType;
        }
        const e = get("eml.xml");
        if (e) eml = parseEml(e.read().toString("utf8"));
        file["eml"] = !!e;
      } finally {
        z.close();
      }
    } else if (protocol === "DwC") {
      const z = fileSource(path);
      try {
        const head = z.read(0, Math.min(z.size, 65_536)).toString("utf8").split(/\r?\n/)[0] ?? "";
        const delim = (after["csv_delimiter"] as string | undefined) || (head.includes("\t") ? "\t" : ",");
        columns = head.split(delim).map((c) => c.trim().replace(/^"|"$/g, ""));
      } finally {
        z.close();
      }
    }
    if (columns) {
      const missing = afterTerms.filter((t) => !columns!.includes(t));
      if (missing.length && !input.allowMissingKeyTerms) errors.push(`termsForUniqueKey ${missing.join(", ")} ${missing.length > 1 ? "are not columns" : "is not a column"} of the file: those records would get empty keys. Pass allowMissingKeyTerms:true if that is intended`);
    }

    // Metadata the EML overwrites
    const metadata: Json[] = [];
    const cleared: string[] = [];
    if (eml) {
      for (const [field, read] of EML_FIELDS) {
        const v = read(eml);
        const now = dr[field];
        const has = now !== undefined && now !== null && String(now) !== "";
        if (v === undefined) {
          if (has && major >= 6) cleared.push(field);
        } else if (field !== "licenseType" && String(now ?? "") !== v) metadata.push({ field, from: now ?? null, to: v.length > 200 ? `${v.slice(0, 200)}…` : v });
        else if (field === "licenseType") metadata.push({ field: "licenseType/licenseVersion", from: `${dr["licenseType"] ?? ""} ${dr["licenseVersion"] ?? ""}`.trim() || null, to: "from the EML's intellectualRights" });
      }
      const guid = dr["guid"] as string | undefined;
      const pkg = eml.root.attr("packageId");
      if (guid && /^[0-9a-f-]{36}$/i.test(guid) && pkg !== guid) warnings.push(`guid changes from ${guid} (a GBIF dataset key, used by collectory_gbif_preview and collectory_mapping_check) to ${pkg ?? "nothing"}`);
      if (cleared.length) warnings.push(`the EML has no element for ${cleared.join(", ")}: collectory clears them`);
    }

    // Contacts
    const current = (await this.contactLinks(input.uid)).links as unknown as Json[];
    let removed: Json[] = [];
    let added: Json[] = [];
    if (major >= 6) {
      const parties = eml?.parties ?? [];
      const kept = new Set<number>();
      for (const p of parties) {
        const i = current.findIndex((c) => matches(p, c));
        if (i >= 0) kept.add(i);
        else added.push(p);
      }
      removed = current.filter((_, k) => !kept.has(k));
      if (removed.length) {
        const why = eml ? "the EML does not list them (6.x: the EML is the source of truth)" : `a ${protocol === "DwCA" ? "Darwin Core Archive without eml.xml" : "CSV upload"} removes every contact (a collectory bug: nothing to sync from)`;
        if (!input.contacts) errors.push(`collectory would unlink ${removed.length} contacts and delete those no other entity uses, because ${why}: ${removed.map((c) => c["email"] ?? `${c["firstName"] ?? ""} ${c["lastName"] ?? ""}`.trim()).join(", ")}. Pass contacts:"accept"${eml ? "" : ' or contacts:"restore" (re-create and re-link them after the upload)'}`);
        if (input.contacts === "restore" && eml) errors.push('contacts:"restore" is for uploads without an EML; with an EML its contacts are the intended ones: use contacts:"accept" or fix the EML');
      }
    } else if (eml) {
      added = eml.parties.filter((p) => p.email && !current.some((c) => String(c["email"] ?? "").toLowerCase() === p.email!.toLowerCase()));
      if (added.length) warnings.push(`collectory 5.x adds the EML's contacts that are not linked yet, as primary contacts: ${added.map((p) => p.email).join(", ")}`);
    }

    const changes = Object.keys({ ...cp, ...after })
      .filter((k) => k !== "url" && JSON.stringify(cp[k] ?? null) !== JSON.stringify(after[k] ?? null))
      .map((k) => ({ field: k, from: cp[k] ?? null, to: after[k] ?? null }));
    return {
      uid: input.uid,
      name: dr["name"],
      file,
      protocol,
      connectionParameters: { before: cp, after, changes },
      ...(eml ? { metadataFromEml: metadata, cleared } : {}),
      contacts: { now: current.map((c) => c["email"] ?? c["lastName"]), ...(removed.length ? { removed: removed.map((c) => c["email"] ?? c["lastName"]) } : {}), ...(added.length ? { added: added.map((p) => p.email ?? p.lastName ?? p.organization) } : {}) },
      errors,
      warnings,
      next: "after the upload, load the resource again (pipelines) so the records come from the new file",
      // kept for the upload itself, not shown
      _send: send,
      _removed: removed,
      _formAction: findForm(page.html, page.url, { action: /uploadDataFile$/ }).action,
    };
  }

  async upload(input: UploadInput) {
    const plan = await this.plan(input);
    if (plan.errors.length) throw new Error(plan.errors.join("; "));
    const fd = new FormData();
    fd.set("id", input.uid);
    fd.set("protocol", plan.protocol);
    fd.set("myFile", await openAsBlob(String(plan.file["path"])), String(plan.file["name"]));
    for (const [k, v] of plan._send) fd.append(k, v);
    try {
      await this.client.submit(plan._formAction, fd);
    } catch (e) {
      if (e instanceof CollectoryError && /maximum upload size|SizeLimitExceeded|MaxUploadSize/i.test(e.message)) throw new Error(`collectory refused the file: it is larger than its upload limit (grails.controllers.upload.maxFileSize, 25 MB by default)`);
      throw e;
    }

    const dr = await this.client.get<Json>(input.uid, "dataResource");
    const now = toObject(dr["connectionParameters"]);
    const expected = plan.connectionParameters.after;
    const unexpected = Object.keys({ ...expected, ...now })
      .filter((k) => k !== "url" && JSON.stringify(now[k] ?? null) !== JSON.stringify(expected[k] ?? null))
      .map((k) => ({ field: k, expected: expected[k] ?? null, now: now[k] ?? null }));

    const restored: Json[] = [];
    if (input.contacts === "restore") {
      for (const c of plan._removed) {
        const email = c["email"] as string | undefined;
        if (!email) {
          restored.push({ contact: `${c["firstName"] ?? ""} ${c["lastName"] ?? ""}`.trim(), restored: false, why: "no email to find or re-create it by" });
          continue;
        }
        const existing = await this.client.contactByEmail(email);
        const contact = existing ?? (await this.client.saveContact(undefined, Object.fromEntries(["title", "firstName", "lastName", "email", "phone", "fax", "mobile", "publish"].filter((k) => c[k] !== undefined && c[k] !== null).map((k) => [k, c[k]]))));
        const link = { role: c["role"], administrator: c["administrator"], primaryContact: c["primaryContact"], notify: c["notify"] };
        await this.client.linkContact(input.uid, Number(contact["id"]), link);
        if (link.notify) await this.client.linkContact(input.uid, Number(contact["id"]), link);
        restored.push({ contact: email, restored: true, ...(existing ? {} : { recreated: true, id: contact["id"], note: "collectory had deleted it: re-created with a new id" }) });
      }
    }
    const contactsNow = (await this.contactLinks(input.uid)).links.map((l) => l.email ?? l.lastName);
    const { _send: _s, _removed: _r, _formAction: _f, ...shown } = plan;
    return {
      ...shown,
      uploaded: true,
      connectionParameters: { ...plan.connectionParameters, now, ...(unexpected.length ? { unexpected } : {}) },
      verified: !unexpected.length && String(now["protocol"]) === plan.protocol,
      contacts: { ...plan.contacts, after: contactsNow, ...(restored.length ? { restored } : {}) },
      metadataNow: Object.fromEntries(["name", "guid", "licenseType", "licenseVersion"].map((k) => [k, dr[k] ?? null])),
    };
  }
}

/** collectory's EmlImportService.addOrUpdateContact match, as far as the web service shows the contact. */
function matches(p: Eml["parties"][number], c: Json): boolean {
  if (p.lastName && c["lastName"] !== p.lastName) return false;
  if (p.firstName && c["firstName"] !== p.firstName) return false;
  if (p.email && c["email"] && c["email"] !== p.email) return false;
  return true;
}

function toObject(v: unknown): Json {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Json;
  if (typeof v === "string" && v.trim()) {
    try {
      return JSON.parse(v) as Json;
    } catch {
      return {};
    }
  }
  return {};
}
