import type { Auth } from "./auth.ts";
import { noAuth } from "./auth.ts";
import type { WebSession } from "./web-session.ts";

export const ENTITIES = ["institution", "collection", "dataProvider", "dataResource", "dataHub", "tempDataResource"] as const;
export type Entity = (typeof ENTITIES)[number];

/** uid prefix of each entity (dr12, co3…), used to route a bare uid. */
export const PREFIX: Record<Entity, string> = { institution: "in", collection: "co", dataProvider: "dp", dataResource: "dr", dataHub: "dh", tempDataResource: "drt" };

export function entityOf(uid: string): Entity {
  const m = uid.match(/^([a-z]+)\d+$/);
  const e = m && (Object.entries(PREFIX).find(([, p]) => p === m[1])?.[0] as Entity | undefined);
  if (!e) throw new Error(`"${uid}" is not a collectory uid (in…, co…, dp…, dr…, dh…, drt…)`);
  return e;
}

export class CollectoryError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`collectory ${path} -> ${status}${status === 401 || status === 403 ? ` (${authHint(path)})` : ""}: ${body.slice(0, 500)}`);
  }
}

/** Where a request lands when it is not logged in (collectory's own /login, the auth server, CAS). */
const LOGIN_PATH = /\/(login|logout|callback|authorize)\b|oidc|oauth|\/cas\//i;

/** Pages behind @PermissionRequired(roles) only: a person's login, never a machine token. */
export const isAdminPage = (path: string) => !path.startsWith("/ws/");

function authHint(path: string) {
  return isAdminPage(path)
    ? "the admin pages need a person's login session with ROLE_EDITOR or ROLE_ADMIN (they ignore access tokens): set COLLECTORY_USERNAME and store the password with `collectory-mcp set-password`"
    : "the web services need COLLECTORY_TOKEN, or COLLECTORY_OIDC_* credentials whose token has ROLE_EDITOR/ROLE_ADMIN or the scope collectory requires (REQUIRED_SCOPES, default ala/internal); collectory 5.1.x needs COLLECTORY_API_KEY";
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Name the cause of a bare "fetch failed", and retry a GET once on it (never a write). */
export function withNetworkRetry(f: FetchLike, retries = 1): FetchLike {
  return async (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    for (let attempt = 0; ; attempt++) {
      try {
        return await f(input, init);
      } catch (e) {
        const network = e instanceof TypeError && e.message === "fetch failed";
        if (network && method === "GET" && attempt < retries) continue;
        if (!network) throw e;
        const c = (e as { cause?: { code?: string; message?: string } }).cause;
        const url = new URL(String(input instanceof Request ? input.url : input));
        throw new Error(`fetch failed for ${url.origin}${url.pathname}${c ? `: ${[c.code, c.message].filter(Boolean).join(" ")}` : ""}`, { cause: e });
      }
    }
  };
}

export interface ClientOptions {
  auth?: Auth;
  /** Browser-like login for the admin pages. */
  session?: WebSession;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export interface RawOptions {
  method?: string;
  json?: unknown;
  form?: URLSearchParams;
  accept?: string;
  /** Send credentials: true always, "optional" only when configured and without starting a login. */
  user?: boolean | "optional";
  /** Also send the login session on a web service (5.x checks the session's role on some of them). */
  withSession?: boolean;
}

export interface SaveResult {
  status: number;
  uid?: string;
  message: string;
}

export interface Version {
  version: string;
  major: number;
  minor: number;
}

/** collectory over HTTP: the web services under /ws, and the admin pages (forms) for what has no web service. */
export class CollectoryClient {
  readonly ws: string;
  private readonly auth: Auth;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private version_?: Promise<Version>;

  constructor(
    readonly baseUrl: string,
    private readonly opts: ClientOptions = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.ws = `${this.baseUrl}/ws`;
    this.auth = opts.auth ?? noAuth;
    this.fetchImpl = withNetworkRetry(opts.fetch ?? fetch);
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  get hasSession() {
    return !!this.opts.session;
  }
  get authDescription() {
    return this.auth.describe;
  }

  /** Version of the collectory behind baseUrl, from its OpenAPI document (5.1.x and 6.x publish one). */
  version(): Promise<Version> {
    this.version_ ??= (async () => {
      const spec = await this.json<{ info?: { version?: string } }>("/openapi/openapi.json").catch(() => undefined);
      const v = spec?.info?.version ?? (await this.buildInfoVersion());
      const [major, minor] = v.split(/[.-]/).map(Number);
      return { version: v, major: major ?? 0, minor: minor ?? 0 };
    })().catch((e) => {
      this.version_ = undefined;
      throw e;
    });
    return this.version_;
  }

  private async buildInfoVersion(): Promise<string> {
    const html = await this.text("/buildInfo", { accept: "text/html" });
    const m = html.replace(/<[^>]+>/g, " ").match(/app\.version\s+([0-9][\w.-]*)/i) ?? html.match(/version\D{0,40}(\d+\.\d+\.\d+[\w-]*)/i);
    if (!m) throw new Error(`cannot tell the collectory version at ${this.baseUrl} (no /openapi/openapi.json, no version in /buildInfo)`);
    return m[1]!;
  }

  // ---------------- web services ----------------

  list(entity: Entity, filters: Record<string, string> = {}): Promise<Array<{ name: string; uid: string; uri?: string }>> {
    const q = new URLSearchParams(filters).toString();
    return this.json(`/ws/${entity}${q ? `?${q}` : ""}`);
  }

  /** One entity. Credentials go along when configured: without them collectory strips connectionParameters.url. */
  get<T = Record<string, unknown>>(uid: string, entity: Entity = entityOf(uid)): Promise<T> {
    return this.json(`/ws/${entity}/${encodeURIComponent(uid)}`, { user: "optional" });
  }

  /** Several entities in one call (POST /ws/find/{entity}). collectory answers an array of JSON *strings* (#253). */
  async find(entity: Entity, uids: string[]): Promise<unknown[]> {
    const out = await this.json<unknown[]>(`/ws/find/${entity}`, { method: "POST", json: uids, user: "optional" });
    return out.map((x) => (typeof x === "string" ? JSON.parse(x) : x));
  }

  count(entity: Entity, groupBy?: string): Promise<unknown> {
    return this.json(`/ws/${entity}/count${groupBy ? `/${encodeURIComponent(groupBy)}` : ""}`);
  }

  /** Insert (no uid) or partial update (uid): POST /ws/{entity}[/{uid}]. The new uid comes back in Location. */
  async save(entity: Entity, uid: string | undefined, body: Record<string, unknown>): Promise<SaveResult> {
    const path = `/ws/${entity}${uid ? `/${encodeURIComponent(uid)}` : ""}`;
    const res = await this.raw(path, { method: "POST", json: body, user: true, accept: "*/*" });
    const text = await res.text();
    if (!res.ok) throw new CollectoryError(path, res.status, text);
    const loc = res.headers.get("location");
    return { status: res.status, uid: uid ?? loc?.match(/\/([a-z]+\d+)\/?$/)?.[1], message: text.trim() };
  }

  async delete(uid: string): Promise<string> {
    const path = `/ws/${entityOf(uid)}/${encodeURIComponent(uid)}`;
    return this.text(path, { method: "DELETE", user: true });
  }

  /** Contacts linked to an entity (public ones, in 6.x). */
  contactsFor(uid: string): Promise<Array<Record<string, unknown>>> {
    return this.json(`/ws/${entityOf(uid)}/${encodeURIComponent(uid)}/contacts`);
  }

  async contactByEmail(email: string): Promise<Record<string, unknown> | undefined> {
    const res = await this.raw(`/ws/contacts/email/${encodeURIComponent(email)}`, { user: "optional" });
    if (res.status === 404) return undefined;
    const text = await res.text();
    if (!res.ok) throw new CollectoryError("/ws/contacts/email/…", res.status, text);
    return text.trim() ? (JSON.parse(text) as Record<string, unknown>) : undefined;
  }

  /** Create (no id) or update a contact. */
  saveContact(id: number | undefined, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.json(`/ws/contacts${id ? `/${id}` : ""}`, { method: "POST", json: body, user: true });
  }

  /** Link a contact to an entity (or update the link): POST /ws/{entity}/{uid}/contacts/{contactId}. */
  async linkContact(uid: string, contactId: number, body: Record<string, unknown>): Promise<string> {
    return this.text(`/ws/${entityOf(uid)}/${encodeURIComponent(uid)}/contacts/${contactId}`, { method: "POST", json: body, user: true });
  }

  unlinkContact(uid: string, contactId: number): Promise<string> {
    return this.text(`/ws/${entityOf(uid)}/${encodeURIComponent(uid)}/contacts/${contactId}`, { method: "DELETE", user: true });
  }

  /** institutionCode/collectionCode -> collection (or institution), as biocache/pipelines resolve it. */
  async lookupCodes(institutionCode: string, collectionCode: string): Promise<Record<string, unknown>> {
    return this.json(`/ws/lookup/inst/${encodeURIComponent(institutionCode)}/coll/${encodeURIComponent(collectionCode)}`);
  }

  /** Every code mapping (GET /ws/codeMapDump, CSV). */
  async codeMap(): Promise<Array<Record<string, string>>> {
    return parseCsv(await this.text("/ws/codeMapDump", { accept: "text/csv,*/*" }));
  }

  licences(): Promise<Array<{ name: string; url?: string }>> {
    return this.json("/ws/licence");
  }

  /** IPT scan of a data provider (GET /ws/ipt/scan/{dp}). It updates the metadata and contacts of existing resources. */
  iptScan(dpUid: string, o: { create?: boolean; check?: boolean; key?: string; isShareableWithGBIF?: boolean; withSession?: boolean } = {}): Promise<unknown[]> {
    const q = new URLSearchParams();
    if (o.create) q.set("create", "true");
    if (o.check === false) q.set("check", "false");
    if (o.key) q.set("key", o.key);
    if (o.isShareableWithGBIF === false) q.set("isShareableWithGBIF", "false");
    return this.json(`/ws/ipt/scan/${encodeURIComponent(dpUid)}.json${q.size ? `?${q}` : ""}`, { user: true, withSession: o.withSession });
  }

  /** Repatriation check of a data provider's resources against GBIF; reloads the stale ones (GET /ws/gbif/scan/{dp}). */
  gbifScan(dpUid: string): Promise<Record<string, unknown>> {
    return this.json(`/ws/gbif/scan/${encodeURIComponent(dpUid)}`, { user: true });
  }

  /** Push every data provider and its resources to the GBIF registry (GET /ws/syncGBIF). */
  syncGbif(): Promise<Record<string, unknown>> {
    return this.json("/ws/syncGBIF", { user: true });
  }

  // ---------------- admin pages ----------------

  /** An admin page (HTML) as the logged-in person. */
  async page(path: string, hops = 0): Promise<{ url: string; html: string }> {
    if (hops > 10) throw new CollectoryError(path, 508, "too many redirects");
    const res = await this.raw(path, { accept: "text/html", user: true });
    const url = this.baseUrl + path;
    if (res.status >= 300 && res.status < 400) {
      const loc = new URL(res.headers.get("location") ?? "/", url);
      if (!loc.toString().startsWith(this.baseUrl + "/") || LOGIN_PATH.test(loc.pathname)) throw new CollectoryError(path, 401, `redirected to ${loc.origin}${loc.pathname} (not logged in)`);
      // 6.x PermissionInterceptor sends a caller without the role to the public map.
      if (/\/public\/map$/.test(loc.pathname)) throw new CollectoryError(path, 403, "collectory sent the request to its public map: these credentials are not a person with ROLE_EDITOR/ROLE_ADMIN");
      return this.page(loc.toString().slice(this.baseUrl.length), hops + 1);
    }
    const html = await res.text();
    if (!res.ok) throw new CollectoryError(path, res.status, html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    return { url, html };
  }

  /** Post a form as the logged-in person and follow the redirect to the page it lands on. */
  async submit(action: string, body: URLSearchParams): Promise<{ url: string; status: number; html: string }> {
    const abs = new URL(action, this.baseUrl + "/").toString();
    if (!abs.startsWith(this.baseUrl + "/")) throw new Error(`refusing to post a form to ${new URL(abs).origin}: it is not collectory (${this.baseUrl})`);
    const path = abs.slice(this.baseUrl.length);
    const res = await this.raw(path, { method: "POST", form: body, accept: "text/html", user: true });
    if (res.status >= 300 && res.status < 400) {
      const loc = new URL(res.headers.get("location") ?? "/", this.baseUrl + path);
      if (!loc.toString().startsWith(this.baseUrl)) throw new CollectoryError(path, 401, `redirected to ${loc.origin}${loc.pathname} (not logged in)`);
      if (/\/public\/map$/.test(loc.pathname)) throw new CollectoryError(path, 403, "collectory sent the request to its public map: these credentials are not a person with ROLE_EDITOR/ROLE_ADMIN");
      // The POST was accepted (Grails redirects after saving). The page it lands on can still fail to render (5.1.1's
      // show pages do without biocache): report it, and let the caller verify through the web service.
      const landed = await this.page(loc.toString().slice(this.baseUrl.length)).catch((e: Error) => {
        if (e instanceof CollectoryError && e.status >= 500) return { url: loc.toString(), html: "" };
        throw e;
      });
      return { url: landed.url, status: res.status, html: landed.html };
    }
    const html = await res.text();
    if (!res.ok) throw new CollectoryError(path, res.status, html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    return { url: this.baseUrl + path, status: res.status, html };
  }

  /** Fetch something outside collectory (an IPT RSS feed, the GBIF API) for previews. */
  async external(url: string, accept = "application/json"): Promise<string> {
    const res = await this.fetchImpl(url, { headers: { Accept: accept }, signal: AbortSignal.timeout(this.timeoutMs) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${new URL(url).origin}${new URL(url).pathname} -> ${res.status}: ${text.slice(0, 300)}`);
    return text;
  }

  // ---------------- plumbing ----------------

  async raw(path: string, o: RawOptions = {}): Promise<Response> {
    const url = this.baseUrl + path;
    const session = isAdminPage(path) || o.withSession ? this.opts.session : undefined;
    const send = async () => {
      const headers: Record<string, string> = { Accept: o.accept ?? "application/json" };
      // Admin pages with a session configured use the session: tokens are ignored there anyway.
      if (o.user && (!session || o.withSession)) Object.assign(headers, await this.auth.headers({ interactive: o.user === true }).catch((e) => (o.user === true ? Promise.reject(e) : {})));
      const cookie = o.user ? session?.cookieFor(url) : undefined;
      if (cookie) headers["Cookie"] = cookie;
      let body: BodyInit | undefined;
      if (o.json !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(o.json);
      } else if (o.form) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        body = o.form;
      }
      const res = await this.fetchImpl(url, { method: o.method ?? "GET", headers, body, redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs) });
      if (o.user) session?.store(url, res);
      return res;
    };
    const res = await send();
    if (o.user && session && this.needsLogin(res)) {
      await session.login(`${this.baseUrl}/manage/list`);
      return send();
    }
    return res;
  }

  /** 401/403, or a redirect away from collectory or to a login page. */
  private needsLogin(res: Response): boolean {
    if (res.status === 401 || res.status === 403) return true;
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!loc) return false;
    const to = new URL(loc, this.baseUrl);
    return !to.toString().startsWith(this.baseUrl + "/") || LOGIN_PATH.test(to.pathname);
  }

  async json<T>(path: string, o: RawOptions = {}): Promise<T> {
    const res = await this.raw(path, o);
    const text = await res.text();
    if (!res.ok) throw new CollectoryError(path, res.status, text);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CollectoryError(path, res.status, `expected JSON, got: ${text.slice(0, 200)}`);
    }
  }

  async text(path: string, o: RawOptions = {}): Promise<string> {
    const res = await this.raw(path, { accept: "*/*", ...o });
    const text = await res.text();
    if (!res.ok) throw new CollectoryError(path, res.status, text);
    return text;
  }
}

/** Minimal RFC 4180 CSV (quoted fields, doubled quotes, CRLF) into objects keyed by the header row. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(field), (field = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field), rows.push(row), (row = []), (field = "");
    } else field += c;
  }
  if (field || row.length) row.push(field), rows.push(row);
  const [head, ...body] = rows.filter((r) => r.some((x) => x.trim()));
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}
