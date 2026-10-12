import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A fake collectory 6.3.0 with the behaviour the MCP depends on, taken from the 6.3.0 code:
 * - PermissionInterceptor: /ws writes need ROLE_EDITOR/ROLE_ADMIN or the scope ala/internal (403 JSON otherwise);
 *   admin pages need a person (roles only): a machine token is refused, an anonymous browser is sent to the login;
 * - CrudService: only the writable fields are applied, JSON fields are stored as strings, memberDataResources only on
 *   update, recordsMapping replaces every code, websiteUrl must start with http(s), the new uid is in Location;
 * - connectionParameters.url is left out of the answer without ROLE_ADMIN or the scope;
 * - the admin forms with the field names of the 6.3.0 GSPs (dataHub/members, dataResource/consumers, manage/repatriate…).
 * It also serves a fake IPT (/ipt/rss.do) and a fake GBIF API (/gbif/v1/dataset/{key}).
 */

type Json = Record<string, any>;

export interface FakeOptions {
  version?: string;
  /** Answer 500 on single data resource GETs, as 6.0.0 does (FindBest). */
  brokenDrGet?: boolean;
  /** /ws/licence with only name and url, as 5.x answers. */
  legacyLicenceWs?: boolean;
  /** Show pages that fail to render, which 6.x's error page turns into a redirect to "/" (as a missing gbifLicenceMappingUrl file does). */
  brokenShowPages?: boolean;
}

export interface FakeState {
  entities: Map<string, Json>;
  contacts: Map<number, Json>;
  links: Array<{ uid: string; contactId: number; role: string; administrator: boolean; primaryContact: boolean }>;
  providerMaps: Map<string, { institutionCodes: string[]; collectionCodes: string[]; exact: boolean; matchAnyCollectionCode: boolean; warning?: string }>;
  /** Provider maps without a collection (a database older than initial.sql, whose collection_id is nullable). */
  legacyMaps: Array<{ id: number; institution: string; institutionCodes: string[]; collectionCodes: string[]; matchAnyCollectionCode: boolean }>;
  ipt: Array<{ title: string; link: string; description: string; pubDate: string; dwca: string; guid: string }>;
  gbif: Map<string, { pubDate: string }>;
  loads: Map<string, { names: string[]; polls: number }>;
  /** Every request: method, path, auth kind. */
  requests: Array<{ method: string; path: string; auth: string; body?: string }>;
  counters: Record<string, number>;
  licences: Map<number, { name: string; acronym: string; licenceVersion: string; url: string; imageUrl?: string; version: number }>;
  /** collectory's dataHubCache: a snapshot of the hubs taken on first use and never evicted. */
  hubCache?: Array<{ uid: string; name: string; members: string[] }>;
}

const TOKENS: Record<string, { roles: string[]; scopes: string[] }> = {
  "m2m-token": { roles: [], scopes: ["ala/internal"] },
  "editor-token": { roles: ["ROLE_EDITOR"], scopes: [] },
  "admin-token": { roles: ["ROLE_ADMIN", "ROLE_EDITOR"], scopes: [] },
  "user-token": { roles: ["ROLE_USER"], scopes: [] },
};
export const ADMIN_LOGIN = { username: "admin@example.org", password: "s3cret-pass" };
/** A person without ROLE_EDITOR/ROLE_ADMIN. */
export const USER_LOGIN = { username: "user@example.org", password: "user-pass-1" };
const PREFIX: Record<string, string> = { institution: "in", collection: "co", dataProvider: "dp", dataResource: "dr", dataHub: "dh" };
const JSON_FIELDS = ["connectionParameters", "contentTypes", "defaultDarwinCoreValues", "imageMetadata"];
const BASE = ["guid", "name", "acronym", "phone", "email", "state", "pubShortDescription", "pubDescription", "techDescription", "notes", "isALAPartner", "focus", "attributions", "websiteUrl", "networkMembership", "altitude", "gbifRegistryKey", "latitude", "longitude"];
const WRITABLE: Record<string, string[]> = {
  institution: [...BASE, "institutionType"],
  collection: [...BASE, "collectionType", "keywords", "active", "states", "geographicDescription", "startDate", "endDate", "kingdomCoverage", "scientificNames", "subCollections", "numRecords", "eastCoordinate", "westCoordinate", "northCoordinate", "southCoordinate"],
  dataProvider: [...BASE, "hiddenJSON"],
  dataResource: [...BASE, "rights", "citation", "licenseType", "licenseVersion", "status", "resourceType", "connectionParameters", "defaultDarwinCoreValues", "imageMetadata", "contentTypes", "provenance", "harvestingNotes", "isShareableWithGBIF", "gbifDataset", "repatriationCountry", "dataCurrency", "lastChecked"],
  dataHub: [...BASE],
};

export async function startFakeCollectory(opts: FakeOptions = {}) {
  const state: FakeState = { entities: new Map(), contacts: new Map(), links: [], providerMaps: new Map(), legacyMaps: [], ipt: [], gbif: new Map(), loads: new Map(), licences: new Map([[1, { name: "Creative Commons Attribution", acronym: "CC-BY", licenceVersion: "4.0", url: "https://creativecommons.org/licenses/by/4.0/", version: 0 }]]), requests: [], counters: { in: 0, co: 0, dp: 0, dr: 0, dh: 0, contact: 0 } };
  const sessions = new Map<string, string[]>();
  const deleting = new Set<string>();
  let base = "";

  const add = (entity: string, fields: Json): Json => {
    const p = PREFIX[entity]!;
    let uid = fields["uid"];
    while (!uid || (!fields["uid"] && state.entities.has(uid))) uid = `${p}${++state.counters[p]!}`;
    const e: Json = { uid, entity, version: 0, lastUpdated: "2020-01-01T00:00:00Z", ...fields };
    state.entities.set(uid, e);
    return e;
  };

  const who = (req: IncomingMessage): { kind: string; roles: string[]; scopes: string[]; person: boolean } => {
    const h = req.headers["authorization"];
    const m = typeof h === "string" ? h.match(/^Bearer\s+(.+)$/) : null;
    if (m && TOKENS[m[1]!]) return { kind: m[1]!, ...TOKENS[m[1]!]!, person: TOKENS[m[1]!]!.roles.length > 0 };
    const sid = (req.headers["cookie"] ?? "").match(/JSESSIONID=(\w+)/)?.[1];
    if (sid && sessions.has(sid)) return { kind: "session", roles: sessions.get(sid)!, scopes: [], person: true };
    return { kind: "anonymous", roles: [], scopes: [], person: false };
  };

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, { "Content-Type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json", ...headers }).end(text);
  };
  const redirect = (res: ServerResponse, to: string) => res.writeHead(302, { Location: to.startsWith("http") ? to : base + to }).end();

  const readEntity = (e: Json, admin: boolean): Json => {
    const out: Json = { ...e };
    delete out["entity"];
    for (const f of JSON_FIELDS) if (typeof out[f] === "string") out[f] = JSON.parse(out[f]);
    if (out["connectionParameters"] && !admin) delete out["connectionParameters"]["url"];
    if (e["entity"] === "dataHub") {
      for (const k of ["memberDataResources", "memberInstitutions", "memberCollections"]) {
        const list: string[] = e[k] ? JSON.parse(e[k]) : [];
        out[k] = list.map((u) => (state.entities.has(u) ? { uid: u, name: state.entities.get(u)!["name"] } : { uid: u, name: "data resource missing" }));
      }
    }
    // collectory 6.3.0 builds hubMembership from a cached hub list that hub edits never evict.
    state.hubCache ??= [...state.entities.values()].filter((h) => h["entity"] === "dataHub").map((h) => ({ uid: h["uid"], name: h["name"], members: ["memberDataResources", "memberInstitutions", "memberCollections"].flatMap((k) => (h[k] ? JSON.parse(h[k]) : [])) }));
    out["hubMembership"] = state.hubCache.filter((h) => h.members.includes(e["uid"])).map(({ uid, name }) => ({ uid, name }));
    if (e["entity"] === "dataProvider") out["dataResources"] = [...state.entities.values()].filter((d) => d["entity"] === "dataResource" && d["dataProvider"] === e["uid"]).map((d) => ({ uid: d["uid"], name: d["name"] }));
    if (e["entity"] === "dataResource" || e["entity"] === "dataProvider") {
      delete out["consumers"];
      const c: string[] = e["consumers"] ?? [];
      if (c.length) out["linkedRecordConsumers"] = c.map((u) => ({ uid: u, name: state.entities.get(u)?.["name"] }));
      if (e["dataProvider"]) out["dataProvider"] = { uid: e["dataProvider"], name: state.entities.get(e["dataProvider"])?.["name"] };
    }
    if (e["entity"] === "collection" || e["entity"] === "institution") {
      const providers = [...state.entities.values()].filter((d) => (d["consumers"] ?? []).includes(e["uid"]));
      if (providers.length) out["linkedRecordProviders"] = providers.map((d) => ({ uid: d["uid"], name: d["name"] }));
    }
    const pm = state.providerMaps.get(e["uid"]);
    if (pm) out["recordsProviderMapping"] = { ...pm };
    return out;
  };

  const page = (title: string, inner: string, flash?: string) => `<!doctype html><html><head><title>${title}</title></head><body>${flash ? `<div class="message alert alert-info">${flash}</div>` : ""}${inner}</body></html>`;
  const flashes = new Map<string, string>();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    const path = url.pathname;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const caller = who(req);
    state.requests.push({ method: req.method ?? "GET", path: path + url.search, auth: caller.kind, body: raw || undefined });
    const isWs = path.startsWith("/ws/");
    const admin = caller.roles.includes("ROLE_ADMIN") || caller.scopes.includes("ala/internal");
    const editorOrScope = caller.roles.some((r) => r === "ROLE_EDITOR" || r === "ROLE_ADMIN") || caller.scopes.includes("ala/internal");
    const deny = () => send(res, 403, { error: "Access denied. You do not have permissions" });
    const form = () => new URLSearchParams(raw);
    // The licence forms of 6.3.0: create posts to /licence/save; edit and show post to /ws/licence (Grails reverse-maps
    // licence/index there) with _action_update / _action_delete.
    const licencePost = () => {
      const f = form();
      if (f.has("_action_delete")) {
        if (!caller.roles.includes("ROLE_ADMIN")) return redirect(res, "/public/map");
        state.licences.delete(Number(f.get("id")));
        return redirect(res, "/licence/list");
      }
      const missing = ["name", "acronym", "licenceVersion", "url"].filter((k) => !f.get(k));
      if (missing.length) return send(res, 200, page("licence", `<ul class="errors">${missing.map((k) => `<li>Property [${k}] cannot be null</li>`).join("")}</ul>`));
      const fields = { name: f.get("name")!, acronym: f.get("acronym")!, licenceVersion: f.get("licenceVersion")!, url: f.get("url")!, ...(f.get("imageUrl") ? { imageUrl: f.get("imageUrl")! } : {}) };
      let id = Number(f.get("id"));
      if (f.has("_action_update")) {
        const l = state.licences.get(id)!;
        if (Number(f.get("version")) !== l.version) return send(res, 200, page("licence", `<ul class="errors"><li>Another user has updated this Licence while you were editing</li></ul>`));
        state.licences.set(id, { ...fields, version: l.version + 1 });
      } else {
        id = Math.max(0, ...state.licences.keys()) + 1;
        state.licences.set(id, { ...fields, version: 0 });
      }
      flashes.set(`licence${id}`, `Licence ${id} ${f.has("_action_update") ? "updated" : "created"}`);
      return redirect(res, `/licence/show/${id}`);
    };

    // ---------- fake IPT and GBIF ----------
    if (path === "/ipt/rss.do") {
      const items = state.ipt.map((i) => `<item><title>${i.title}</title><link>${i.link}</link><description>${i.description}</description><pubDate>${i.pubDate}</pubDate><guid>${i.guid}</guid><ipt:dwca>${i.dwca}</ipt:dwca><ipt:eml>${i.link.replace("resource", "eml.do")}</ipt:eml></item>`).join("");
      return send(res, 200, `<?xml version="1.0"?><rss xmlns:ipt="http://ipt.gbif.org/"><channel><title>IPT</title>${items}</channel></rss>`, { "Content-Type": "application/rss+xml" });
    }
    const gb = path.match(/^\/gbif\/v1\/dataset\/([\w-]+)$/);
    if (gb) return state.gbif.has(gb[1]!) ? send(res, 200, { key: gb[1], ...state.gbif.get(gb[1]!) }) : send(res, 404, { error: "not found" });

    // ---------- fake login (CAS form -> session) ----------
    if (path === "/cas/login" && req.method === "GET") return send(res, 200, page("CAS", `<form method="post" action="/cas/login?service=${encodeURIComponent(url.searchParams.get("service") ?? "")}"><input type="text" name="username"><input type="password" name="password"><input type="hidden" name="execution" value="e1s1"><input type="submit" name="submit" value="Login"></form>`));
    if (path === "/cas/login" && req.method === "POST") {
      const f = form();
      const account = [ADMIN_LOGIN, USER_LOGIN].find((a) => a.username === f.get("username") && a.password === f.get("password"));
      if (!account) return send(res, 200, page("CAS", `<p>bad</p><form method="post"><input name="username"><input type="password" name="password"><input type="hidden" name="execution" value="e1s2"></form>`));
      const sid = Math.random().toString(36).slice(2);
      sessions.set(sid, account === ADMIN_LOGIN ? ["ROLE_ADMIN", "ROLE_EDITOR"] : ["ROLE_USER"]);
      return res.writeHead(302, { Location: url.searchParams.get("service") || base + "/manage/list", "Set-Cookie": `JSESSIONID=${sid}; Path=/; HttpOnly` }).end();
    }

    if (path === "/openapi/openapi.json") return send(res, 200, { openapi: "3.0.1", info: { title: "collectory", version: opts.version ?? "6.3.0" }, paths: {} });

    // ---------- web services ----------
    if (isWs) {
      if (path === "/ws/codeMapDump") {
        // DataController.codeMapDump reads it.collection.uid inside the loop over collection codes
        if (state.legacyMaps.some((m) => m.collectionCodes.length)) return send(res, 500, "NullPointerException: Cannot get property 'uid' on null object");
        let csv = "collectionCode,institutionCode,collectionUid,collectionName,institutionUid,institutionName,dataProviderUid,dataProviderName,dataHubUid,dataHubName,taxonomicHints\n";
        for (const [co, pm] of state.providerMaps) for (const c of pm.collectionCodes) for (const i of pm.institutionCodes) csv += `${c},${i},${co},"${state.entities.get(co)?.["name"]}",null,"null",dp20,OZCAM,dh1,OZCAM,\n`;
        return send(res, 200, csv, { "Content-Type": "text/csv" });
      }
      const lk = path.match(/^\/ws\/lookup\/inst\/([^/]+)\/coll\/([^/]+)$/);
      if (lk) {
        const [i, c] = [decodeURIComponent(lk[1]!), decodeURIComponent(lk[2]!)];
        // ProviderMap.findMatch: the first map from the database (here, the older maps without a collection), codes
        // compared case-insensitively by MySQL
        const eq = (xs: string[], x: string) => xs.some((y) => y.toLowerCase() === x.toLowerCase());
        for (const m of state.legacyMaps) if (eq(m.institutionCodes, i) && (m.matchAnyCollectionCode || eq(m.collectionCodes, c))) return send(res, 200, { uid: m.institution, name: state.entities.get(m.institution)?.["name"] });
        for (const [co, pm] of state.providerMaps) if (pm.institutionCodes.includes(i) && (pm.matchAnyCollectionCode || pm.collectionCodes.includes(c))) return send(res, 200, { uid: co, name: state.entities.get(co)?.["name"] });
        return send(res, 200, { error: `Unable to find collection for ${i}/${c}` });
      }
      if (path === "/ws/licence" && req.method === "POST") {
        // a form post as the logged-in person: PermissionInterceptor answers JSON 403 on /ws/ without the session's role
        if (caller.kind !== "session" || !caller.roles.some((r) => r === "ROLE_EDITOR" || r === "ROLE_ADMIN")) return deny();
        return licencePost();
      }
      if (path === "/ws/licence") return send(res, 200, [...state.licences.values()].map((l) => (opts.legacyLicenceWs ? { name: l.name, url: l.url } : { name: l.name, url: l.url, imageUrl: l.imageUrl ?? null, acronym: l.acronym, version: l.licenceVersion })));
      if (path === "/ws/syncGBIF") return editorOrScope && (caller.roles.includes("ROLE_ADMIN") || caller.scopes.length) ? send(res, 200, { status: "STARTED" }) : deny();
      const ipt = path.match(/^\/ws\/ipt\/scan\/(dp\d+)(\.json)?$/);
      if (ipt) {
        if (!admin) return deny();
        if (url.searchParams.get("create") === "true") return send(res, 403, "Unable to create resources for " + ipt[1]);
        return send(res, 200, iptScan(ipt[1]!, false, url.searchParams.get("key") ?? "catalogNumber"));
      }
      const gs = path.match(/^\/ws\/gbif\/scan\/(dp\d+)$/);
      if (gs) {
        if (!admin) return deny();
        const loadGuid = `load-${Date.now()}`;
        const drs = [...state.entities.values()].filter((d) => d["dataProvider"] === gs[1]);
        state.loads.set(loadGuid, { names: drs.map((d) => d["name"]), polls: 0 });
        return send(res, 200, { loadGuid, trackingUrl: `${base}/manage/externalLoadStatus?loadGuid=${loadGuid}`, updates: [], resources: drs.map((d) => ({ uid: d["uid"], status: "IN_SYNC" })) });
      }
      if (path.startsWith("/ws/contacts")) {
        if (path === "/ws/contacts/0") return editorOrScope ? send(res, 400, "no such id") : deny();
        const em = path.match(/^\/ws\/contacts\/email\/(.+)$/);
        if (em) {
          const c = [...state.contacts.values()].find((x) => x["email"] === decodeURIComponent(em[1]!));
          return c ? send(res, 200, c) : send(res, 404, "");
        }
        const m = path.match(/^\/ws\/contacts(?:\/(\d+))?$/);
        if (m && req.method === "POST") {
          if (!editorOrScope) return deny();
          const body = JSON.parse(raw);
          const id = m[1] ? Number(m[1]) : ++state.counters["contact"]!;
          const c = { ...(state.contacts.get(id) ?? {}), ...body, id };
          state.contacts.set(id, c);
          return send(res, 200, c);
        }
      }
      const cl = path.match(/^\/ws\/(\w+)\/(\w+\d+)\/contacts(?:\/(\d+))?$/);
      if (cl) {
        if (req.method === "GET" && !cl[3]) return send(res, 200, state.links.filter((l) => l.uid === cl[2]).map((l) => ({ contact: state.contacts.get(l.contactId), role: l.role, primaryContact: l.primaryContact, editor: l.administrator })));
        if (req.method === "POST" && cl[3]) {
          if (!editorOrScope) return deny();
          const b = JSON.parse(raw);
          state.links.push({ uid: cl[2]!, contactId: Number(cl[3]), role: b.role, administrator: !!b.administrator, primaryContact: !!b.primaryContact });
          return send(res, 201, "created");
        }
      }
      const find = path.match(/^\/ws\/find\/(\w+)$/);
      if (find && req.method === "POST") return send(res, 200, (JSON.parse(raw) as string[]).filter((u) => state.entities.get(u)?.["entity"] === find[1]).map((u) => JSON.stringify(readEntity(state.entities.get(u)!, admin))));
      const cnt = path.match(/^\/ws\/(\w+)\/count(?:\/(\w+))?$/);
      if (cnt) return send(res, 200, { total: [...state.entities.values()].filter((e) => e["entity"] === cnt[1]).length });
      const m = path.match(/^\/ws\/(\w+)(?:\/(\w+\d+))?$/);
      if (m && PREFIX[m[1]!]) {
        const [, entity, uid] = m as unknown as [string, string, string | undefined];
        if (req.method === "GET" && !uid) {
          const filters = [...url.searchParams];
          return send(res, 200, [...state.entities.values()].filter((e) => e["entity"] === entity && filters.every(([k, v]) => String(e[k]) === v)).map((e) => ({ name: e["name"], uri: `${base}/ws/${entity}/${e["uid"]}`, uid: e["uid"] })));
        }
        const e = uid ? state.entities.get(uid) : undefined;
        if (uid && (!e || e["entity"] !== entity)) return send(res, 404, `no such ${entity} ${uid}`);
        if (req.method === "GET") {
          if (opts.brokenDrGet && entity === "dataResource") return send(res, 500, "MissingPropertyException: No such property: FindBest");
          const out = readEntity(e!, admin);
          // 6.3.0 can answer a DELETE before committing it: the next GET still sees the entity.
          if (deleting.delete(uid!)) state.entities.delete(uid!);
          return send(res, 200, out);
        }
        if (req.method === "DELETE") {
          if (!editorOrScope) return deny();
          deleting.add(uid!);
          return send(res, 200, { message: `deleted ${e!["name"]}` });
        }
        if (req.method === "POST" || req.method === "PUT") {
          if (!editorOrScope) return deny();
          if (!raw) return send(res, 200, "no post body");
          const body = JSON.parse(raw) as Json;
          if (typeof body["websiteUrl"] === "string" && body["websiteUrl"] && !/^https?:\/\//.test(body["websiteUrl"])) return send(res, 400, "Field error in object: websiteUrl providerGroup.websiteUrl.invalid");
          if (!e && entity === "collection" && ["eastCoordinate", "westCoordinate", "northCoordinate", "southCoordinate"].some((k) => body[k] === undefined || body[k] === null)) return send(res, 400, "ValidationErrors: Field error in object 'au.org.ala.collectory.Collection' on field 'southCoordinate': rejected value [null]");
          const target = e ?? add(entity, { name: body["name"] });
          for (const k of WRITABLE[entity] ?? []) if (k in body) target[k] = JSON_FIELDS.includes(k) && body[k] !== null && typeof body[k] === "object" ? JSON.stringify(body[k]) : body[k];
          if (entity === "dataHub" && e && "memberDataResources" in body) target["memberDataResources"] = body["memberDataResources"];
          if (entity === "dataResource" && body["dataProvider"]?.uid) target["dataProvider"] = body["dataProvider"].uid;
          if (entity === "collection" && body["recordsMapping"]) {
            const r = body["recordsMapping"];
            const arr = (v: unknown) => (typeof v === "string" ? [v] : ((v as string[]) ?? []));
            state.providerMaps.set(target["uid"], { institutionCodes: arr(r.institutionCodes), collectionCodes: arr(r.collectionCodes), exact: !!r.exact, matchAnyCollectionCode: !!r.matchAnyCollectionCode, ...(r.warning ? { warning: r.warning } : {}) });
          }
          target["version"]++;
          if (!e) return send(res, 201, "inserted entity", { Location: `http://dev.ala.org.au:8080/ws/${entity}/${target["uid"]}` });
          return send(res, 200, `updated ${entity}`);
        }
      }
      return send(res, 404, `fake: no route for ${req.method} ${path}`);
    }

    // ---------- admin pages: a person's login session with ROLE_EDITOR/ROLE_ADMIN ----------
    // 6.3.0 ignores Bearer tokens here, even a person's with ROLE_ADMIN: without a session it starts the login.
    if (path.startsWith("/public/") || path === "/") return send(res, 200, page("public", "<p>map</p>"));
    // Pages guarded only by @PermissionRequired (no login filter) send an anonymous caller to the public map, mapped
    // to "/" in 6.3.0, instead of starting the login.
    if (caller.kind !== "session" && path.startsWith("/licence/")) return redirect(res, "/");
    if (caller.kind !== "session") return redirect(res, `/cas/login?service=${encodeURIComponent(base + path + url.search)}`);
    // PermissionInterceptor: a logged-in person without the role is sent to the public map.
    if (!caller.roles.some((r) => r === "ROLE_EDITOR" || r === "ROLE_ADMIN")) return redirect(res, "/public/map");
    if (path === "/manage/list") return send(res, 200, page("Manage", "<h1>Your entities</h1>"));

    const show = path.match(/^\/(\w+)\/show\/(\w+\d+)$/);
    if (show && opts.brokenShowPages) return redirect(res, "/");
    if (show) {
      const flash = flashes.get(show[2]!);
      flashes.delete(show[2]!);
      return send(res, 200, page(show[2]!, `<h1>${state.entities.get(show[2]!)?.["name"]}</h1>`, flash));
    }
    const hubEdit = path.match(/^\/dataHub\/edit\/(dh\d+)$/);
    if (hubEdit && url.searchParams.get("page") === "/dataHub/members") {
      const h = state.entities.get(hubEdit[1]!)!;
      return send(res, 200, page("members", `<form method="post" name="baseForm" action="/dataHub/base"><input type="hidden" name="uid" value="${h["uid"]}"><input type="hidden" name="version" value="${h["version"]}"><textarea name="memberInstitutions">${h["memberInstitutions"] ?? ""}</textarea><textarea name="memberCollections">${h["memberCollections"] ?? ""}</textarea><textarea name="memberDataResources">${h["memberDataResources"] ?? ""}</textarea><input type="submit" name="_action_updateDescription" value="Update"><input type="submit" name="_action_cancel" value="Cancel"></form>`));
    }
    if (path === "/dataHub/base" && req.method === "POST") {
      const f = form();
      const h = state.entities.get(f.get("uid")!)!;
      if (!f.has("_action_updateDescription")) return redirect(res, `/dataHub/show/${h["uid"]}`);
      if (Number(f.get("version")) !== h["version"]) return send(res, 200, page("members", `<ul class="errors"><li>Another user has updated this hub while you were editing</li></ul>`));
      for (const k of ["memberInstitutions", "memberCollections", "memberDataResources"]) if (f.has(k)) h[k] = f.get(k);
      h["version"]++;
      return redirect(res, `/dataHub/show/${h["uid"]}`);
    }
    const cons = path.match(/^\/(dataResource|dataProvider)\/editConsumers\/(\w+\d+)$/);
    if (cons) {
      const e = state.entities.get(cons[2]!)!;
      const source = url.searchParams.get("source") ?? "co";
      const list = ((e["consumers"] as string[]) ?? []).filter((u) => u.startsWith(source)).join(",");
      return send(res, 200, page("consumers", `<form method="post" name="baseForm" action="/${cons[1]}/base"><input type="hidden" name="id" value="${e["uid"]}"><input type="hidden" name="version" value="${e["version"]}"><input type="hidden" name="source" value="${source}"><input type="hidden" name="consumers" value="${list}"><input type="submit" name="_action_updateConsumers" value="Update"></form>`));
    }
    const consPost = path.match(/^\/(dataResource|dataProvider)\/base$/);
    if (consPost && req.method === "POST") {
      const f = form();
      const e = state.entities.get(f.get("id")!)!;
      const source = f.get("source")!;
      const next = (f.get("consumers") ?? "").split(",").filter(Boolean);
      e["consumers"] = [...((e["consumers"] as string[]) ?? []).filter((u) => !u.startsWith(source)), ...next];
      return redirect(res, `/${consPost[1]}/show/${e["uid"]}`);
    }
    const iptUi = path === "/dataProvider/iptScan";
    if (iptUi) return send(res, 200, iptScan(url.searchParams.get("uid")!, url.searchParams.get("create") === "true", url.searchParams.get("key") ?? "catalogNumber"));
    const gr = path.match(/^\/(dataResource|dataProvider|institution)\/(registerGBIF|updateGBIF|deleteGBIF)\/(\w+\d+)$/);
    if (gr) {
      const e = state.entities.get(gr[3]!)!;
      if (gr[2] === "deleteGBIF") delete e["gbifRegistryKey"];
      else e["gbifRegistryKey"] ??= "11111111-2222-3333-4444-555555555555";
      flashes.set(e["uid"], gr[2] === "deleteGBIF" ? "Resource removed from GBIF" : "Successfully registered in GBIF");
      return redirect(res, `/${gr[1]}/show/${e["uid"]}`);
    }
    // provider maps (views/providerMap/list.gsp and show.gsp of 6.3.0)
    if (path === "/providerMap/list") {
      const yes = (b: boolean) => (b ? "Yes" : "No");
      const rows = [
        ...state.legacyMaps.map((m) => `<tr><td><a href="/providerMap/show/${m.id}?returnTo=">${m.id}</a></td><td>${state.entities.get(m.institution)?.["name"] ?? ""}</td><td></td><td>Yes</td><td>${yes(m.matchAnyCollectionCode)}</td><td>${m.institutionCodes.join(" ")}</td><td>${m.collectionCodes.join(" ")}</td></tr>`),
        ...[...state.providerMaps].map(([co, pm], k) => `<tr><td><a href="/providerMap/show/${100 + k}?returnTo=">${100 + k}</a></td><td></td><td>${state.entities.get(co)?.["name"]}</td><td>${yes(pm.exact)}</td><td>${yes(pm.matchAnyCollectionCode)}</td><td>${pm.institutionCodes.join(" ")}</td><td>${pm.collectionCodes.join(" ")}</td></tr>`),
      ];
      return send(res, 200, page("provider maps", `<table><thead><tr><th>Id</th><th>Institution</th><th>Collection</th><th>Exact</th><th>Match Any Collection Code</th><th>Institution Codes</th><th>Collection Codes</th></tr></thead><tbody>${rows.join("")}</tbody></table>`));
    }
    const pmShow = path.match(/^\/providerMap\/show\/(\d+)$/);
    if (pmShow) {
      const m = state.legacyMaps.find((x) => x.id === Number(pmShow[1]));
      return m ? send(res, 200, page("provider map", `<a href="/institution/show/${m.institution}">${state.entities.get(m.institution)?.["name"]}</a><a href="/collection/show"></a>`)) : redirect(res, "/providerMap/list");
    }

    // licences (views/licence/*.gsp of 6.3.0)
    const licenceForm = (l?: { name: string; acronym: string; licenceVersion: string; url: string; imageUrl?: string }) => ["name", "acronym", "licenceVersion"].map((k) => `<input type="text" name="${k}" maxlength="200" required value="${(l as any)?.[k] ?? ""}">`).join("") + `<input type="url" name="url" maxlength="200" required value="${l?.url ?? ""}"><input type="url" name="imageUrl" maxlength="200" required value="${l?.imageUrl ?? ""}">`;
    if (path === "/licence/list") return send(res, 200, page("licences", `<table><thead><tr><th>Name</th><th>URL</th><th>Acronym</th><th>Version</th><th>Image</th></tr></thead><tbody>${[...state.licences].map(([id, l]) => `<tr><td><a href="/licence/show/${id}">${l.name}</a></td><td>${l.url}</td><td>${l.acronym}</td><td>${l.licenceVersion}</td><td>${l.imageUrl ? `<img src="${l.imageUrl}">` : ""}</td></tr>`).join("")}</tbody></table>`));
    if (path === "/licence/create") return send(res, 200, page("new licence", `<form action="/licence/save" method="post">${licenceForm()}<input type="submit" name="create" value="Create"></form>`));
    const lShow = path.match(/^\/licence\/(show|edit)\/(\d+)$/);
    if (lShow) {
      const l = state.licences.get(Number(lShow[2]));
      if (!l) return redirect(res, "/licence/list");
      const flash = flashes.get(`licence${lShow[2]}`);
      flashes.delete(`licence${lShow[2]}`);
      if (lShow[1] === "show") return send(res, 200, page("licence", `<h1>${l.name}</h1><form action="/ws/licence" method="post"><input type="hidden" name="id" value="${lShow[2]}"><input type="submit" name="_action_delete" value="Delete"></form>`, flash));
      return send(res, 200, page("edit licence", `<form action="/ws/licence" method="post"><input type="hidden" name="id" value="${lShow[2]}"><input type="hidden" name="version" value="${l.version}">${licenceForm(l)}<input type="submit" name="_action_update" value="Update"><input type="submit" name="_action_delete" value="Delete"></form>`));
    }
    if (path === "/licence/save" && req.method === "POST") return licencePost();
    if (path === "/gbif/healthCheck") return send(res, 200, page("GBIF", `<table><tr><td>Records in ALA</td><td>Records indexed today</td><td>1000</td></tr><tr><td>Licence issues (i.e. not CC)</td><td>Data resources that can NOT be shared</td><td>2</td></tr></table>`));
    if (path === "/dataProvider/searchForOrganizations") return send(res, 200, page("orgs", `<table><thead><tr><th>Name</th><th></th></tr></thead><tbody><tr><td>Museo Nacional</td><td><a href="/dataProvider/importFromOrganization?organizationKey=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee&country=${url.searchParams.get("country")}">Import</a></td></tr></tbody></table>`));
    if (path === "/dataProvider/importFromOrganization") {
      add("dataProvider", { name: "Museo Nacional", gbifRegistryKey: url.searchParams.get("organizationKey") });
      return redirect(res, `/dataProvider/searchForOrganizations?country=ES`);
    }
    if (path === "/manage/repatriate") return send(res, 200, page("repat", `<form action="/manage/searchForRepatResources" method="post"><input type="hidden" name="configuration.guid" value="g1"><select name="adaptorString"><option value="au.org.ala.collectory.exception.GbifRepatDataSourceAdapter" selected>GBIF repat</option></select><input type="url" name="endpoint" value="https://api.gbif.org/v1/"><select name="country"><option value="AU">Australia</option><option value="ES">Spain</option></select><select name="recordType"><option value="OCCURRENCE">Occurrence</option></select><input name="name"><input name="description"><select name="dataProviderUid"><option value="">-</option></select><input type="number" name="maxNoOfDatasets" value="25"><input type="number" name="minRecordCount" value="10000"><input type="number" name="maxRecordCount" value="1000000"><input type="submit" name="performReview" value="Review"></form>`));
    if (path === "/manage/searchForRepatResources" && req.method === "POST") {
      const f = form();
      const rows = [
        { guid: "9a2f0000-0000-0000-0000-000000000001", name: `Herbarium of ${f.get("country")}`, uid: "", add: true },
        { guid: "9a2f0000-0000-0000-0000-000000000002", name: "Known dataset", uid: [...state.entities.values()].find((d) => d["guid"] === "9a2f0000-0000-0000-0000-000000000002")?.["uid"] ?? "", add: false },
      ];
      const trs = rows.map((r, i) => `<tr><td><input type="hidden" name="resources[${i}].uid" value="${r.uid}"><input type="hidden" name="resources[${i}].guid" value="${r.guid}"><input type="hidden" name="resources[${i}].source" value="GBIF"><input type="hidden" name="resources[${i}].country" value="${f.get("country")}"><input type="text" name="resources[${i}].name" value="${r.name}"></td><td><input type="hidden" name="_resources[${i}].addResource"><input type="checkbox" name="resources[${i}].addResource"${r.add ? " checked" : ""}></td><td><input type="hidden" name="_resources[${i}].updateMetadata"><input type="checkbox" name="resources[${i}].updateMetadata" checked></td><td><input type="hidden" name="_resources[${i}].updateConnection"><input type="checkbox" name="resources[${i}].updateConnection" checked></td></tr>`).join("");
      return send(res, 200, page("review", `<form action="/manage/updateFromExternalSources" method="post"><input type="hidden" name="loadGuid" value="lg-${Date.now()}"><input type="hidden" name="country" value="${f.get("country")}"><input type="hidden" name="username" value="gbifuser"><input type="hidden" name="password" value="gbif-api-pass"><table>${trs}</table><input type="submit" name="_action_updateFromExternalSources" value="Load"></form>`));
    }
    if (path === "/manage/updateFromExternalSources" && req.method === "POST") {
      const f = form();
      const names = [...f].filter(([k]) => /^resources\[\d+\]\.name$/.test(k)).map(([, v]) => v);
      state.loads.set(f.get("loadGuid")!, { names, polls: 0 });
      return redirect(res, `/manage/externalLoadStatus?loadGuid=${f.get("loadGuid")}`);
    }
    if (path === "/manage/externalLoadStatus") {
      const l = state.loads.get(url.searchParams.get("loadGuid") ?? "");
      if (!l) return send(res, 200, page("load", "<h1>No load -</h1>"));
      const done = l.polls++ >= 1;
      const rows = l.names.map((n, i) => `<tr class="prop"><td class="name">${n}</td><td class="name ${done ? "COMPLETED" : "DOWNLOADING"}"><span>${done ? "Completed" : "Downloading"}</span></td><td>${done ? `<a href="/dataResource/show/dr${90 + i}"> View </a>` : ""}</td></tr>`).join("");
      return send(res, 200, page("load", `<h1>${done ? "Finished" : "Automatically"} loading ${l.names.length} resources</h1><h3>Completed ${done ? "100.00" : "50.00"} %</h3><table>${rows}</table>`));
    }
    return send(res, 404, page("404", `fake: no page ${req.method} ${path}`));
  });

  function iptScan(dpUid: string, create: boolean, key: string) {
    const out: Json[] = [];
    const drs = [...state.entities.values()].filter((d) => d["entity"] === "dataResource" && d["dataProvider"] === dpUid);
    for (const it of state.ipt) {
      const dr = drs.find((d) => d["websiteUrl"] === it.link);
      if (dr) {
        dr["name"] = it.title;
        dr["pubDescription"] = it.description;
        out.push({ uid: dr["uid"], name: dr["name"], websiteUrl: dr["websiteUrl"] });
      } else if (create) {
        const n = add("dataResource", { name: it.title, websiteUrl: it.link, dataProvider: dpUid, resourceType: "records", connectionParameters: JSON.stringify({ protocol: "DwCA", url: it.dwca, automation: true, termsForUniqueKey: [key] }) });
        out.push({ uid: n["uid"], name: n["name"], websiteUrl: it.link });
      } else out.push({ uid: null, name: it.title, websiteUrl: it.link });
    }
    return out;
  }

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, state, add, dropSessions: () => sessions.clear(), close: () => new Promise<void>((r) => server.close(() => r())) };
}
