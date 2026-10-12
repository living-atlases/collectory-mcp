import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Where secrets live between runs (the OIDC refresh token; the deprecated admin password): never in the MCP client's
 * config. The OS keyring (Secret Service, macOS Keychain, Windows Credential Manager) when there is one, else a 0600
 * file in the user's config dir. The access token is only kept in memory.
 */
export interface TokenStore {
  load(): Promise<string | undefined>;
  save(secret: string): Promise<void>;
  clear(): Promise<void>;
  readonly describe: string;
}

const SERVICE = "collectory-mcp";

/** One entry per issuer + client id (the same IdP can serve several portals with different clients). */
export const storeKey = (issuer: string, clientId: string) => `${issuer.replace(/\/+$/, "")}#${clientId}`;
/** The admin password for the web-session fallback, per portal and user. */
export const passwordKey = (collectoryUrl: string, username: string) => `password#${new URL(collectoryUrl).origin}#${username}`;

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") return join(env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"), SERVICE);
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", SERVICE);
  return join(env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), SERVICE);
}

export class FileStore implements TokenStore {
  readonly path: string;
  readonly describe: string;
  constructor(key: string, dir = configDir()) {
    this.path = join(dir, "tokens", `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);
    this.describe = `file ${this.path} (mode 0600)`;
  }
  async load() {
    try {
      return (JSON.parse(readFileSync(this.path, "utf8")) as { secret?: string }).secret;
    } catch {
      return undefined;
    }
  }
  async save(secret: string) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify({ secret }), { mode: 0o600 });
    chmodSync(this.path, 0o600); // writeFileSync keeps the mode of an existing file
  }
  async clear() {
    rmSync(this.path, { force: true });
  }
}

interface KeyringEntry {
  getPassword(): string | null | undefined;
  setPassword(v: string): void;
  deletePassword(): boolean | void;
}
type EntryCtor = new (service: string, account: string) => KeyringEntry;

export class KeyringStore implements TokenStore {
  readonly describe = "OS keyring";
  private constructor(private readonly entry: KeyringEntry) {}

  /** The keyring, if the optional native module loads and the OS has a usable one (a headless Linux often has not). */
  static async open(key: string, load: () => Promise<EntryCtor> = loadKeyring): Promise<KeyringStore | undefined> {
    try {
      const entry = new (await load())(SERVICE, key);
      entry.getPassword(); // throws when there is no Secret Service / keychain to talk to
      return new KeyringStore(entry);
    } catch {
      return undefined;
    }
  }
  async load() {
    return this.entry.getPassword() ?? undefined;
  }
  async save(secret: string) {
    this.entry.setPassword(secret);
  }
  async clear() {
    try {
      this.entry.deletePassword();
    } catch {
      // nothing stored
    }
  }
}

async function loadKeyring(): Promise<EntryCtor> {
  const mod = "@napi-rs/keyring"; // optional dependency: not a static import, so its absence is not an error
  return ((await import(mod)) as { Entry: EntryCtor }).Entry;
}

/** COLLECTORY_TOKEN_STORE: "keyring" (default: keyring, else file) or "file". */
export async function openTokenStore(key: string, mode: "auto" | "keyring" | "file" = "auto"): Promise<TokenStore> {
  if (mode !== "file") {
    const k = await KeyringStore.open(key);
    if (k) return k;
    if (mode === "keyring") throw new Error("COLLECTORY_TOKEN_STORE=keyring but no OS keyring is available (install @napi-rs/keyring and a Secret Service such as gnome-keyring)");
  }
  return new FileStore(key);
}
