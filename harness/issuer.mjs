// A throw-away OIDC provider for the integration tests (never expose it):
// - discovery + JWKS: collectory validates Bearer JWTs with them;
// - GET /mint?scope=…&roles=…&username=…: tokens for the tests (machine: scope ala/internal; person: username + roles);
// - authorize (a login form, like CAS) -> code -> token/userinfo: the browser login collectory's admin pages need.
//   Accounts: USERS env, "email:password:ROLE_A,ROLE_B;…".
import { createServer } from "node:http";
import { createPrivateKey, createPublicKey, createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const ISSUER = (process.env.ISSUER ?? "http://localhost:4000").replace(/\/+$/, "");
const PORT = Number(process.env.PORT ?? 4000);
const USERS = new Map((process.env.USERS ?? "admin@example.org:admin-pass:ROLE_ADMIN,ROLE_EDITOR;editor@example.org:editor-pass:ROLE_EDITOR").split(";").map((u) => u.split(":")).map(([e, p, r]) => [e, { password: p, roles: (r ?? "").split(",").filter(Boolean) }]));
// The key survives a restart of the container (collectory caches the JWKS it read at boot).
const KEY_FILE = process.env.KEY_FILE ?? "/tmp/ci-issuer-key.pem";
const privateKey = existsSync(KEY_FILE) ? createPrivateKey(readFileSync(KEY_FILE)) : generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
if (!existsSync(KEY_FILE)) writeFileSync(KEY_FILE, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
const publicKey = createPublicKey(privateKey);
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "ci", use: "sig", alg: "RS256" };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const codes = new Map();
const IPT = [
  { r: "herbario", key: "0e1a9c4e-0000-4000-8000-000000000001", title: "CI Herbarium", description: "Specimens of the CI herbarium" },
  { r: "aves", key: "0e1a9c4e-0000-4000-8000-000000000002", title: "CI Birds", description: "Bird observations" },
];
const access = new Map();

function sign(claims) {
  const now = Math.floor(Date.now() / 1000);
  const all = { iss: ISSUER, jti: randomUUID(), iat: now, nbf: now, exp: now + 3600, ...claims };
  const head = b64({ alg: "RS256", typ: "JWT", kid: "ci" });
  const body = b64(all);
  return `${head}.${body}.${createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey).toString("base64url")}`;
}
const person = (email, roles) => ({ sub: email, username: email, email, email_verified: true, given_name: "CI", family_name: email.split("@")[0], name: `CI ${email}`, role: roles, roles, "cognito:groups": roles });

function mint(q) {
  const roles = (q.get("roles") ?? "").split(",").filter(Boolean);
  const claims = { sub: q.get("sub") ?? q.get("username") ?? "ci-client", client_id: "ci", scope: q.get("scope") ?? "" };
  if (q.get("username")) Object.assign(claims, person(q.get("username"), roles));
  else if (roles.length) Object.assign(claims, { role: roles, roles, "cognito:groups": roles });
  return sign(claims);
}

const page = (body) => `<!doctype html><html><head><title>CI login</title></head><body>${body}</body></html>`;
const form = (q, error = "") => page(`${error ? `<p class="error">${error}</p>` : ""}<form method="post" action="${ISSUER}/authorize">${[...q].map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v).replace(/"/g, "&quot;")}">`).join("")}<input type="text" name="username"><input type="password" name="password"><input type="submit" name="submit" value="Login"></form>`);

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", ISSUER);
  const json = (o, s = 200) => res.writeHead(s, { "Content-Type": "application/json" }).end(JSON.stringify(o));
  if (url.pathname.endsWith("/.well-known/openid-configuration") || url.pathname.endsWith("/.well-known"))
    return json({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks`, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, userinfo_endpoint: `${ISSUER}/userinfo`, end_session_endpoint: `${ISSUER}/logout`, subject_types_supported: ["public"], response_types_supported: ["code"], id_token_signing_alg_values_supported: ["RS256"], token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"], scopes_supported: ["openid", "profile", "email", "roles", "ala", "ala/internal"], claims_supported: ["sub", "email", "role"] });
  if (url.pathname === "/jwks") return json({ keys: [jwk] });
  if (url.pathname === "/mint") return res.writeHead(200, { "Content-Type": "text/plain" }).end(mint(url.searchParams));
  if (url.pathname === "/authorize" && req.method === "GET") return res.writeHead(200, { "Content-Type": "text/html" }).end(form(url.searchParams));
  if (url.pathname === "/authorize" && req.method === "POST") {
    const f = await body(req);
    const user = USERS.get(f.get("username") ?? "");
    const q = new URLSearchParams([...f].filter(([k]) => !["username", "password", "submit"].includes(k)));
    if (!user || user.password !== f.get("password")) return res.writeHead(200, { "Content-Type": "text/html" }).end(form(q, "Invalid credentials"));
    const code = randomUUID();
    codes.set(code, { email: f.get("username"), roles: user.roles, nonce: f.get("nonce"), clientId: f.get("client_id") });
    const back = new URL(f.get("redirect_uri"));
    back.searchParams.set("code", code);
    if (f.get("state")) back.searchParams.set("state", f.get("state"));
    return res.writeHead(302, { Location: back.toString() }).end();
  }
  if (url.pathname === "/token" && req.method === "POST") {
    const f = await body(req);
    const c = codes.get(f.get("code") ?? "");
    if (!c) return json({ error: "invalid_grant" }, 400);
    codes.delete(f.get("code"));
    const at = sign({ ...person(c.email, c.roles), client_id: c.clientId, scope: "openid profile email roles" });
    access.set(at, c);
    const idt = sign({ ...person(c.email, c.roles), aud: c.clientId, ...(c.nonce ? { nonce: c.nonce } : {}) });
    return json({ access_token: at, id_token: idt, token_type: "Bearer", expires_in: 3600 });
  }
  if (url.pathname === "/userinfo") {
    const t = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const c = access.get(t);
    return c ? json(person(c.email, c.roles)) : json({ error: "invalid_token" }, 401);
  }
  if (url.pathname === "/logout") return res.writeHead(200).end("bye");
  // A minimal IPT (rss.do + eml.do) for the IPT scan tests: two datasets.
  if (url.pathname === "/ipt/rss.do") {
    const items = IPT.map((d) => `<item><title>${d.title}</title><link>${ISSUER}/ipt/resource?r=${d.r}</link><description>${d.description}</description><pubDate>Mon, 05 Oct 2026 10:00:00 GMT</pubDate><guid isPermaLink="false">${d.key}/v1.0</guid><ipt:eml>${ISSUER}/ipt/eml.do?r=${d.r}</ipt:eml><ipt:dwca>${ISSUER}/ipt/archive.do?r=${d.r}</ipt:dwca></item>`).join("");
    return res.writeHead(200, { "Content-Type": "application/rss+xml" }).end(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:ipt="http://ipt.gbif.org/"><channel><title>CI IPT</title><link>${ISSUER}/ipt</link><description>CI</description>${items}</channel></rss>`);
  }
  if (url.pathname === "/ipt/eml.do") {
    const d = IPT.find((x) => x.r === url.searchParams.get("r"));
    if (!d) return res.writeHead(404).end();
    return res.writeHead(200, { "Content-Type": "text/xml" }).end(`<?xml version="1.0" encoding="UTF-8"?><eml:eml xmlns:eml="https://eml.ecoinformatics.org/eml-2.2.0" packageId="${d.key}/v1.0" system="http://gbif.org" xml:lang="eng"><dataset><title xml:lang="eng">${d.title}</title><creator><individualName><givenName>Ana</givenName><surName>Ci</surName></individualName><electronicMailAddress>ana.ci@example.org</electronicMailAddress></creator><pubDate>2026-10-05</pubDate><language>eng</language><abstract><para>${d.description}</para></abstract><intellectualRights><para>This work is licensed under a <ulink url="http://creativecommons.org/licenses/by/4.0/legalcode"><citetitle>Creative Commons Attribution (CC-BY 4.0) License</citetitle></ulink>.</para></intellectualRights><contact><individualName><givenName>Ana</givenName><surName>Ci</surName></individualName><electronicMailAddress>ana.ci@example.org</electronicMailAddress></contact></dataset></eml:eml>`);
  }
  if (url.pathname.startsWith("/biocache")) return res.writeHead(404).end();
  res.writeHead(404).end();
}).listen(PORT, "127.0.0.1", () => console.error(`fake issuer ${ISSUER} on :${PORT}`));
