#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { apiKeyAuth, noAuth, OidcAuth, staticToken, type Auth } from "./auth.ts";
import { CollectoryClient } from "./collectory-client.ts";
import { loadConfig, secretsOf, type Config } from "./config.ts";
import { createServer } from "./server.ts";
import { openTokenStore, passwordKey } from "./token-store.ts";
import { WebSession } from "./web-session.ts";

export function authFor(config: Config): Auth {
  if (config.token) return staticToken(config.token);
  if (config.oidc) return new OidcAuth(config.oidc);
  if (config.apiKey) return apiKeyAuth(config.apiKey);
  return noAuth;
}

/** Web session for the admin pages: the password comes from the deprecated env var, else from the keyring/file. */
export function sessionFor(config: Config): WebSession | undefined {
  const login = config.login;
  if (!login) return undefined;
  const store = () => openTokenStore(passwordKey(config.url, login.username), config.tokenStore);
  return new WebSession(login.username, login.password ?? (async () => (await store()).load()));
}

export function clientFor(config: Config, auth: Auth = authFor(config)): CollectoryClient {
  return new CollectoryClient(config.url, { auth, session: sessionFor(config), timeoutMs: config.timeoutMs });
}

export async function main() {
  // stdout carries JSON-RPC: anything else must go to stderr.
  console.log = console.error;
  const config = loadConfig();
  const auth = authFor(config);
  const server = createServer({ client: clientFor(config, auth), config, secrets: secretsOf(config) });
  await server.connect(new StdioServerTransport());
  if (config.login?.password) console.error("collectory-mcp: COLLECTORY_PASSWORD is deprecated (it sits in plain text in the MCP config): store it with `collectory-mcp set-password` and remove it from the config");
  console.error(`collectory-mcp (POC) on stdio -> ${config.url} (auth: ${auth.describe}${config.login ? `, admin pages as ${config.login.username}` : ""}${config.readonly ? ", read-only" : ""})`);
}

/**
 * Terminal commands, run by the person (never by the assistant):
 *   collectory-mcp set-password | forget-password   password of COLLECTORY_USERNAME for the admin pages, typed with echo off
 */
export async function cli(cmd: string, config: Config = loadConfig(process.argv.slice(3))): Promise<number> {
  const username = config.login?.username;
  if (!username) throw new Error("set COLLECTORY_USERNAME (the portal account) first");
  const store = await openTokenStore(passwordKey(config.url, username), config.tokenStore);
  const where = new URL(config.url).origin;
  if (cmd === "forget-password") {
    await store.clear();
    console.error(`forgot the password of ${username} for ${where}`);
    return 0;
  }
  const password = await readHidden(`password of ${username} for ${where}: `);
  if (!password) throw new Error("empty password: nothing stored");
  await store.save(password);
  console.error(`stored in ${store.describe}`);
  return 0;
}

/** A line from the terminal without echoing it. */
function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new Error("set-password needs an interactive terminal");
  process.stderr.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      err ? reject(err) : resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

const COMMANDS = ["set-password", "forget-password"];

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/collectory-mcp")) {
  const cmd = process.argv[2];
  (cmd && COMMANDS.includes(cmd) ? cli(cmd).then((code) => process.exit(code)) : main()).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
