import { AsyncLocalStorage } from "node:async_hooks";
import type { OidcConfig } from "./config.ts";

/**
 * Where the credentials for collectory's web services come from.
 *
 * collectory 6.x checks @PermissionRequired(roles, scopes) on each action (PermissionInterceptor): a Bearer JWT of a
 * user with ROLE_EDITOR/ROLE_ADMIN, or of a client whose scopes include REQUIRED_SCOPES ("ala/internal" by default).
 * collectory 5.1.x checks a legacy ALA API key instead (COLLECTORY_API_KEY).
 * - HTTP transport: the token the MCP client sent to us (per request, never stored);
 * - stdio: COLLECTORY_TOKEN, or a token from the OIDC client credentials / password grant, cached until it expires.
 */
export interface Auth {
  /**
   * Headers for an authenticated call, or {} when no credentials are configured. With interactive:false (public
   * reads, health checks) an auth that would have to ask the user to log in sends nothing instead.
   */
  headers(o?: { interactive?: boolean }): Promise<Record<string, string>>;
  readonly describe: string;
}

/** Calls made inside nonInteractive.run(true, …) never start a login (collectory_health). */
export const nonInteractive = new AsyncLocalStorage<boolean>();

export const noAuth: Auth = { headers: async () => ({}), describe: "none (public endpoints only)" };

export const staticToken = (token: string): Auth => ({ headers: async () => ({ Authorization: `Bearer ${token}` }), describe: "COLLECTORY_TOKEN" });

/** Token of the MCP request being served (HTTP transport). */
export const requestToken = new AsyncLocalStorage<string>();
export const forwardedToken = (fallback: Auth = noAuth): Auth => ({
  headers: async () => {
    const t = requestToken.getStore();
    return t ? { Authorization: `Bearer ${t}` } : fallback.headers();
  },
  describe: "the caller's own bearer token",
});

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class OidcAuth implements Auth {
  private cached?: { token: string; expires: number };
  private tokenUrl?: string;
  readonly describe: string;

  constructor(
    private readonly cfg: OidcConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.describe = cfg.username ? `OIDC password grant as ${cfg.username}` : "OIDC client credentials (web services only: the admin pages need a person)";
  }

  async headers(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.token()}` };
  }

  async token(): Promise<string> {
    if (this.cached && this.cached.expires > Date.now() + 30_000) return this.cached.token;
    const url = await this.endpoint();
    const form = new URLSearchParams({ scope: this.cfg.scope });
    if (this.cfg.username && this.cfg.password) {
      form.set("grant_type", "password");
      form.set("username", this.cfg.username);
      form.set("password", this.cfg.password);
    } else {
      form.set("grant_type", "client_credentials");
    }
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
    if (this.cfg.clientSecret) headers["Authorization"] = `Basic ${Buffer.from(`${encodeURIComponent(this.cfg.clientId)}:${encodeURIComponent(this.cfg.clientSecret)}`).toString("base64")}`;
    else form.set("client_id", this.cfg.clientId);
    const res = await this.fetchImpl(url, { method: "POST", headers, body: form });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) throw new Error(`OIDC token request failed (${res.status}): ${body.error_description ?? body.error ?? "no access_token"}`);
    this.cached = { token: body.access_token, expires: Date.now() + (body.expires_in ?? 300) * 1000 };
    return body.access_token;
  }

  private async endpoint(): Promise<string> {
    if (this.cfg.tokenUrl) return this.cfg.tokenUrl;
    if (this.tokenUrl) return this.tokenUrl;
    const res = await this.fetchImpl(`${this.cfg.issuer!.replace(/\/+$/, "")}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error(`OIDC discovery failed (${res.status}) for ${this.cfg.issuer}`);
    const d = (await res.json()) as { token_endpoint?: string };
    if (!d.token_endpoint) throw new Error(`OIDC discovery for ${this.cfg.issuer} has no token_endpoint`);
    return (this.tokenUrl = d.token_endpoint);
  }
}

/** Legacy API key of collectory 5.1.x: sent the ways 5.1.x reads it (Authorization header and apiKey header). */
export const apiKeyAuth = (key: string): Auth => ({ headers: async () => ({ Authorization: key, apiKey: key }), describe: "COLLECTORY_API_KEY (legacy)" });
