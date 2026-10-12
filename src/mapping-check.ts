import { entityOf, type CollectoryClient } from "./collectory-client.ts";

type Json = Record<string, unknown>;

/**
 * Checks of the Data mappings wiki page for data resources, as pipelines attributes records:
 * ALAAttributionInterpreter looks up every record that has a collectionCode (after ALADefaultValuesTransform has
 * filled the data resource's default values where the record has none) in /ws/lookup/inst/{i}/coll/{c}, and takes
 * collectionUid and institutionUid from the match only. Record consumers do not take part (they did in biocache-store);
 * collectory uses them to list a resource on its collection and institution pages.
 */
export interface PairCheck {
  institutionCode: string | null;
  collectionCode: string | null;
  records?: number;
  resolvesTo?: string | null;
  verdict: "ok" | "unmapped" | "institution-only" | "reindex" | "no-collection-code" | "no-institution-code";
  withoutCollectionUid?: number;
  note?: string;
}

const MAX_CODES = 50;
const quote = (v: string) => `"${v.replace(/(["\\])/g, "\\$1")}"`;

export class MappingCheck {
  /** Lookups of this check, shared across its resources (the lookup is case-insensitive). */
  private lookups = new Map<string, Promise<Json>>();

  constructor(
    readonly client: CollectoryClient,
    readonly gbifApi: string,
    readonly biocacheApi?: string,
  ) {}

  /** Data resources whose indexed records have a collectionCode but no collectionUid (needs the index). */
  async gaps(limit = 20) {
    if (!this.biocacheApi) throw new Error("set COLLECTORY_BIOCACHE_URL (biocache-service, e.g. https://biocache-ws.ala.org.au/ws) to read the index, or pass the uids of the data resources to check");
    const f = await this.facet(["collectionCode:* AND -collectionUid:*"], [], "dataResourceUid", limit);
    return {
      resources: f.values.map((v) => ({ uid: v.fq.match(/"(dr\d+)"/)?.[1] ?? v.label, name: v.label, recordsWithCodesButNoCollection: v.count })),
      note: "records whose collectionCode resolved to no collection when they were last processed; observation datasets with a collectionCode and nothing to map appear too. collectory_mapping_check {uids} tells, per code pair, whether a mapping is missing or only a reprocess is",
    };
  }

  async check(uid: string) {
    if (entityOf(uid) !== "dataResource") throw new Error(`${uid} is not a data resource (dr…)`);
    const dr = await this.client.get<Json>(uid, "dataResource");
    const problems: string[] = [];
    const warnings: string[] = [];
    const suggestions: string[] = [];
    const consumers = ((dr["linkedRecordConsumers"] as Array<{ uid: string; name?: string }> | undefined) ?? []).map((c) => c.uid);
    const defaults = parseObject(dr["defaultDarwinCoreValues"]);

    const found = await this.codesInData(dr);
    const pairs: PairCheck[] = [];
    for (const p of found.pairs) {
      if (!p.collectionCode) {
        const def = defaults["collectionCode"];
        pairs.push({ ...p, verdict: "no-collection-code", note: def ? `records get the default collectionCode "${def}" when processed` : "pipelines only looks records up by collectionCode: these get no collection or institution" });
        continue;
      }
      if (!p.institutionCode) {
        pairs.push({ ...p, verdict: "no-institution-code", note: "collectory's lookup needs both codes" });
        continue;
      }
      const m = await this.lookup(p.institutionCode, p.collectionCode);
      const to = (m["uid"] as string | undefined) ?? null;
      if (!to) pairs.push({ ...p, resolvesTo: null, verdict: "unmapped" });
      else if (entityOf(to) === "institution") pairs.push({ ...p, resolvesTo: to, verdict: "institution-only", note: "a provider map without a collection takes this pair: records get no collectionUid" });
      else if (p.withoutCollectionUid) pairs.push({ ...p, resolvesTo: to, verdict: "reindex", note: "the mapping exists now; these records were processed before it" });
      else pairs.push({ ...p, resolvesTo: to, verdict: "ok", ...(m["institutionUid"] ? {} : { note: `${to} has no institution: its records get no institutionUid` }) });
    }

    const unmapped = pairs.filter((p) => p.verdict === "unmapped");
    if (unmapped.length) problems.push(`${unmapped.length} code pairs resolve to no collection: map them with collectory_set_code_mapping (${unmapped.slice(0, 5).map((p) => `${p.institutionCode}/${p.collectionCode}`).join(", ")}${unmapped.length > 5 ? "…" : ""})`);
    const shadowed = pairs.filter((p) => p.verdict === "institution-only");
    if (shadowed.length) problems.push(`${shadowed.length} code pairs resolve to an institution through a provider map without a collection (see collectory_audit)`);
    const noColl = pairs.find((p) => p.verdict === "no-collection-code");
    if (noColl && !defaults["collectionCode"]) suggestions.push(`${noColl.records ?? "some"} records have no collectionCode: set one in the resource's defaultDarwinCoreValues (collectory_save_entity), which pipelines applies before attribution to records without it (wiki: "In case don't have collectionCode")`);
    if (pairs.some((p) => p.verdict === "reindex")) suggestions.push(`reprocess and reindex ${uid}: records of mapped pairs have no collection yet`);
    const orphan = pairs.filter((p) => p.verdict === "ok" && p.note);
    for (const p of orphan) warnings.push(p.note!);

    const targets = [...new Set(pairs.filter((p) => p.resolvesTo && entityOf(p.resolvesTo) === "collection").map((p) => p.resolvesTo!))];
    const missingConsumers = targets.filter((t) => !consumers.includes(t));
    if (missingConsumers.length) warnings.push(`${missingConsumers.join(", ")} receive records but are not record consumers of ${uid}: their collection pages will not list it (wiki step 4: collectory_set_record_consumers)`);
    if (found.source !== "none" && found.pairs.length && !consumers.length) warnings.push(`${uid} has no record consumers (wiki step 4)`);
    const stale = consumers.filter((c) => entityOf(c) === "collection" && found.source !== "none" && targets.length && !targets.includes(c));
    if (stale.length) warnings.push(`record consumers no code pair of the data resolves to: ${stale.join(", ")}`);

    return {
      uid,
      name: dr["name"],
      codesFrom: found.source,
      ...(found.records !== undefined ? { records: found.records } : {}),
      ...(found.note ? { note: found.note } : {}),
      consumers,
      ...(Object.keys(defaults).length ? { defaultDarwinCoreValues: defaults } : {}),
      pairs,
      problems,
      warnings,
      suggestions,
    };
  }

  /** The institutionCode/collectionCode pairs that occur in the resource's records, with counts. */
  private async codesInData(dr: Json): Promise<{ source: "index" | "gbif" | "none"; pairs: Array<Omit<PairCheck, "verdict">>; records?: number; note?: string }> {
    const uid = String(dr["uid"]);
    if (this.biocacheApi) {
      const fq = [`dataResourceUid:${quote(uid)}`];
      const inst = await this.facet(["*:*"], fq, "institutionCode", MAX_CODES);
      if (inst.total) {
        const pairs: Array<Omit<PairCheck, "verdict">> = [];
        for (const i of inst.values) {
          const ifq = i.missing ? "-institutionCode:*" : `institutionCode:${quote(i.label)}`;
          const coll = await this.facet(["*:*"], [...fq, ifq], "collectionCode", MAX_CODES);
          for (const c of coll.values) {
            const pair = { institutionCode: i.missing ? null : i.label, collectionCode: c.missing ? null : c.label, records: c.count };
            if (pair.institutionCode && pair.collectionCode) {
              const unresolved = await this.facet(["*:*"], [...fq, ifq, `collectionCode:${quote(c.label)}`, "-collectionUid:*"], "dataResourceUid", 1);
              pairs.push({ ...pair, withoutCollectionUid: unresolved.total });
            } else pairs.push(pair);
          }
        }
        return { source: "index", pairs, records: inst.total, note: "codes as the index holds them since the last processing" };
      }
    }
    const key = dr["guid"] as string | undefined;
    if (key && /^[0-9a-f-]{36}$/i.test(key)) {
      const base = `${this.gbifApi}/occurrence/search?datasetKey=${key}&limit=0`;
      const all = JSON.parse(await this.client.external(`${base}&facet=institutionCode&facetLimit=${MAX_CODES}`)) as GbifSearch;
      if (all.count) {
        const pairs: Array<Omit<PairCheck, "verdict">> = [];
        for (const i of facetOf(all, "INSTITUTION_CODE")) {
          const r = JSON.parse(await this.client.external(`${base}&institutionCode=${encodeURIComponent(i.name)}&facet=collectionCode&facetLimit=${MAX_CODES}`)) as GbifSearch;
          const cs = facetOf(r, "COLLECTION_CODE");
          for (const c of cs) pairs.push({ institutionCode: i.name, collectionCode: c.name, records: c.count });
          const without = r.count - cs.reduce((n, c) => n + c.count, 0);
          if (without > 0) pairs.push({ institutionCode: i.name, collectionCode: null, records: without });
        }
        const withoutInst = all.count - facetOf(all, "INSTITUTION_CODE").reduce((n, c) => n + c.count, 0);
        if (withoutInst > 0) pairs.push({ institutionCode: null, collectionCode: null, records: withoutInst });
        return { source: "gbif", pairs, records: all.count, note: "codes of the dataset in GBIF: what the data holds, not how this portal attributed it (set COLLECTORY_BIOCACHE_URL for that)" };
      }
    }
    return { source: "none", pairs: [], note: "the codes in the data are unknown: set COLLECTORY_BIOCACHE_URL to read them from the index, or check the archive (wiki step 1)" };
  }

  private lookup(i: string, c: string): Promise<Json> {
    const k = `${i.toLowerCase()}\u0000${c.toLowerCase()}`;
    if (!this.lookups.has(k)) this.lookups.set(k, this.client.lookupCodes(i, c).then((r) => r as Json, () => ({})));
    return this.lookups.get(k)!;
  }

  private async facet(q: string[], fq: string[], field: string, limit: number) {
    const u = new URL(`${this.biocacheApi}/occurrences/search`);
    u.searchParams.set("q", q.join(" AND "));
    for (const f of fq) u.searchParams.append("fq", f);
    u.searchParams.set("facets", field);
    u.searchParams.set("flimit", String(limit));
    u.searchParams.set("pageSize", "0");
    const r = JSON.parse(await this.client.external(u.toString())) as { totalRecords?: number; facetResults?: Array<{ fieldName: string; fieldResult: Array<{ label: string; count: number; fq?: string }> }> };
    const values = (r.facetResults?.find((f) => f.fieldName === field)?.fieldResult ?? []).map((v) => ({ label: v.label, count: v.count, fq: v.fq ?? "", missing: (v.fq ?? "").startsWith("-") }));
    return { total: r.totalRecords ?? 0, values };
  }
}

interface GbifSearch {
  count: number;
  facets?: Array<{ field: string; counts: Array<{ name: string; count: number }> }>;
}

const facetOf = (r: GbifSearch, field: string) => r.facets?.find((f) => f.field === field)?.counts ?? [];

function parseObject(v: unknown): Record<string, string> {
  if (v && typeof v === "object") return v as Record<string, string>;
  if (typeof v === "string" && v.trim()) {
    try {
      return JSON.parse(v) as Record<string, string>;
    } catch {
      return {};
    }
  }
  return {};
}
