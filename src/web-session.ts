import * as cheerio from "cheerio";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * A browser-like login session for collectory's admin pages.
 *
 * Collectory's admin forms (/providerMap, /providerCode, /licence, the data hub members and record consumers pages)
 * have no web service and accept only a user with ROLE_EDITOR/ROLE_ADMIN (in 6.x a machine token's scopes are not
 * enough). So, like a person, this logs in through the portal's login (collectory -> auth server -> CAS login form
 * -> back to collectory) and keeps the cookies.
 */
export class WebSession {
  private jar = new Map<string, Map<string, string>>();
  private loggingIn?: Promise<void>;
  loggedIn = false;

  constructor(
    private readonly username: string,
    /** The password itself (deprecated COLLECTORY_PASSWORD) or where to read it from when it is needed (OS keyring / file). */
    private readonly password: string | (() => Promise<string | undefined>),
    private readonly fetchImpl: FetchLike = fetch,
    private readonly maxHops = 25,
  ) {}

  /** Cookie header for a URL (host-scoped, which is enough here). */
  cookieFor(url: string): string | undefined {
    const c = this.jar.get(new URL(url).host);
    return c && c.size ? [...c].map(([k, v]) => `${k}=${v}`).join("; ") : undefined;
  }

  store(url: string, res: Response) {
    const host = new URL(url).host;
    const cookies = res.headers.getSetCookie?.() ?? [];
    if (!cookies.length) return;
    const c = this.jar.get(host) ?? new Map<string, string>();
    for (const sc of cookies) {
      const [pair] = sc.split(";");
      const i = pair!.indexOf("=");
      if (i > 0) c.set(pair!.slice(0, i).trim(), pair!.slice(i + 1).trim());
    }
    this.jar.set(host, c);
  }

  /** Log in, starting from an admin page of collectory (one login at a time). */
  login(startUrl: string): Promise<void> {
    this.loggingIn ??= this.doLogin(startUrl).finally(() => (this.loggingIn = undefined));
    return this.loggingIn;
  }

  private async doLogin(startUrl: string): Promise<void> {
    this.loggedIn = false;
    let url = startUrl;
    let init: RequestInit = { method: "GET" };
    let submitted = false;
    for (let hop = 0; hop < this.maxHops; hop++) {
      const headers = new Headers(init.headers);
      headers.set("Accept", "text/html");
      const cookie = this.cookieFor(url);
      if (cookie) headers.set("Cookie", cookie);
      const res = await this.fetchImpl(url, { ...init, headers, redirect: "manual" });
      this.store(url, res);
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        url = new URL(res.headers.get("location")!, url).toString();
        init = { method: "GET" };
        continue;
      }
      const html = await res.text();
      const form = loginForm(html, url);
      if (form) {
        if (submitted) throw new Error(`login to ${new URL(url).host} was refused (wrong username or password?)`);
        const password = typeof this.password === "string" ? this.password : await this.password();
        if (!password) throw new Error(`no password stored for ${this.username}: run \`collectory-mcp set-password\` in a terminal (see README)`);
        form.fields.set(form.userField, this.username);
        form.fields.set(form.passwordField, password);
        url = form.action;
        init = { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams([...form.fields]) };
        submitted = true;
        continue;
      }
      if (res.ok && submitted && sameOrigin(url, startUrl)) {
        this.loggedIn = true;
        return;
      }
      const title = cheerio.load(html)("title").text().trim();
      throw new Error(`login did not reach collectory (stopped at ${new URL(url).origin}${new URL(url).pathname}, HTTP ${res.status}${title ? `, "${title}"` : ""})`);
    }
    throw new Error("login: too many redirects");
  }
}

function sameOrigin(a: string, b: string) {
  return new URL(a).origin === new URL(b).origin;
}

/** A login form: has a password input. Returns its action and all fields with their default values. */
function loginForm(html: string, pageUrl: string) {
  const $ = cheerio.load(html);
  const form = $("form").filter((_, f) => $(f).find('input[type="password"]').length > 0).first();
  if (!form.length) return undefined;
  const fields = new Map<string, string>();
  form.find("input[name]").each((_, el) => {
    const $el = $(el);
    const type = ($el.attr("type") ?? "text").toLowerCase();
    if ((type === "checkbox" || type === "radio") && $el.attr("checked") === undefined) return;
    if (type === "submit" && fields.has($el.attr("name")!)) return;
    fields.set($el.attr("name")!, $el.attr("value") ?? "");
  });
  const passwordField = form.find('input[type="password"]').first().attr("name") ?? "password";
  const userField = form.find('input[name="username"], input[type="email"], input[name="email"], input[type="text"]').first().attr("name") ?? "username";
  if (!fields.has("_eventId") && fields.has("execution")) fields.set("_eventId", "submit"); // CAS webflow
  return { action: new URL(form.attr("action") || pageUrl, pageUrl).toString(), fields, userField, passwordField };
}
