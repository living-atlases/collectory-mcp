/**
 * Configuration from command-line flags and environment variables (flags win).
 *
 *   --collectory <url> | COLLECTORY_URL   collectory base URL, without /ws (default https://collections.l-a.site)
 *   COLLECTORY_READONLY=1                  refuse every write (dry runs still work)
 *
 *   Web services (/ws writes, IPT and GBIF scans):
 *   COLLECTORY_TOKEN                       a Bearer JWT: a user with ROLE_EDITOR/ROLE_ADMIN, or a client with the
 *                                          scope collectory expects (REQUIRED_SCOPES, default "ala/internal") (6.x)
 *   COLLECTORY_OIDC_ISSUER or COLLECTORY_OIDC_TOKEN_URL, COLLECTORY_OIDC_CLIENT_ID, COLLECTORY_OIDC_CLIENT_SECRET,
 *   COLLECTORY_OIDC_USERNAME, COLLECTORY_OIDC_PASSWORD, COLLECTORY_OIDC_SCOPE
 *                                          client credentials (or password) grant; the token is cached and renewed (6.x)
 *   COLLECTORY_API_KEY                     legacy ALA API key (5.1.x)
 *
 *   Admin pages (forms with no web service: data hub institutions/collections, record consumers, licences, GBIF
 *   registration, repatriation); they accept only a person with ROLE_EDITOR/ROLE_ADMIN:
 *   COLLECTORY_USERNAME                    portal account; its password is read from the OS keyring / 0600 file
 *                                          (store it with `collectory-mcp set-password`), never from the MCP config
 *   COLLECTORY_PASSWORD                    deprecated: the password in plain text
 *   COLLECTORY_TOKEN_STORE                 "auto" (OS keyring, else a 0600 file), "keyring", "file"
 *
 *   COLLECTORY_GBIF_API                    GBIF API used to preview GBIF scans (default https://api.gbif.org/v1)
 *   COLLECTORY_TIMEOUT_MS                  per-request HTTP timeout (default 120000)
 *   PORT / HOST                            HTTP transport only (default 127.0.0.1:3921)
 */
export interface OidcConfig {
  issuer?: string;
  tokenUrl?: string;
  clientId: string;
  clientSecret?: string;
  username?: string;
  password?: string;
  scope: string;
}

export interface Config {
  url: string;
  readonly: boolean;
  token?: string;
  oidc?: OidcConfig;
  apiKey?: string;
  login?: { username: string; password?: string };
  tokenStore: "auto" | "keyring" | "file";
  gbifApi: string;
  timeoutMs: number;
}

export function loadConfig(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Config {
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const url = (flag("collectory") ?? env["COLLECTORY_URL"] ?? "https://collections.l-a.site").replace(/\/+$/, "").replace(/\/ws$/, "");
  const clientId = env["COLLECTORY_OIDC_CLIENT_ID"];
  const oidc: OidcConfig | undefined = clientId
    ? {
        issuer: env["COLLECTORY_OIDC_ISSUER"],
        tokenUrl: env["COLLECTORY_OIDC_TOKEN_URL"],
        clientId,
        clientSecret: env["COLLECTORY_OIDC_CLIENT_SECRET"],
        username: env["COLLECTORY_OIDC_USERNAME"],
        password: env["COLLECTORY_OIDC_PASSWORD"],
        scope: env["COLLECTORY_OIDC_SCOPE"] ?? "openid profile email roles ala ala/internal",
      }
    : undefined;
  if (oidc && !oidc.issuer && !oidc.tokenUrl) throw new Error("COLLECTORY_OIDC_CLIENT_ID is set but neither COLLECTORY_OIDC_ISSUER nor COLLECTORY_OIDC_TOKEN_URL is");
  const username = env["COLLECTORY_USERNAME"];
  return {
    url,
    readonly: /^(1|true|yes)$/i.test(env["COLLECTORY_READONLY"] ?? "") || argv.includes("--readonly"),
    token: env["COLLECTORY_TOKEN"] || undefined,
    oidc,
    apiKey: env["COLLECTORY_API_KEY"] || undefined,
    login: username ? { username, password: env["COLLECTORY_PASSWORD"] || undefined } : undefined,
    tokenStore: oneOf(env, "COLLECTORY_TOKEN_STORE", ["auto", "keyring", "file"] as const, "auto"),
    gbifApi: (env["COLLECTORY_GBIF_API"] ?? "https://api.gbif.org/v1").replace(/\/+$/, ""),
    timeoutMs: Number(env["COLLECTORY_TIMEOUT_MS"] ?? 120_000),
  };
}

/** Values that must never reach the model. */
export const secretsOf = (c: Config) => [c.token, c.apiKey, c.oidc?.clientSecret, c.oidc?.password, c.login?.password];

function oneOf<T extends string>(env: NodeJS.ProcessEnv, name: string, allowed: readonly T[], def: T): T {
  const v = (env[name] || def) as T;
  if (!allowed.includes(v)) throw new Error(`${name} must be one of ${allowed.join(", ")}`);
  return v;
}
