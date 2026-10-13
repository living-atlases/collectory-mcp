import * as cheerio from "cheerio";
import { CollectoryClient, CollectoryError, entityOf, ENTITIES, type Entity } from "./collectory-client.ts";
import { checkConnectionParameters, planEntityWrite, same, type ConnectionParameters, type FieldChange } from "./entities.ts";
import { fill, findForm, htmlTable, pageMessages } from "./forms.ts";

type Json = Record<string, unknown>;
type Ref = { uid: string; name?: string };

const uidsOf = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : String((x as Ref).uid))).filter(Boolean) : []);
const uniq = <T>(a: T[]) => [...new Set(a)];

const applyDelta = (current: string[], add: string[] = [], remove: string[] = []) => uniq([...current.filter((x) => !remove.includes(x)), ...add]);

export interface Delta {
  add?: string[];
  remove?: string[];
}

/** Multi-step operations on top of the client: previews, safety checks, and verification after each write. */
export class Workflows {
  constructor(
    readonly client: CollectoryClient,
    readonly gbifApi = "https://api.gbif.org/v1",
  ) {}

  // ---------------- entities ----------------

  async previewEntity(target: { uid?: string; entity?: Entity }, fields: Json) {
    const entity = target.uid ? entityOf(target.uid) : target.entity;
    if (!entity) throw new Error("give the uid of the entity to update, or the entity type to create");
    const current = target.uid ? await this.client.get<Json>(target.uid, entity) : undefined;
    const plan = planEntityWrite(entity, current, fields);
    if (entity === "dataResource" && "connectionParameters" in fields && current && plan.body["connectionParameters"]) {
      const problems = checkConnectionParameters(plan.body["connectionParameters"] as ConnectionParameters, (fields["resourceType"] ?? current["resourceType"]) as string);
      if (problems.length) plan.warnings.push(...problems.map((p) => `connectionParameters: ${p}`));
    }
    return { entity, uid: target.uid, action: target.uid ? "update" : "create", changes: plan.changes, warnings: plan.warnings, body: plan.body };
  }

  async saveEntity(target: { uid?: string; entity?: Entity }, fields: Json) {
    const p = await this.previewEntity(target, fields);
    const res = await this.client.save(p.entity, p.uid, p.body);
    const uid = p.uid ?? res.uid;
    if (!uid) return { ...res, warning: "collectory did not return the new uid (no Location header): look it up with collectory_list" };
    const after = await this.client.get<Json>(uid, p.entity);
    // Scalars collectory echoes back must now read as sent (objects come back reshaped, so they are not compared).
    const notApplied = p.changes.filter((c) => c.to !== null && typeof c.to !== "object" && c.field in after && !same(after[c.field], c.to));
    return { uid, entity: p.entity, action: p.action, status: res.status, message: res.message, changes: p.changes, ...(notApplied.length ? { notApplied: notApplied.map((c) => ({ field: c.field, sent: c.to, now: after[c.field] ?? null })), hint: "collectory answered OK but these values did not stick; check them in the admin UI" } : {}) };
  }

  /** What depends on an entity, so a delete does not leave hubs, mappings or resources pointing at nothing. */
  async dependencies(uid: string) {
    const e = entityOf(uid);
    const pg = await this.client.get<Json>(uid, e);
    const deps: Record<string, unknown> = {};
    // Not pg.hubMembership: collectory builds it from a cached hub list that hub edits never evict (stale).
    const hubs = await this.hubsContaining(uid);
    if (hubs.length) deps["hubs"] = hubs;
    if (e === "institution" && Array.isArray(pg["collections"]) && pg["collections"].length) deps["collections"] = pg["collections"];
    if (e === "dataProvider" && Array.isArray(pg["dataResources"]) && pg["dataResources"].length) deps["dataResources"] = pg["dataResources"];
    if (Array.isArray(pg["linkedRecordProviders"]) && pg["linkedRecordProviders"].length) deps["recordProviders"] = pg["linkedRecordProviders"];
    if (Array.isArray(pg["linkedRecordConsumers"]) && pg["linkedRecordConsumers"].length) deps["recordConsumers"] = pg["linkedRecordConsumers"];
    if (e === "collection" && pg["recordsProviderMapping"]) deps["codeMapping"] = pg["recordsProviderMapping"];
    if (e === "dataHub") {
      const members = ["memberInstitutions", "memberCollections", "memberDataResources"].flatMap((k) => uidsOf(pg[k]));
      if (members.length) deps["members"] = members;
    }
    return { uid, entity: e, name: pg["name"], dependencies: deps, safe: Object.keys(deps).length === 0 };
  }

  async deleteEntity(uid: string, force: boolean) {
    const d = await this.dependencies(uid);
    if (!d.safe && !force) throw new Error(`${uid} is still referenced (${Object.keys(d.dependencies).join(", ")}): remove those links first, or pass force:true if the user accepts leaving them dangling`);
    const message = await this.client.delete(uid);
    // collectory can answer before the delete is committed: look again for a few seconds before calling it a failure.
    let gone = false;
    for (const wait of [0, 250, 1000, 2000]) {
      await new Promise((r) => setTimeout(r, wait));
      gone = await this.client.get(uid).then(
        () => false,
        (e) => e instanceof CollectoryError && (e.status === 404 || e.status === 500),
      );
      if (gone) break;
    }
    return { uid, deleted: gone, message: message.trim(), ...(gone ? {} : { warning: "collectory answered but the entity is still there (in 5.x the delete did not flush, #287)" }), ...(d.safe ? {} : { leftDangling: d.dependencies }) };
  }

  /** Hubs that list a uid among their members, read from each hub (fresh, unlike an entity's hubMembership). */
  async hubsContaining(uid: string): Promise<Ref[]> {
    const out: Ref[] = [];
    for (const h of await this.client.list("dataHub")) {
      const hub = await this.client.get<Json>(h.uid, "dataHub").catch(() => undefined);
      if (hub && ["memberDataResources", "memberInstitutions", "memberCollections"].some((k) => uidsOf(hub[k]).includes(uid))) out.push({ uid: h.uid, name: h.name });
    }
    return out;
  }

  // ---------------- code mapping (institutionCode/collectionCode -> collection) ----------------

  async planCodeMapping(collectionUid: string, o: { institutionCodes?: Delta; collectionCodes?: Delta; exact?: boolean; matchAnyCollectionCode?: boolean; warning?: string }) {
    if (entityOf(collectionUid) !== "collection") throw new Error("code mappings belong to a collection (co…)");
    const co = await this.client.get<Json>(collectionUid, "collection");
    const cur = (co["recordsProviderMapping"] as Json | undefined) ?? {};
    const curInst = (cur["institutionCodes"] as string[] | undefined) ?? [];
    const curColl = (cur["collectionCodes"] as string[] | undefined) ?? [];
    const inst = applyDelta(curInst, o.institutionCodes?.add, o.institutionCodes?.remove);
    const coll = applyDelta(curColl, o.collectionCodes?.add, o.collectionCodes?.remove);
    const matchAny = o.matchAnyCollectionCode ?? (cur["matchAnyCollectionCode"] as boolean | undefined) ?? false;
    const errors: string[] = [];
    if (!inst.length) errors.push("a mapping needs at least one institution code");
    if (!coll.length && !matchAny) errors.push("a mapping needs at least one collection code, or matchAnyCollectionCode:true");
    for (const c of [...inst, ...coll]) if (!c.trim() || c.length > 200) errors.push(`bad code "${c}"`);
    if (errors.length) throw new Error(errors.join("; "));

    // A pair matched by two maps makes lookups ambiguous: collectory takes whichever the database returns first
    // (#206, #214). The maps come from the collections themselves, not /ws/codeMapDump, which leaves out maps that
    // match any collection code and have none listed.
    const { maps, unchecked, note } = await this.codeMappings();
    const conflicts = maps.filter((m) => m.uid !== collectionUid).flatMap((m) => overlap({ institutionCodes: inst, collectionCodes: coll, matchAny }, m).map((p) => ({ ...p, alreadyMappedTo: `${m.uid} ${m.name ?? ""}`.trim() + (m.withoutCollection ? ` (provider map ${m.providerMapId} without a collection)` : "") })));
    const mapping: Json = { institutionCodes: inst, collectionCodes: coll, exact: o.exact ?? cur["exact"] ?? false, matchAnyCollectionCode: matchAny };
    const warning = o.warning ?? (cur["warning"] as string | undefined);
    if (warning) mapping["warning"] = warning;
    return {
      collection: { uid: collectionUid, name: co["name"] },
      before: cur["institutionCodes"] ? { institutionCodes: curInst, collectionCodes: curColl, exact: cur["exact"], matchAnyCollectionCode: cur["matchAnyCollectionCode"], warning: cur["warning"] } : null,
      after: mapping,
      conflicts,
      ...(unchecked ? { unchecked } : {}),
      ...(note ? { note } : {}),
      reindex: "records already loaded keep their old collection until their data resources are reprocessed and reindexed",
    };
  }

  async setCodeMapping(collectionUid: string, o: Parameters<Workflows["planCodeMapping"]>[1], allowConflicts: boolean) {
    const plan = await this.planCodeMapping(collectionUid, o);
    if (plan.conflicts.length && !allowConflicts) throw new Error(`these code pairs are already mapped elsewhere: ${plan.conflicts.map((c) => `${c.institutionCode}/${c.collectionCode} -> ${c.alreadyMappedTo}`).join("; ")}. Fix the other mapping first, or pass allowConflicts:true`);
    if (plan.unchecked && !allowConflicts) throw new Error(`cannot check every mapping for conflicts: ${plan.unchecked}. Pass allowConflicts:true to save anyway`);
    await this.client.save("collection", collectionUid, { recordsMapping: plan.after });
    const inst = plan.after["institutionCodes"] as string[];
    const coll = plan.after["collectionCodes"] as string[];
    const checks = [];
    for (const i of inst.slice(0, 5)) for (const c of (coll.length ? coll : ["*"]).slice(0, 5)) {
      const r = await this.client.lookupCodes(i, c).catch((e: Error) => ({ error: e.message }));
      const to = (r as Json)["uid"] as string | undefined;
      checks.push({ institutionCode: i, collectionCode: c, resolvesTo: to ?? (r as Json)["error"] ?? null, ok: to === collectionUid, ...(to && entityOf(to) === "institution" ? { problem: `resolves to institution ${to}: a provider map without a collection takes this pair` } : {}) });
    }
    return { ...plan, saved: true, lookups: checks, verified: checks.every((c) => c.ok) };
  }

  // ---------------- data hubs ----------------

  async planHubMembers(hubUid: string, o: { dataResources?: Delta; institutions?: Delta; collections?: Delta }) {
    if (entityOf(hubUid) !== "dataHub") throw new Error("hub members belong to a data hub (dh…)");
    const hub = await this.client.get<Json>(hubUid, "dataHub");
    const cur = { dataResources: uidsOf(hub["memberDataResources"]), institutions: uidsOf(hub["memberInstitutions"]), collections: uidsOf(hub["memberCollections"]) };
    const next = {
      dataResources: applyDelta(cur.dataResources, o.dataResources?.add, o.dataResources?.remove),
      institutions: applyDelta(cur.institutions, o.institutions?.add, o.institutions?.remove),
      collections: applyDelta(cur.collections, o.collections?.add, o.collections?.remove),
    };
    const prefixes = { dataResources: "dr", institutions: "in", collections: "co" } as const;
    const errors: string[] = [];
    for (const k of Object.keys(prefixes) as Array<keyof typeof prefixes>) for (const u of [...(o[k]?.add ?? [])]) if (!new RegExp(`^${prefixes[k]}\\d+$`).test(u)) errors.push(`${u} is not a ${k.slice(0, -1)} uid`);
    if (errors.length) throw new Error(errors.join("; "));
    const missing: string[] = [];
    for (const u of [...(o.dataResources?.add ?? []), ...(o.institutions?.add ?? []), ...(o.collections?.add ?? [])]) {
      await this.client.get(u).catch(() => missing.push(u));
    }
    const changed = (k: keyof typeof cur) => !same([...cur[k]].sort(), [...next[k]].sort());
    const needsForm = changed("institutions") || changed("collections");
    // Records carry the hub uid from indexing: what joins or leaves must be reprocessed and reindexed.
    const touched = uniq([...(o.dataResources?.add ?? []), ...(o.dataResources?.remove ?? [])].filter((u) => cur.dataResources.includes(u) !== next.dataResources.includes(u)));
    for (const u of [...(o.institutions?.add ?? []), ...(o.institutions?.remove ?? []), ...(o.collections?.add ?? []), ...(o.collections?.remove ?? [])]) {
      const pg = await this.client.get<Json>(u).catch(() => undefined);
      for (const p of uidsOf(pg?.["linkedRecordProviders"])) if (p.startsWith("dr")) touched.push(p);
    }
    return {
      hub: { uid: hubUid, name: hub["name"] },
      before: cur,
      after: next,
      via: needsForm ? "admin form (institutions and collections have no web service): needs COLLECTORY_USERNAME" : "web service",
      ...(missing.length ? { missing } : {}),
      reindex: uniq(touched),
    };
  }

  async setHubMembers(hubUid: string, o: Parameters<Workflows["planHubMembers"]>[1]) {
    const plan = await this.planHubMembers(hubUid, o);
    if (plan.missing?.length) throw new Error(`these uids do not exist: ${plan.missing.join(", ")}`);
    if (plan.via.startsWith("web service")) {
      await this.client.save("dataHub", hubUid, { memberDataResources: JSON.stringify(plan.after.dataResources) });
    } else {
      const { url, html } = await this.client.page(`/dataHub/edit/${hubUid}?page=/dataHub/members`);
      const form = findForm(html, url, { submit: "_action_updateDescription", hasField: "memberInstitutions" });
      const body = fill(form, { memberInstitutions: JSON.stringify(plan.after.institutions), memberCollections: JSON.stringify(plan.after.collections), memberDataResources: JSON.stringify(plan.after.dataResources) }, "_action_updateDescription");
      const res = await this.client.submit(form.action, body);
      const { errors } = pageMessages(res.html);
      if (errors.length) throw new Error(`collectory refused the change: ${errors.join("; ")}`);
    }
    const hub = await this.client.get<Json>(hubUid, "dataHub");
    const now = { dataResources: uidsOf(hub["memberDataResources"]), institutions: uidsOf(hub["memberInstitutions"]), collections: uidsOf(hub["memberCollections"]) };
    const verified = (Object.keys(now) as Array<keyof typeof now>).every((k) => same([...now[k]].sort(), [...plan.after[k]].sort()));
    return { ...plan, saved: true, verified, now, next: plan.reindex.length ? `reprocess and reindex ${plan.reindex.join(", ")} (pipelines/biocache) so their records show in the hub` : undefined };
  }

  // ---------------- record consumers (data resource/provider -> institutions, collections) ----------------

  async setRecordConsumers(uid: string, source: "co" | "in", delta: Delta, apply: boolean) {
    const e = entityOf(uid);
    if (e !== "dataResource" && e !== "dataProvider") throw new Error("record consumers are set on a data resource (dr…) or data provider (dp…)");
    const pg = await this.client.get<Json>(uid, e);
    const cur = uidsOf(pg["linkedRecordConsumers"]).filter((u) => u.startsWith(source));
    for (const u of delta.add ?? []) if (!u.startsWith(source)) throw new Error(`${u} is not a ${source === "co" ? "collection" : "institution"} uid (source "${source}")`);
    const next = applyDelta(cur, delta.add, delta.remove);
    const plan = { uid, name: pg["name"], source, before: cur, after: next, reindex: e === "dataResource" ? [uid] : uidsOf(pg["dataResources"]) };
    if (!apply) return plan;
    const { url, html } = await this.client.page(`/${e}/editConsumers/${uid}?source=${source}`);
    const form = findForm(html, url, { submit: "_action_updateConsumers", hasField: "consumers" });
    await this.client.submit(form.action, fill(form, { consumers: next.join(",") }, "_action_updateConsumers"));
    const after = uidsOf((await this.client.get<Json>(uid, e))["linkedRecordConsumers"]).filter((u) => u.startsWith(source));
    return { ...plan, saved: true, verified: same([...after].sort(), [...next].sort()), now: after, next: "reprocess and reindex the listed data resources so their records get the new institution/collection" };
  }

  // ---------------- connection parameters ----------------

  async planConnectionParameters(drUid: string, o: { set?: Json; unset?: string[]; replace?: Json }) {
    if (entityOf(drUid) !== "dataResource") throw new Error("connection parameters belong to a data resource (dr…)");
    const dr = await this.client.get<Json>(drUid, "dataResource");
    const cur = (dr["connectionParameters"] as ConnectionParameters | undefined) ?? undefined;
    // Without admin rights collectory leaves the url out of the answer: writing that back would erase it.
    if (cur && !("url" in cur) && !o.replace?.["url"] && !o.set?.["url"]) {
      throw new Error(`collectory did not return the url of ${drUid}'s connection parameters (it hides it from callers without ROLE_ADMIN or the ${"ala/internal"} scope), so a change would erase it. Configure credentials with that access (see collectory_health), or pass the url explicitly`);
    }
    const next: ConnectionParameters = o.replace ? { ...o.replace } : { ...(cur ?? {}), ...(o.set ?? {}) };
    for (const k of o.unset ?? []) delete next[k];
    if (typeof next.termsForUniqueKey === "string") next.termsForUniqueKey = (next.termsForUniqueKey as string).split(/\s*,\s*/).filter(Boolean);
    const problems = checkConnectionParameters(next, dr["resourceType"] as string | undefined);
    const lost = cur ? Object.keys(cur).filter((k) => !(k in next)) : [];
    const changes: FieldChange[] = uniq([...Object.keys(cur ?? {}), ...Object.keys(next)])
      .filter((k) => !same(cur?.[k], next[k]))
      .map((k) => ({ field: k, from: cur?.[k] ?? null, to: next[k] ?? null }));
    return { uid: drUid, name: dr["name"], before: cur ?? null, after: next, changes, problems, ...(lost.length ? { removed: lost } : {}) };
  }

  async setConnectionParameters(drUid: string, o: Parameters<Workflows["planConnectionParameters"]>[1], acceptProblems: boolean) {
    const plan = await this.planConnectionParameters(drUid, o);
    if (plan.problems.length && !acceptProblems) throw new Error(`refusing to save: ${plan.problems.join("; ")} (pass acceptProblems:true only if the user knows why)`);
    if (!plan.changes.length) return { ...plan, saved: false, message: "nothing changes" };
    await this.client.save("dataResource", drUid, { connectionParameters: plan.after });
    const now = (await this.client.get<Json>(drUid, "dataResource"))["connectionParameters"] as Json | undefined;
    const lostNow = Object.keys(plan.after).filter((k) => k !== "url" && !same(now?.[k], plan.after[k]));
    return { ...plan, saved: true, verified: lostNow.length === 0, ...(lostNow.length ? { notApplied: lostNow } : {}) };
  }

  // ---------------- IPT ----------------

  /** What an IPT scan of a data provider would do, computed here: collectory's scan writes as soon as it runs. */
  async iptPreview(dpUid: string) {
    if (entityOf(dpUid) !== "dataProvider") throw new Error("IPT scans run on a data provider (dp…) whose website URL is the IPT");
    const dp = await this.client.get<Json>(dpUid, "dataProvider");
    const base = String(dp["websiteUrl"] ?? "");
    if (!/^https?:\/\//.test(base)) throw new Error(`${dpUid} has no website URL pointing to an IPT (set websiteUrl to e.g. https://ipt.example.org/ipt)`);
    const rssUrl = new URL("rss.do", base.endsWith("/") ? base : base + "/").toString();
    const items = parseIptRss(await this.client.external(rssUrl, "application/rss+xml, application/xml, text/xml"));
    const drs = await this.resources(uidsOf(dp["dataResources"]));
    const byUrl = new Map(drs.map((d) => [String(d["websiteUrl"] ?? ""), d]));
    const norm = (u: string) => u.replace(/^https?:\/\//, "").replace(/\/+$/, "").toLowerCase();
    const byNorm = new Map(drs.map((d) => [norm(String(d["websiteUrl"] ?? "")), d]));
    const updated = [];
    const created = [];
    const nearMisses = [];
    for (const it of items) {
      const dr = byUrl.get(it.link);
      if (dr) {
        const changes = [
          ["name", dr["name"], it.title],
          ["pubDescription", dr["pubDescription"], it.description],
          ["gbifRegistryKey", dr["gbifRegistryKey"], it.gbifKey ?? null],
        ]
          .filter(([, a, b]) => !same(a, b))
          .map(([field, from, to]) => ({ field, from: from ?? null, to: to ?? null }));
        const newer = !dr["dataCurrency"] || !it.pubDate || new Date(it.pubDate) > new Date(String(dr["dataCurrency"]));
        updated.push({ uid: dr["uid"], name: dr["name"], dataChanged: newer, metadataChanges: changes });
      } else {
        const near = byNorm.get(norm(it.link));
        if (near) nearMisses.push({ ipt: it.link, collectory: near["websiteUrl"], uid: near["uid"], problem: "same dataset, different URL spelling: the scan will not match them and would create a duplicate" });
        created.push({ title: it.title, link: it.link, dwca: it.dwca ?? null });
      }
    }
    const linked = new Set(items.map((i) => i.link));
    const notInIpt = drs.filter((d) => !linked.has(String(d["websiteUrl"] ?? ""))).map((d) => ({ uid: d["uid"], name: d["name"], websiteUrl: d["websiteUrl"] ?? null }));
    return {
      provider: { uid: dpUid, name: dp["name"], ipt: base },
      datasetsInIpt: items.length,
      updated,
      new: created,
      ...(nearMisses.length ? { nearMisses } : {}),
      notInIpt,
      note: (await this.client.version().catch(() => undefined))?.major === 5 ? "collectory 5.x: a scan without create only reports; with create it rewrites the metadata of matched resources (non-empty values from the IPT) and adds the IPT contacts, and creates new resources. Resources are matched by website URL only." : "the scan always rewrites the EML metadata (name, description, rights, citation, licence, coverage…) and the contacts of every matched resource from the IPT, clearing values the IPT does not have: edits made in collectory are lost. Resources are matched by website URL only.",
    };
  }

  async iptScan(dpUid: string, o: { create?: boolean; key?: string; isShareableWithGBIF?: boolean; check?: boolean }) {
    let updates: unknown[];
    const v = await this.client.version().catch(() => undefined);
    const v5 = !!v && v.major < 6;
    if (o.create && v5) {
      // 5.x: the web service creates, but also checks the role of the login session.
      if (!this.client.hasSession) throw new Error("creating resources from the IPT needs a person's login (COLLECTORY_USERNAME) as well as the token");
      updates = await this.client.iptScan(dpUid, { ...o, withSession: true });
    } else if (o.create) {
      // /ws/ipt/scan refuses create=true since 6.3.0: the provider page's button (a person's session) still creates.
      if (!this.client.hasSession) throw new Error("creating resources from the IPT needs a person's login in collectory 6.3+ (set COLLECTORY_USERNAME); without create the scan only updates existing resources");
      const q = new URLSearchParams({ uid: dpUid, create: "true", format: "json" });
      if (o.key) q.set("key", o.key);
      if (o.isShareableWithGBIF === false) q.set("isShareableWithGBIF", "false");
      if (o.check === false) q.set("check", "false");
      updates = await this.client.json(`/dataProvider/iptScan?${q}`, { user: true });
    } else {
      updates = await this.client.iptScan(dpUid, o);
    }
    const list = (updates as Json[]).map((u) => ({ uid: u["uid"] ?? null, name: u["name"], websiteUrl: u["websiteUrl"] }));
    return { provider: dpUid, toReload: list, ...(v5 && !o.create ? { note: "collectory 5.x only reports without create: nothing was updated; scan with create:true to update existing resources (and create new ones)" } : {}), next: list.length ? "these resources have new data in the IPT: reload them (pipelines: dwca-avro, interpret, index for each uid)" : "nothing new to reload" };
  }

  // ---------------- GBIF ----------------

  /** Which resources of a provider are older than their GBIF dataset (what /ws/gbif/scan would reload). */
  async gbifPreview(dpUid: string) {
    const dp = await this.client.get<Json>(dpUid, "dataProvider");
    const drs = await this.resources(uidsOf(dp["dataResources"]));
    const rows = [];
    for (const dr of drs) {
      const guid = dr["guid"] as string | undefined;
      if (!guid || !/^[0-9a-f-]{36}$/i.test(guid)) {
        rows.push({ uid: dr["uid"], name: dr["name"], status: "NO_GBIF_DATASET", guid: guid ?? null });
        continue;
      }
      const ds = (await this.client.external(`${this.gbifApi}/dataset/${guid}`).then(JSON.parse, () => undefined)) as Json | undefined;
      const published = (ds?.["pubDate"] ?? ds?.["modified"]) as string | undefined;
      const stale = !!published && !!dr["lastUpdated"] && new Date(published) > new Date(String(dr["lastUpdated"]));
      rows.push({ uid: dr["uid"], name: dr["name"], guid, gbifPublished: published ?? null, lastUpdated: dr["lastUpdated"] ?? null, status: ds ? (stale ? "WOULD_RELOAD" : "IN_SYNC") : "NOT_FOUND_IN_GBIF" });
    }
    return { provider: { uid: dpUid, name: dp["name"] }, resources: rows, wouldReload: rows.filter((r) => r.status === "WOULD_RELOAD").map((r) => r.uid) };
  }

  /** Status of an external (GBIF) load started by a scan or a repatriation. */
  async loadStatus(loadGuid: string) {
    const { html } = await this.client.page(`/manage/externalLoadStatus?loadGuid=${encodeURIComponent(loadGuid)}`);
    const $ = cheerio.load(html);
    const title = $("h1").first().text().replace(/\s+/g, " ").trim();
    const percent = Number($("h3").first().text().match(/([\d.]+)\s*%/)?.[1] ?? NaN);
    const resources = $("table tr.prop")
      .toArray()
      .map((tr) => {
        const td = $(tr).find("td");
        const href = $(td[2]).find("a").attr("href");
        return { name: $(td[0]).text().trim(), phase: $(td[1]).text().trim(), phaseCode: ($(td[1]).attr("class") ?? "").split(/\s+/).find((c) => /^[A-Z_]+$/.test(c)) ?? null, uid: href?.match(/\/(dr\d+)/)?.[1] ?? null };
      });
    const finished = /^Finished/i.test(title);
    return { loadGuid, finished, percentComplete: Number.isNaN(percent) ? null : percent, resources, ...(finished ? {} : { next: `call collectory_load_status {loadGuid: "${loadGuid}"} again in a minute or two` }) };
  }

  /** GBIF datasets of a country (or publishing to it) that could be repatriated, as the Repatriation page lists them. */
  async repatriationSearch(o: RepatriationQuery) {
    const review = await this.repatriationReview(o);
    return { query: o, loadGuid: review.loadGuid, candidates: review.candidates };
  }

  async repatriationLoad(o: RepatriationQuery, select: Array<{ guid: string; addResource?: boolean; updateMetadata?: boolean; updateConnection?: boolean }>) {
    const review = await this.repatriationReview(o);
    const byGuid = new Map(review.candidates.map((c) => [c.guid, c]));
    const unknown = select.filter((s) => !byGuid.has(s.guid)).map((s) => s.guid);
    if (unknown.length) throw new Error(`not in the current search results: ${unknown.join(", ")} (run collectory_repatriation_search again with the same query)`);
    // Post only the chosen rows, numbered from 0: rows posted from several result pages made the load fail (#234).
    const keep: Array<[string, string]> = review.form.fields.filter(([n]) => !n.startsWith("resources[") && !n.startsWith("_resources["));
    select.forEach((s, i) => {
      const c = byGuid.get(s.guid)!;
      keep.push([`resources[${i}].uid`, c.uid ?? ""], [`resources[${i}].guid`, c.guid], [`resources[${i}].source`, c.source ?? ""], [`resources[${i}].country`, c.country ?? o.country], [`resources[${i}].name`, c.name]);
      if (s.addResource ?? !c.uid) keep.push([`resources[${i}].addResource`, "on"]);
      if (s.updateMetadata ?? true) keep.push([`resources[${i}].updateMetadata`, "on"]);
      if (s.updateConnection ?? true) keep.push([`resources[${i}].updateConnection`, "on"]);
    });
    await this.client.submit(review.form.action, new URLSearchParams(keep));
    return { loadGuid: review.loadGuid, loading: select.length, next: `poll collectory_load_status {loadGuid: "${review.loadGuid}"} every minute or two` };
  }

  private async repatriationReview(o: RepatriationQuery) {
    const { url, html } = await this.client.page("/manage/repatriate");
    const form = findForm(html, url, { action: /searchForRepatResources$/ });
    const adaptor = [...form.fields].find(([n]) => n === "adaptorString")?.[1];
    const changes: Record<string, string> = { country: o.country, maxNoOfDatasets: String(o.maxDatasets ?? 25) };
    if (o.recordType) changes["recordType"] = o.recordType;
    if (o.dataProviderUid) changes["dataProviderUid"] = o.dataProviderUid;
    if (o.minRecordCount !== undefined) changes["minRecordCount"] = String(o.minRecordCount);
    if (o.maxRecordCount !== undefined) changes["maxRecordCount"] = String(o.maxRecordCount);
    if (adaptor) changes["adaptorString"] = adaptor;
    const res = await this.client.submit(form.action, fill(form, changes));
    const review = findForm(res.html, res.url, { action: /updateFromExternalSources$/ });
    const get = (n: string) => review.fields.find(([k]) => k === n)?.[1];
    const rows = new Map<string, Record<string, string>>();
    for (const [n, v] of review.fields) {
      const m = n.match(/^resources\[(\d+)\]\.(\w+)$/);
      if (m) rows.set(m[1]!, { ...(rows.get(m[1]!) ?? {}), [m[2]!]: v });
    }
    const candidates = [...rows.values()].map((r) => ({ guid: r["guid"] ?? "", name: r["name"] ?? "", uid: r["uid"] || undefined, source: r["source"], country: r["country"], suggested: { addResource: r["addResource"] === "on" || r["addResource"] === "true", updateMetadata: r["updateMetadata"] === "on" || r["updateMetadata"] === "true", updateConnection: r["updateConnection"] === "on" || r["updateConnection"] === "true" } }));
    return { loadGuid: get("loadGuid") ?? "", candidates, form: review };
  }

  /** Register, update or remove an entity in the GBIF registry (the buttons of its admin page). */
  async gbifRegistration(uid: string, action: "registerGBIF" | "updateGBIF" | "deleteGBIF", o: { syncDataResources?: boolean; syncContacts?: boolean }) {
    const e = entityOf(uid);
    if (!["dataResource", "dataProvider", "institution"].includes(e)) throw new Error("GBIF registration applies to data resources, data providers and institutions");
    if (action === "deleteGBIF" && e !== "dataResource") throw new Error("only data resources can be removed from GBIF here");
    const before = await this.client.get<Json>(uid, e);
    const q = new URLSearchParams({ syncDataResources: String(!!o.syncDataResources), syncContacts: String(o.syncContacts ?? true) });
    const { html } = await this.client.page(`/${e}/${action}/${uid}?${q}`);
    const { messages, errors } = pageMessages(html);
    const after = await this.client.get<Json>(uid, e);
    return { uid, action, messages, errors, gbifRegistryKey: { before: before["gbifRegistryKey"] ?? null, after: after["gbifRegistryKey"] ?? null }, ok: !errors.length && (action === "deleteGBIF" || !!after["gbifRegistryKey"]) };
  }

  /** The GBIF sync breakdown of the admin page (shareable, licence issues, provided by GBIF…). */
  async gbifHealth() {
    const { html } = await this.client.page("/gbif/healthCheck");
    const $ = cheerio.load(html);
    const rows = $("table tr")
      .toArray()
      .map((tr) => $(tr).find("td").toArray().map((td) => $(td).text().replace(/\s+/g, " ").trim()))
      .filter((r) => r.length >= 3)
      .map((r) => ({ measure: r[0], description: r[1], value: r[2] }));
    return { rows };
  }

  async gbifOrganizations(country: string) {
    const { html } = await this.client.page(`/dataProvider/searchForOrganizations?country=${encodeURIComponent(country)}`);
    const $ = cheerio.load(html);
    const orgs = $("a[href*='importFromOrganization']")
      .toArray()
      .map((a) => {
        const key = new URL($(a).attr("href")!, this.client.baseUrl).searchParams.get("organizationKey");
        const row = $(a).closest("tr");
        return { organizationKey: key, name: row.find("td").first().text().replace(/\s+/g, " ").trim(), row: row.find("td").toArray().map((td) => $(td).text().replace(/\s+/g, " ").trim()) };
      });
    return { country, importable: orgs, table: orgs.length ? undefined : htmlTable(html) };
  }

  async gbifImportOrganization(organizationKey: string) {
    if (!/^[0-9a-f-]{36}$/i.test(organizationKey)) throw new Error("organizationKey is a GBIF organisation UUID");
    const before = new Set((await this.client.list("dataProvider")).map((d) => d.uid));
    const { html } = await this.client.page(`/dataProvider/importFromOrganization?organizationKey=${organizationKey}`);
    const created = (await this.client.list("dataProvider")).filter((d) => !before.has(d.uid));
    return { organizationKey, created, ...pageMessages(html) };
  }

  // ---------------- contacts ----------------

  async addContact(uid: string, c: { email: string; firstName?: string; lastName?: string; title?: string; phone?: string; publish?: boolean; role?: string; administrator?: boolean; primaryContact?: boolean; notify?: boolean }, apply: boolean) {
    const e = entityOf(uid);
    const existing = await this.client.contactByEmail(c.email);
    const linked = (await this.linkOf(uid, c.email)) !== undefined;
    const link = { role: c.role ?? "Contact", administrator: !!c.administrator, primaryContact: !!c.primaryContact, notify: !!c.notify };
    const plan = { uid, entity: e, contact: existing ? { id: existing["id"], action: "reuse existing contact" } : { action: "create contact", email: c.email }, link: linked ? "already linked: change it with collectory_update_contact" : link };
    if (!apply || linked) return plan;
    const contact = existing ?? (await this.client.saveContact(undefined, { email: c.email, firstName: c.firstName, lastName: c.lastName, title: c.title, phone: c.phone, publish: c.publish ?? false }));
    const id = Number(contact["id"]);
    if (!id) throw new Error("collectory did not return the contact id");
    await this.client.linkContact(uid, id, link);
    // collectory ignores notify when it creates the link; a second POST updates the link and sets it.
    if (link.notify) await this.client.linkContact(uid, id, link);
    const now = await this.linkOf(uid, c.email);
    if (!now && !this.client.hasSession && contact["publish"] === false) return { ...plan, saved: true, contactId: id, now: null, verified: null, note: "the contact is unpublished and the web service lists only published contacts (#193): log in (COLLECTORY_USERNAME) to verify" };
    return { ...plan, saved: true, contactId: id, now: now ? stripComplete(now) : null, verified: !!now && sameLink(now, link) };
  }

  /**
   * Every contact linked to an entity. /ws/{entity}/{uid}/contacts lists only published contacts (#193); with a login
   * the admin page lists them all, each contact read by id and its link flags from its role form.
   */
  async contactLinks(uid: string): Promise<{ links: FullContactLink[]; complete: boolean }> {
    if (this.client.hasSession) {
      const { html } = await this.client.page(`/${entityOf(uid)}/edit/${uid}?page=/shared/showContacts`);
      const $ = cheerio.load(html);
      const links: FullContactLink[] = [];
      for (const block of $(".show-section").toArray()) {
        const id = $(block).find('a[href*="/contact/edit/"]').attr("href")?.match(/\/contact\/edit\/(\d+)/)?.[1];
        const linkId = $(block).find('a[href*="/editRole/"]').attr("href")?.match(/\/editRole\/(\d+)/)?.[1];
        if (!id || !linkId) continue;
        const contact = await this.client.json<Json>(`/ws/contacts/${id}`, { user: "optional" }).catch(() => ({}) as Json);
        const role = await this.client.page(`/${entityOf(uid)}/editRole/${linkId}`);
        const f = findForm(role.html, role.url, { submit: "_action_updateContactRole" });
        const on = (n: string) => f.fields.some(([k, v]) => k === n && v !== "");
        links.push({ ...pick(contact, ["title", "firstName", "lastName", "email", "phone", "fax", "mobile", "publish"]), id: Number(id), linkId, role: f.fields.find(([k]) => k === "role")?.[1] ?? "", administrator: on("administrator"), primaryContact: on("primaryContact"), notify: on("notify") });
      }
      return { links, complete: true };
    }
    const ws = await this.client.contactsFor(uid).catch(() => []);
    return { links: ws.map((l) => ({ ...pick(l["contact"] as Json, ["title", "firstName", "lastName", "email", "phone", "fax", "mobile", "publish"]), role: String(l["role"] ?? ""), administrator: !!l["editor"], primaryContact: !!l["primaryContact"], notify: !!l["notify"] })), complete: false };
  }

  /** The link of the contact with this email to an entity, as {role, administrator, primaryContact, notify}. */
  private async linkOf(uid: string, email: string): Promise<(ContactLink & { complete: boolean }) | undefined> {
    const { links, complete } = await this.contactLinks(uid);
    const l = links.find((x) => String(x.email ?? "").toLowerCase() === email.toLowerCase());
    return l && { role: l.role, administrator: l.administrator, primaryContact: l.primaryContact, notify: l.notify, complete };
  }

  private notFound(uid: string, email: string, hint = "") {
    return new Error(`${email} is not a contact of ${uid}${this.client.hasSession ? "" : " as far as the web service shows: it lists only published contacts (#193); set COLLECTORY_USERNAME to see them all"}${hint}`);
  }

  /** Change the role or flags of an existing contact link (the web service updates a link it already has). */
  async updateContact(uid: string, email: string, changes: Partial<ContactLink>, apply: boolean) {
    const current = await this.linkOf(uid, email);
    if (!current) throw this.notFound(uid, email, " (collectory_add_contact adds it)");
    const next = { ...stripComplete(current), ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) } as ContactLink;
    const diff = (Object.keys(next) as Array<keyof ContactLink>).filter((k) => next[k] !== current[k]).map((k) => ({ field: k, from: current[k], to: next[k] }));
    const plan = { uid, email, current: stripComplete(current), changes: diff, ...(diff.length ? {} : { warning: "nothing changes" }) };
    if (!apply || !diff.length) return plan;
    const contact = await this.client.contactByEmail(email);
    const id = Number(contact?.["id"]);
    if (!id) throw new Error(`no contact id for ${email}`);
    await this.client.linkContact(uid, id, { ...next });
    const now = await this.linkOf(uid, email);
    return { ...plan, saved: true, now: now ? stripComplete(now) : null, verified: !!now && sameLink(now, next) };
  }

  async removeContact(uid: string, email: string, apply: boolean) {
    const current = await this.linkOf(uid, email);
    if (!current) throw this.notFound(uid, email);
    const others = (await this.contactLinks(uid)).links.length - 1;
    const plan = { uid, email, current: stripComplete(current), ...(current.primaryContact ? { warning: `${email} is the primary contact${others ? "" : " and the only contact"} of ${uid}` } : {}) };
    if (!apply) return plan;
    const contact = await this.client.contactByEmail(email);
    await this.client.unlinkContact(uid, Number(contact?.["id"]));
    const gone = (await this.linkOf(uid, email)) === undefined;
    return { ...plan, removed: gone };
  }

  // ---------------- licences ----------------

  /** The licence vocabulary with the admin ids (from /licence/list, needs a person's login). */
  async licenceRows(): Promise<Array<LicenceInput & { id: string }>> {
    const { html } = await this.client.page("/licence/list?max=100");
    const $ = cheerio.load(html);
    return $("table tbody tr")
      .toArray()
      .map((tr) => {
        const td = $(tr).find("td");
        const id = $(td[0]).find("a").attr("href")?.match(/\/licence\/show\/(\d+)/)?.[1] ?? "";
        const text = (i: number) => $(td[i]).text().replace(/\s+/g, " ").trim();
        return { id, name: text(0), url: text(1), acronym: text(2), licenceVersion: text(3), imageUrl: $(td[4]).find("img").attr("src") };
      })
      .filter((r) => r.id);
  }

  /**
   * The licence vocabulary with acronyms and versions. 6.x's web service has them; 5.x's has only name and url, so
   * there the admin list (a person's login) is read instead.
   */
  async licenceList(): Promise<Array<{ name: string; url?: string; acronym?: string; version?: string; imageUrl?: string }>> {
    const ws = await this.client.licences();
    if (ws.every((l) => l.acronym !== undefined)) return ws;
    return (await this.licenceRows()).map((r) => ({ name: r.name, url: r.url, acronym: r.acronym, version: r.licenceVersion, imageUrl: r.imageUrl }));
  }

  /** Create or update a licence (matched by acronym + version). Refuses near-duplicates such as 3.0 vs 3.x (#289). */
  async planLicence(input: LicenceInput) {
    const errors: string[] = [];
    for (const k of ["acronym", "name", "licenceVersion", "url"] as const) if (!input[k]?.trim()) errors.push(`${k} is required`);
    for (const [k, v] of Object.entries(input)) if (typeof v === "string" && v.length > 200) errors.push(`${k} is ${v.length} characters, the form allows 200`);
    for (const k of ["url", "imageUrl"] as const) if (input[k] && !/^https?:\/\//.test(input[k]!)) errors.push(`${k} must be an http(s) URL`);
    if (errors.length) throw new Error(errors.join("; "));
    const all = await this.licenceList();
    const key = (a?: string, v?: string) => `${(a ?? "").trim().toLowerCase()}|${(v ?? "").trim().toLowerCase()}`;
    const existing = all.find((l) => l.acronym !== undefined && key(l.acronym, l.version) === key(input.acronym, input.licenceVersion));
    const similar = all.filter((l) => l !== existing && ((l.url && l.url === input.url) || (l.acronym && l.acronym.toLowerCase() === input.acronym.toLowerCase())));
    const changes = existing ? (["name", "url", "imageUrl"] as const).filter((k) => (input[k] ?? "") !== ((existing as Record<string, unknown>)[k] ?? "")).map((k) => ({ field: k, from: (existing as Record<string, unknown>)[k] ?? null, to: input[k] ?? null })) : [];
    return { action: existing ? "update" : "create", licence: input, ...(existing ? { current: existing, changes } : {}), ...(similar.length ? { similar, warning: "similar licences already exist (same url, or the same acronym with another version): make sure this is not a duplicate (#289)" } : {}) };
  }

  async saveLicence(input: LicenceInput, allowSimilar: boolean) {
    const plan = await this.planLicence(input);
    if (plan.similar && plan.action === "create" && !allowSimilar) throw new Error(`${plan.warning}: ${plan.similar.map((l) => `${l.acronym ?? l.name} ${l.version ?? ""}`.trim()).join(", ")}. Pass allowSimilar:true if the user confirms it is a different licence`);
    if (plan.action === "update" && !plan.changes?.length) return { ...plan, saved: false, message: "nothing changes" };
    const fields = { name: input.name, acronym: input.acronym, licenceVersion: input.licenceVersion, url: input.url, imageUrl: input.imageUrl ?? "" };
    let res;
    if (plan.action === "create") {
      const { url, html } = await this.client.page("/licence/create");
      const form = findForm(html, url, { action: /\/save$/ });
      res = await this.client.submit(form.action, fill(form, fields, form.submits.has("create") ? "create" : undefined));
    } else {
      const row = (await this.licenceRows()).find((r) => r.acronym.toLowerCase() === input.acronym.toLowerCase() && r.licenceVersion.toLowerCase() === input.licenceVersion.toLowerCase());
      if (!row) throw new Error(`cannot find licence ${input.acronym} ${input.licenceVersion} in the admin list`);
      const { url, html } = await this.client.page(`/licence/edit/${row.id}`);
      const form = findForm(html, url, { submit: "_action_update" });
      res = await this.client.submit(form.action, fill(form, fields, "_action_update"));
    }
    const { errors, messages } = pageMessages(res.html);
    const now = (await this.licenceList()).find((l) => (l.acronym ?? "").toLowerCase() === input.acronym.toLowerCase() && (l.version ?? "").toLowerCase() === input.licenceVersion.toLowerCase());
    if (errors.length) throw new Error(`collectory refused the licence: ${errors.join("; ")}`);
    return { ...plan, saved: true, messages, verified: !!now && now.name === input.name && now.url === input.url, now: now ?? null };
  }

  /** Data resources that use a licence (licenseType = acronym and licenseVersion = version). */
  async licenceUsers(acronym: string, version: string) {
    const drs = await this.resources((await this.client.list("dataResource")).map((d) => d.uid));
    return drs.filter((d) => String(d["licenseType"] ?? "").toLowerCase() === acronym.toLowerCase() && String(d["licenseVersion"] ?? "").toLowerCase() === version.toLowerCase()).map((d) => ({ uid: d["uid"], name: d["name"] }));
  }

  async deleteLicence(acronym: string, version: string, force: boolean) {
    const users = await this.licenceUsers(acronym, version);
    if (users.length && !force) throw new Error(`${users.length} data resources use ${acronym} ${version} (${users.slice(0, 10).map((u) => u.uid).join(", ")}${users.length > 10 ? "…" : ""}): change them first, or pass force:true`);
    const row = (await this.licenceRows()).find((r) => r.acronym.toLowerCase() === acronym.toLowerCase() && r.licenceVersion.toLowerCase() === version.toLowerCase());
    if (!row) throw new Error(`cannot find licence ${acronym} ${version} in the admin list`);
    const { url, html } = await this.client.page(`/licence/show/${row.id}`);
    const form = findForm(html, url, { submit: "_action_delete" });
    const res = await this.client.submit(form.action, fill(form, {}, "_action_delete"));
    const gone = !(await this.licenceList()).some((l) => (l.acronym ?? "").toLowerCase() === acronym.toLowerCase() && (l.version ?? "").toLowerCase() === version.toLowerCase());
    return { acronym, version, deleted: gone, ...pageMessages(res.html), ...(users.length ? { leftWithoutLicence: users } : {}) };
  }

  // ---------------- taxonomy hints (form lane) ----------------

  /**
   * Taxonomy hints of an entity: the rank/name pairs (`coverage`) EmlRenderService turns into
   * `taxonomicClassification`, and the `range` it turns into `generalTaxonomicCoverage`. Both are stored in the
   * `taxonomyHints` JSON, writable only through the admin forms (`/{entity}/base`); the web service returns them
   * read-only as `taxonomyCoverageHints`. Setting a range fixes the empty `<generalTaxonomicCoverage/>` the renderer
   * writes otherwise (the EML then validates): see collectory_eml_check.
   */
  async taxonomyHints(uid: string) {
    const pg = await this.client.get<Json>(uid);
    const hints = await this.readHints(uid);
    return { uid, name: pg["name"], coverage: hints.coverage, range: hints.range };
  }

  /**
   * The web service exposes only `taxonomyCoverageHints` (the coverage), never the range or the raw `taxonomyHints`,
   * so the hints are read from the admin forms, which need a login.
   */
  private async readHints(uid: string): Promise<{ coverage: Array<{ rank: string; name: string }>; range: string[] }> {
    const e = entityOf(uid);
    const [cov, ran] = await Promise.all([
      this.client.page(`/${e}/edit/${uid}?page=/shared/editTaxonomyHints`),
      this.client.page(`/${e}/edit/${uid}?page=/shared/taxonomicRange`),
    ]);
    const $c = cheerio.load(cov.html);
    const coverage: Array<{ rank: string; name: string }> = [];
    for (const el of $c('input[name^="rank_"]').toArray()) {
      const i = ($c(el).attr("name") ?? "").slice(5);
      const rank = $c(el).attr("value")?.trim();
      const name = $c(`input[name="name_${i}"]`).attr("value")?.trim();
      if (rank && name) coverage.push({ rank, name });
    }
    const range = (cheerio.load(ran.html)('input[name="range"]').attr("value") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return { coverage, range };
  }

  async setTaxonomyHints(uid: string, o: { coverage?: Array<{ rank: string; name: string }>; range?: string[] }, apply: boolean) {
    const e = entityOf(uid);
    const pg = await this.client.get<Json>(uid, e);
    const before = await this.readHints(uid);
    const after = { coverage: o.coverage ?? before.coverage, range: o.range ?? before.range };
    const plan = { uid, name: pg["name"], before, after, ...(same(before, after) ? { warning: "nothing changes" } : {}) };
    if (!apply || same(before, after)) return plan;
    if (o.coverage) {
      const { url, html } = await this.client.page(`/${e}/edit/${uid}?page=/shared/editTaxonomyHints`);
      const form = findForm(html, url, { submit: "_action_updateTaxonomyHints" });
      const body = fill(form, {}, "_action_updateTaxonomyHints");
      for (const n of [...body.keys()]) if (/^(rank|name)_\d+$/.test(n)) body.delete(n);
      o.coverage.forEach((h, i) => {
        if (!h.rank?.trim() || !h.name?.trim()) throw new Error(`taxonomy hint ${i} needs both a rank and a name`);
        body.append(`rank_${i}`, h.rank.trim());
        body.append(`name_${i}`, h.name.trim());
      });
      await this.client.submit(form.action, body);
    }
    if (o.range) {
      const { url, html } = await this.client.page(`/${e}/edit/${uid}?page=/shared/taxonomicRange`);
      const form = findForm(html, url, { submit: "_action_updateTaxonomicRange" });
      await this.client.submit(form.action, fill(form, { range: o.range.join(",") }, "_action_updateTaxonomicRange"));
    }
    const now = await this.readHints(uid);
    return { ...plan, saved: true, verified: same(now, after), now };
  }

  // ---------------- audit ----------------

  /** Read-only checks across the registry: what the wiki says to check by hand with SQL or Solr facets. */
  async audit(o: { limit?: number } = {}) {
    const limit = o.limit ?? 500;
    const findings: Array<{ uid: string; name?: unknown; problem: string }> = [];
    const drList = (await this.client.list("dataResource")).slice(0, limit);
    const drs = await this.resources(drList.map((d) => d.uid));
    const vocabulary = new Set((await this.licenceList().catch(() => [])).map((l) => (l.acronym ?? "").toLowerCase()).filter(Boolean));
    let hiddenUrls = 0;
    for (const dr of drs) {
      const uid = String(dr["uid"]);
      const type = dr["resourceType"] as string | undefined;
      const cp = dr["connectionParameters"] as ConnectionParameters | undefined;
      if ((type ?? "records") === "records" && dr["status"] !== "declined") {
        if (!cp) findings.push({ uid, name: dr["name"], problem: "records resource without connection parameters" });
        else {
          if (!("url" in cp)) hiddenUrls++;
          for (const p of checkConnectionParameters({ ...cp, url: cp.url ?? "hidden://" }, type)) if (!p.includes("hidden://")) findings.push({ uid, name: dr["name"], problem: `connection parameters: ${p}` });
        }
        if (!dr["licenseType"]) findings.push({ uid, name: dr["name"], problem: "no licence" });
        else if (vocabulary.size && !vocabulary.has(String(dr["licenseType"]).toLowerCase())) findings.push({ uid, name: dr["name"], problem: `licence "${dr["licenseType"]}" is not in the licence vocabulary (filters and GBIF sharing will not recognise it, #264)` });
        if (!dr["dataProvider"]) findings.push({ uid, name: dr["name"], problem: "no data provider" });
      }
      if (dr["websiteUrl"] && !/^https?:\/\//.test(String(dr["websiteUrl"]))) findings.push({ uid, name: dr["name"], problem: `websiteUrl "${dr["websiteUrl"]}" does not start with http(s) (saves fail, #306)` });
      if (typeof dr["pubShortDescription"] === "string" && (dr["pubShortDescription"] as string).length > 100) findings.push({ uid, name: dr["name"], problem: "pubShortDescription longer than 100 characters (saves fail, #315)" });
    }
    for (const h of await this.client.list("dataHub")) {
      const hub = await this.client.get<Json>(h.uid, "dataHub").catch(() => undefined);
      for (const m of [...((hub?.["memberDataResources"] as Ref[]) ?? []), ...((hub?.["memberCollections"] as Ref[]) ?? []), ...((hub?.["memberInstitutions"] as Ref[]) ?? [])]) {
        if (typeof m === "object" && /missing/i.test(String(m.name ?? ""))) findings.push({ uid: h.uid, name: h.name, problem: `member ${m.uid} does not exist` });
      }
    }
    const { maps, unchecked } = await this.codeMappings();
    if (unchecked) findings.push({ uid: "-", problem: `code mappings not fully checked: ${unchecked}` });
    await this.client.codeMap().catch((e: Error) => findings.push({ uid: "-", problem: `/ws/codeMapDump fails (${e.message.slice(0, 120)}): the record loaders that read it get no mappings` }));
    for (const [i, a] of maps.entries()) {
      if (a.withoutCollection) findings.push({ uid: a.uid, name: a.name, problem: `provider map ${a.providerMapId} has no collection: ${a.collectionCodes.length ? "it makes /ws/codeMapDump fail; " : ""}the admin UI cannot delete it (NullPointerException) and collectory 6 requires a collection (#214)` });
      for (const b of maps.slice(i + 1)) {
        if (b.uid === a.uid) continue;
        for (const p of overlap(a, b)) findings.push({ uid: a.uid, name: a.name, problem: `code pair ${p.institutionCode}/${p.collectionCode} is also mapped to ${b.uid}${b.withoutCollection ? ` (provider map ${b.providerMapId} without a collection)` : ""} (ambiguous lookups, #206/#214)` });
      }
    }
    const mapped = new Set(maps.map((m) => m.uid));
    const collections = await this.client.list("collection");
    // pipelines takes institutionUid from the lookup match only, which is the collection's institution
    const colls = await this.entities("collection", [...mapped].filter((u) => entityOf(u) === "collection"));
    for (const c of colls) if (!c["institution"] && !c["unread"]) findings.push({ uid: String(c["uid"]), name: c["name"], problem: "mapped collection without an institution: its records get no institutionUid" });
    const unmapped = collections.filter((c) => !mapped.has(c.uid)).map((c) => c.uid);
    return {
      checked: { dataResources: drs.length, dataHubs: true, codeMappings: maps.length, collections: collections.length },
      findings,
      ...(unmapped.length ? { collectionsWithoutCodeMapping: unmapped, hint: "records of these collections only get their collection uid from a code mapping or a record consumer link (Data mappings wiki page)" } : {}),
      ...(hiddenUrls ? { note: `${hiddenUrls} resources returned their connection parameters without url (no admin access): url checks skipped for them` } : {}),
      ...(drList.length >= limit ? { truncated: `only the first ${limit} data resources were checked` } : {}),
    };
  }

  /**
   * Every code mapping. Collections carry theirs (recordsProviderMapping, readable by anyone); provider maps without a
   * collection, which only databases older than collectory's initial.sql can hold, are only on the admin list.
   */
  async codeMappings(): Promise<{ maps: CodeMapping[]; unchecked?: string; note?: string }> {
    const cols = await this.entities("collection", (await this.client.list("collection")).map((c) => c.uid));
    const unread = cols.filter((c) => c["unread"]).map((c) => c["uid"]);
    const maps: CodeMapping[] = [];
    for (const c of cols) {
      const m = c["recordsProviderMapping"] as Json | undefined;
      if (m?.["institutionCodes"]) maps.push({ uid: String(c["uid"]), name: c["name"] as string, institutionCodes: m["institutionCodes"] as string[], collectionCodes: (m["collectionCodes"] as string[]) ?? [], matchAny: !!m["matchAnyCollectionCode"] });
    }
    let unchecked = unread.length ? `collections ${unread.slice(0, 10).join(", ")} could not be read` : undefined;
    let note: string | undefined;
    if (this.client.hasSession) {
      try {
        maps.push(...(await this.mapsWithoutCollection()));
      } catch (e) {
        unchecked = [unchecked, `the provider map list could not be read (${(e as Error).message.slice(0, 150)})`].filter(Boolean).join("; ");
      }
    } else {
      // /ws/codeMapDump fails exactly when a map without a collection has collection codes.
      const dumpOk = await this.client.codeMap().then(() => true, () => false);
      if (!dumpOk) unchecked = [unchecked, "/ws/codeMapDump fails, as it does when a provider map without a collection has collection codes: log in (COLLECTORY_USERNAME) to check those maps"].filter(Boolean).join("; ");
      else note = "provider maps without a collection (only on databases older than collectory's initial.sql) are listed only on the admin pages: not checked without a login";
    }
    return { maps, ...(unchecked ? { unchecked } : {}), ...(note ? { note } : {}) };
  }

  /** Provider maps without a collection, from /providerMap/list (a person's login) and each map's show page. */
  private async mapsWithoutCollection(): Promise<CodeMapping[]> {
    const { html } = await this.client.page("/providerMap/list?max=100000");
    const $ = cheerio.load(html);
    const out: CodeMapping[] = [];
    for (const tr of $("table tbody tr").toArray()) {
      const td = $(tr).find("td");
      if (td.length < 7 || $(td[2]).text().trim()) continue;
      const id = $(td[0]).find("a").attr("href")?.match(/\/providerMap\/show\/(\d+)/)?.[1];
      if (!id) continue;
      const show = await this.client.page(`/providerMap/show/${id}`);
      const inUid = show.html.match(/\/institution\/show\/(in\d+)/)?.[1];
      const codes = (i: number) => $(td[i]).text().trim().split(/\s+/).filter(Boolean);
      out.push({ uid: inUid ?? `providerMap ${id}`, name: $(td[1]).text().trim() || undefined, institutionCodes: codes(5), collectionCodes: codes(6), matchAny: /yes|true/i.test($(td[4]).text()), withoutCollection: true, providerMapId: id });
    }
    return out;
  }

  /** Full JSON of several data resources: POST /ws/find (5.1+), one GET per uid when that fails. */
  resources(uids: string[]): Promise<Json[]> {
    return this.entities("dataResource", uids);
  }

  async entities(entity: Entity, uids: string[]): Promise<Json[]> {
    if (!uids.length) return [];
    try {
      const out: Json[] = [];
      for (let i = 0; i < uids.length; i += 100) out.push(...((await this.client.find(entity, uids.slice(i, i + 100))) as Json[]));
      return out;
    } catch {
      const out: Json[] = [];
      for (let i = 0; i < uids.length; i += 8) out.push(...(await Promise.all(uids.slice(i, i + 8).map((u) => this.client.get<Json>(u, entity).catch(() => ({ uid: u, name: "(could not be read)", unread: true }))))));
      return out;
    }
  }
}

export interface ContactLink {
  role: string;
  administrator: boolean;
  primaryContact: boolean;
  notify: boolean;
}

export interface FullContactLink extends ContactLink {
  id?: number;
  linkId?: string;
  title?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  fax?: string;
  mobile?: string;
  publish?: boolean;
}

const pick = (o: Json | undefined, keys: string[]) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined && o?.[k] !== null).map((k) => [k, o![k]]));
const stripComplete = <T extends { complete?: boolean }>(l: T) => {
  const { complete: _c, ...rest } = l;
  return rest;
};

const sameLink = (a: ContactLink, b: ContactLink) => a.role === b.role && a.administrator === b.administrator && a.primaryContact === b.primaryContact && a.notify === b.notify;

export interface CodeMapping {
  /** The collection (or, for a provider map without a collection, its institution) lookups resolve to. */
  uid: string;
  name?: string;
  institutionCodes: string[];
  collectionCodes: string[];
  matchAny: boolean;
  withoutCollection?: boolean;
  providerMapId?: string;
}

/**
 * Code pairs two maps both match. collectory compares codes in MySQL, case-insensitively, and a map with
 * matchAnyCollectionCode takes every collection code of its institution codes ("*").
 */
export function overlap(a: Pick<CodeMapping, "institutionCodes" | "collectionCodes" | "matchAny">, b: Pick<CodeMapping, "institutionCodes" | "collectionCodes" | "matchAny">) {
  const low = (xs: string[]) => new Set(xs.map((x) => x.toLowerCase()));
  const bInst = low(b.institutionCodes);
  const bColl = low(b.collectionCodes);
  const out: Array<{ institutionCode: string; collectionCode: string }> = [];
  for (const i of a.institutionCodes) {
    if (!bInst.has(i.toLowerCase())) continue;
    if (a.matchAny || b.matchAny) out.push({ institutionCode: i, collectionCode: a.matchAny && b.matchAny ? "*" : (a.matchAny ? b.collectionCodes : a.collectionCodes).join("|") || "*" });
    else for (const c of a.collectionCodes) if (bColl.has(c.toLowerCase())) out.push({ institutionCode: i, collectionCode: c });
  }
  return out;
}

export interface LicenceInput {
  acronym: string;
  name: string;
  licenceVersion: string;
  url: string;
  imageUrl?: string;
}

export interface RepatriationQuery {
  country: string;
  recordType?: string;
  dataProviderUid?: string;
  maxDatasets?: number;
  minRecordCount?: number;
  maxRecordCount?: number;
}

export interface IptItem {
  title: string;
  link: string;
  description: string;
  pubDate?: string;
  dwca?: string;
  eml?: string;
  gbifKey?: string;
}

/** Items of an IPT rss.do feed (the fields collectory's IptService reads). */
export function parseIptRss(xml: string): IptItem[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  return $("item")
    .toArray()
    .map((el) => {
      const $i = $(el);
      const t = (sel: string) => $i.children(sel).first().text().trim() || undefined;
      const guid = t("guid");
      return { title: t("title") ?? "", link: t("link") ?? "", description: t("description") ?? "", pubDate: t("pubDate"), dwca: t("ipt\\:dwca"), eml: t("ipt\\:eml"), gbifKey: guid && !guid.startsWith("http") ? guid.split("/")[0] : undefined };
    });
}

export { ENTITIES };
