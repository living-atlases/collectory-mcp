import type { Entity } from "./collectory-client.ts";

/**
 * What POST /ws/{entity}[/{uid}] accepts, from CrudService (6.3.0; 5.1.x has the same lists without createdByID).
 * Anything else in the body is silently ignored by collectory, so it is refused here with the place it can be changed.
 */
const BASE = ["guid", "name", "acronym", "phone", "email", "state", "pubShortDescription", "pubDescription", "techDescription", "notes", "isALAPartner", "focus", "attributions", "websiteUrl", "networkMembership", "altitude", "gbifRegistryKey", "latitude", "longitude", "address", "imageRef", "logoRef", "externalIdentifiers"];

export const WRITABLE: Record<Entity, readonly string[]> = {
  institution: [...BASE, "institutionType"],
  collection: [...BASE, "collectionType", "keywords", "active", "states", "geographicDescription", "startDate", "endDate", "kingdomCoverage", "scientificNames", "subCollections", "numRecords", "numRecordsDigitised", "eastCoordinate", "westCoordinate", "northCoordinate", "southCoordinate", "institution", "recordsMapping"],
  dataProvider: [...BASE, "hiddenJSON"],
  dataResource: [
    ...BASE,
    ...["rights", "citation", "dataGeneralizations", "informationWithheld", "permissionsDocument", "licenseType", "licenseVersion", "status", "mobilisationNotes", "provenance", "harvestingNotes", "connectionParameters", "resourceType", "permissionsDocumentType", "riskAssessment", "filed", "publicArchiveAvailable", "contentTypes", "defaultDarwinCoreValues", "imageMetadata"],
    ...["geographicDescription", "northBoundingCoordinate", "southBoundingCoordinate", "eastBoundingCoordinate", "westBoundingCoordinate", "beginDate", "endDate", "qualityControlDescription", "methodStepDescription", "gbifDoi", "repatriationCountry", "isPrivate", "createdByID"],
    ...["harvestFrequency", "downloadLimit", "lastChecked", "dataCurrency", "gbifDataset", "isShareableWithGBIF", "dataProvider", "institution"],
  ],
  dataHub: [...BASE, "memberDataResources"],
  tempDataResource: ["firstName", "lastName", "name", "email", "alaId", "webserviceUrl", "uiUrl", "description", "status", "type", "dataGeneralisations", "informationWithheld", "license", "citation", "sourceFile", "prodUid", "keyFields", "csvSeparator", "numberOfRecords", "isContactPublic"],
};

/** Where the fields the web service cannot write are changed instead. */
const ELSEWHERE: Record<string, string> = {
  memberInstitutions: "collectory_set_hub_members (admin form)",
  memberCollections: "collectory_set_hub_members (admin form)",
  linkedRecordConsumers: "collectory_set_record_consumers (admin form)",
  taxonomyHints: "the admin UI (Edit > Taxonomic hints)",
  keywords: "the admin UI (not writable through the web service for this entity)",
  purpose: "the admin UI",
  suitableFor: "the admin UI",
  childInstitutions: "the admin UI",
  gbifCountryToAttribute: "the admin UI",
  contacts: "collectory_add_contact",
  uid: "nowhere: uids are assigned by collectory",
};

/** Maximum lengths (domain constraints); longer values make the save fail with a misleading error (#315). */
const MAX: Record<string, number> = { guid: 256, name: 1024, acronym: 45, pubShortDescription: 100, state: 45, websiteUrl: 256, email: 256, phone: 200, networkMembership: 256, attributions: 256, gbifRegistryKey: 36, licenseType: 45, licenseVersion: 45, resourceType: 255, provenance: 45, status: 45, contentTypes: 2048 };

const DR_STATUS = ["identified", "inProgress", "dataAvailable", "linksAvailable", "declined"];
const DR_TYPES = ["records", "website", "document", "uploads", "species-list", "publications"];
const URL_FIELDS = ["websiteUrl"];

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface Plan {
  body: Record<string, unknown>;
  changes: FieldChange[];
  warnings: string[];
}

/**
 * Validate a create/update body and compute what changes against the current entity. Throws on anything collectory
 * would ignore or reject; returns warnings for what it would accept but is probably a mistake.
 */
export function planEntityWrite(entity: Entity, current: Record<string, unknown> | undefined, input: Record<string, unknown>): Plan {
  const writable = new Set(WRITABLE[entity]);
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const k of Object.keys(input)) {
    if (!writable.has(k)) errors.push(ELSEWHERE[k] ? `${k} cannot be written through the web service: use ${ELSEWHERE[k]}` : `${k} is not a field collectory's web service writes for ${entity} (it would be silently ignored)`);
  }
  if (!current && !input["name"]) errors.push("name is required to create an entity");
  if (!current && entity === "dataHub" && "memberDataResources" in input) errors.push("collectory ignores memberDataResources when a data hub is created: create the hub first, then collectory_set_hub_members");
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string" && MAX[k] && v.length > MAX[k]!) errors.push(`${k} is ${v.length} characters, collectory allows ${MAX[k]}`);
    if (URL_FIELDS.includes(k) && typeof v === "string" && v && !/^https?:\/\//.test(v)) errors.push(`${k} must start with http:// or https:// (collectory rejects it, #306)`);
    if (v === null && k === "name") errors.push("name cannot be cleared");
  }
  if (entity === "dataResource") {
    const status = input["status"];
    if (typeof status === "string" && !DR_STATUS.includes(status)) errors.push(`status must be one of ${DR_STATUS.join(", ")}`);
    const type = input["resourceType"];
    if (typeof type === "string" && !DR_TYPES.includes(type)) errors.push(`resourceType must be one of ${DR_TYPES.join(", ")}`);
    if ("connectionParameters" in input) {
      const cp = input["connectionParameters"];
      if (cp !== null && (typeof cp !== "object" || Array.isArray(cp))) errors.push("connectionParameters must be an object such as {protocol, url, termsForUniqueKey}; use collectory_set_connection_parameters to change part of it");
    }
    for (const k of ["defaultDarwinCoreValues", "imageMetadata"]) {
      const v = input[k];
      if (v !== undefined && v !== null && (typeof v !== "object" || Array.isArray(v) || Object.values(v as object).some((x) => typeof x !== "string"))) errors.push(`${k} must be a flat object of strings, e.g. {"basisOfRecord": "PreservedSpecimen"}`);
    }
    for (const k of ["lastChecked", "dataCurrency"]) {
      const v = input[k];
      if (typeof v === "string" && v !== "now" && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(v)) errors.push(`${k} must be "now" or yyyy-MM-ddTHH:mm:ss`);
    }
    for (const k of ["dataProvider", "institution"]) {
      const v = input[k] as { uid?: unknown } | undefined;
      if (v !== undefined && (typeof v !== "object" || v === null || typeof v.uid !== "string")) errors.push(`${k} must be {uid: "…"}`);
    }
  }
  if (entity === "collection" && "institution" in input) {
    const v = input["institution"] as { uid?: unknown } | undefined;
    if (typeof v !== "object" || v === null || typeof v.uid !== "string") errors.push('institution must be {uid: "in…"}');
  }
  if (entity === "collection" && "recordsMapping" in input) errors.push("recordsMapping replaces every code of the collection: use collectory_set_code_mapping, which merges and checks for conflicts");
  if ("attributions" in input && typeof input["attributions"] === "string" && !/^(at\d+\s*)*$/.test(input["attributions"] as string)) errors.push('attributions is a space-separated list of attribution uids, e.g. "at1 at3"');
  if (errors.length) throw new Error(errors.join("; "));

  const body: Record<string, unknown> = {};
  const changes: FieldChange[] = [];
  // The web service rejects a new collection without its bounding coordinates (not nullable); the admin UI sends -1
  // ("no information") for the ones left empty, so do the same.
  if (!current && entity === "collection") {
    const missing = ["eastCoordinate", "westCoordinate", "northCoordinate", "southCoordinate"].filter((k) => input[k] === undefined || input[k] === null);
    for (const k of missing) body[k] = -1;
    if (missing.length) warnings.push(`${missing.join(", ")} set to -1 (no information), as the admin UI does`);
  }
  for (const [k, v] of Object.entries(input)) {
    const value = entity === "dataHub" && k === "memberDataResources" && Array.isArray(v) ? JSON.stringify(v) : v;
    body[k] = value;
    const from = current?.[k];
    if (!current || !same(from, v)) changes.push({ field: k, from: current ? from ?? null : undefined, to: v });
    if (current && v === null && from !== undefined && from !== null) warnings.push(`${k} will be cleared`);
  }
  if (current && !changes.length) warnings.push("nothing changes: every value is already set");
  return { body, changes, warnings };
}

/** Loose equality for JSON values (the web service returns some numbers as strings and JSON fields as objects). */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || a === null || b === undefined || b === null) return (a ?? null) === (b ?? null);
  if (typeof a === "object" || typeof b === "object") return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
  return String(a) === String(b);
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

/** Protocols that load records (and so need termsForUniqueKey: without them every reload makes new record ids). */
export const RECORD_PROTOCOLS = ["DwCA", "DwC", "AutoFeed", "CustomWebservice", "DIGIR", "TAPIR", "BioCASe"];

export interface ConnectionParameters {
  protocol?: string;
  url?: string | string[];
  termsForUniqueKey?: string[];
  [k: string]: unknown;
}

/**
 * Checks of a data resource's connection parameters that collectory does not make: the loaders depend on them
 * (#207, #208, #307: unique terms or the incremental flag lost on save made reloads create duplicate records).
 */
export function checkConnectionParameters(cp: ConnectionParameters, resourceType?: string): string[] {
  const problems: string[] = [];
  if (!cp.protocol) problems.push("no protocol");
  const records = !resourceType || resourceType === "records";
  if (records && cp.protocol && RECORD_PROTOCOLS.includes(cp.protocol)) {
    const t = cp.termsForUniqueKey;
    if (!Array.isArray(t) || !t.length) problems.push("termsForUniqueKey is empty: every reload would create new record ids (duplicates)");
    else if (t.some((x) => typeof x !== "string" || !x.trim())) problems.push("termsForUniqueKey has empty terms");
    else if (new Set(t).size !== t.length) problems.push("termsForUniqueKey repeats a term");
    if (!cp.url || (Array.isArray(cp.url) && !cp.url.length)) problems.push("no url to load the data from");
  }
  if (typeof cp.url === "string" && cp.url && !/^(https?|ftp|file|sftp):\/\//.test(cp.url)) problems.push(`url "${cp.url}" is not an http(s)/ftp/file URL`);
  return problems;
}
