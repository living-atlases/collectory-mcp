import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { noAuth, staticToken } from "../../src/auth.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeZip } from "../../src/zip.ts";
import { CollectoryClient } from "../../src/collectory-client.ts";
import { createServer } from "../../src/server.ts";
import { WebSession } from "../../src/web-session.ts";

/**
 * Against a real, disposable collectory (harness/up.sh): COLLECTORY_TEST_URL=http://localhost:8080 and
 * COLLECTORY_TEST_MINT=http://localhost:4000/mint (the fake issuer, which mints the JWTs collectory accepts).
 * Without COLLECTORY_TEST_MINT only the anonymous checks run (e.g. against the public LA demo).
 */
const URL_ = process.env["COLLECTORY_TEST_URL"];
const MINT = process.env["COLLECTORY_TEST_MINT"];
/** A person with ROLE_ADMIN for the admin pages (the harness issuer's account by default). */
const [LOGIN_USER, LOGIN_PASS] = (process.env["COLLECTORY_TEST_LOGIN"] ?? "admin@example.org:admin-pass").split(":");
const stamp = Date.now().toString(36);
/** Major version of the collectory under test (5.x and 6.x differ in a few places, noted where they do). */
let major = 6;

async function token(q: Record<string, string>) {
  const res = await fetch(`${MINT}?${new URLSearchParams(q)}`);
  assert.equal(res.status, 200);
  return res.text();
}

async function connect(tok?: string, login = false) {
  const session = login ? new WebSession(LOGIN_USER!, LOGIN_PASS!) : undefined;
  const client = new CollectoryClient(URL_!, { auth: tok ? staticToken(tok) : noAuth, session, timeoutMs: 60_000 });
  const server = createServer({ client, config: { readonly: false, gbifApi: "https://api.gbif.org/v1" }, localFiles: true, secrets: [tok, LOGIN_PASS] });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const mcp = new Client({ name: "it", version: "0" });
  await mcp.connect(b);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await mcp.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })) as { isError?: boolean; content: Array<{ text: string }> };
    const text = r.content[0]!.text;
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {}
    return { isError: !!r.isError, text, json };
  };
}

describe("real collectory: anonymous", { skip: !URL_ && "COLLECTORY_TEST_URL not set" }, () => {
  it("health tells the version and that anonymous callers cannot write", async () => {
    const call = await connect();
    const h = (await call("collectory_health")).json;
    assert.match(h.version.version, /^\d+\.\d+/);
    assert.equal(h.webServices.ok, true, JSON.stringify(h));
    assert.equal(h.webServiceWrites.ok, false);
  });

  it("refuses an anonymous write with a credentials hint and changes nothing", async () => {
    const call = await connect();
    const r = await call("collectory_save_entity", { entity: "institution", fields: { name: `mcp-it-anon-${stamp}` }, dryRun: false, confirm: true });
    assert.equal(r.isError, true);
    // 401 (5.1.x), 403 (6.3+), 500 (6.0.x fails in its JWT check before refusing)
    assert.match(r.text, /-> (401|403|500)/);
    const l = await call("collectory_list", { entity: "institution", filters: { name: `mcp-it-anon-${stamp}` } });
    assert.equal(l.json.count, 0);
  });
});

describe("real collectory: writes with JWTs from the test issuer", { skip: (!URL_ || !MINT) && "COLLECTORY_TEST_URL/COLLECTORY_TEST_MINT not set" }, () => {
  let m2m: Awaited<ReturnType<typeof connect>>;
  let editor: Awaited<ReturnType<typeof connect>>;
  let admin: Awaited<ReturnType<typeof connect>>;
  let userToken: Awaited<ReturnType<typeof connect>>;
  const made: string[] = [];

  before(async () => {
    m2m = await connect(await token({ scope: "ala/internal" }));
    major = Number(((await m2m("collectory_health")).json?.version?.version ?? "6").split(".")[0]);
    editor = await connect(await token({ scope: "openid", username: "editor@example.org", roles: "ROLE_EDITOR" }));
    admin = await connect(await token({ scope: "ala/internal" }), true);
    userToken = await connect(await token({ scope: "openid", username: "admin@example.org", roles: "ROLE_ADMIN,ROLE_EDITOR" }));
  });
  after(async () => {
    for (const uid of made.reverse()) await m2m("collectory_delete_entity", { uid, force: true, confirm: true, dryRun: false });
  });

  const create = async (entity: string, fields: Record<string, unknown>) => {
    const r = await m2m("collectory_save_entity", { entity, fields, dryRun: false, confirm: true });
    assert.equal(r.isError, false, r.text);
    made.push(r.json.uid);
    return r.json.uid as string;
  };

  it("a machine token (scope ala/internal) passes the web services", async () => {
    const h = (await m2m("collectory_health")).json;
    assert.equal(h.webServiceWrites.ok, true, JSON.stringify(h));
  });

  it("creates, updates and verifies entities; rejects bad URLs before sending", async () => {
    const inst = await create("institution", { name: `mcp-it institution ${stamp}`, websiteUrl: "https://example.org" });
    const co = await create("collection", { name: `mcp-it collection ${stamp}`, institution: { uid: inst } });
    const u = await m2m("collectory_save_entity", { uid: co, fields: { pubShortDescription: "Short", keywords: ["a", "b"] }, dryRun: false, confirm: true });
    assert.equal(u.isError, false, u.text);
    assert.equal(u.json.notApplied, undefined, u.text);
    const bad = await m2m("collectory_save_entity", { uid: co, fields: { websiteUrl: "example.org" }, dryRun: false, confirm: true });
    assert.match(bad.text, /must start with http/);
  });

  it("maps institution/collection codes, merges a second change, and the lookup resolves them", async () => {
    const co = await create("collection", { name: `mcp-it mapped ${stamp}` });
    const code = `MCPIT${stamp}`.toUpperCase();
    const s = await m2m("collectory_set_code_mapping", { collectionUid: co, institutionCodes: { add: [code] }, collectionCodes: { add: ["A"] }, dryRun: false, confirm: true });
    assert.equal(s.json?.verified, true, s.text);
    const s2 = await m2m("collectory_set_code_mapping", { collectionUid: co, collectionCodes: { add: ["B"] }, dryRun: false, confirm: true });
    assert.equal(s2.json?.verified, true, s2.text);
    const look = await m2m("collectory_lookup_codes", { institutionCode: code, collectionCode: "A" });
    assert.equal(look.json.uid, co, look.text);
    const other = await create("collection", { name: `mcp-it other ${stamp}` });
    const c = await m2m("collectory_set_code_mapping", { collectionUid: other, institutionCodes: { add: [code] }, collectionCodes: { add: ["B"] }, dryRun: false, confirm: true });
    assert.match(c.text, new RegExp(`${code}/B -> ${co}`));
  });

  it("a mapping that matches any collection code is a conflict although /ws/codeMapDump leaves it out", async () => {
    const code = `MCPANY${stamp}`.toUpperCase();
    const any = await create("collection", { name: `mcp-it any ${stamp}` });
    const s = await m2m("collectory_set_code_mapping", { collectionUid: any, institutionCodes: { add: [code] }, matchAnyCollectionCode: true, dryRun: false, confirm: true });
    assert.equal(s.json?.verified, true, s.text);
    const dump = (await m2m("collectory_code_map", { filter: any })).json;
    assert.deepEqual(dump.mappings.map((m: any) => [m.uid, m.matchAny]), [[any, true]]);
    const other = await create("collection", { name: `mcp-it any other ${stamp}` });
    const c = await m2m("collectory_set_code_mapping", { collectionUid: other, institutionCodes: { add: [code.toLowerCase()] }, collectionCodes: { add: ["Z"] }, dryRun: false, confirm: true });
    assert.match(c.text, new RegExp(`${code.toLowerCase()}/Z -> ${any}`));
    const look = await m2m("collectory_lookup_codes", { institutionCode: code.toLowerCase(), collectionCode: "Z" });
    assert.equal(look.json.uid, any, "collectory compares codes case-insensitively: " + look.text);
  });

  it("data resource connection parameters: merge keeps the url; the editor (no ROLE_ADMIN) cannot see it and is refused", async () => {
    const dp = await create("dataProvider", { name: `mcp-it provider ${stamp}` });
    const dr = await create("dataResource", { name: `mcp-it resource ${stamp}`, resourceType: "records", dataProvider: { uid: dp }, connectionParameters: { protocol: "DwCA", url: "https://example.org/dwca.zip", termsForUniqueKey: ["occurrenceID"] } });
    const s = await m2m("collectory_set_connection_parameters", { uid: dr, set: { incremental: true }, dryRun: false, confirm: true });
    assert.equal(s.json?.verified, true, s.text);
    const g = (await m2m("collectory_get", { uids: [dr] })).json;
    assert.equal(g.connectionParameters.url, "https://example.org/dwca.zip");
    assert.equal(g.connectionParameters.incremental, true);
    const e = await editor("collectory_set_connection_parameters", { uid: dr, set: { incremental: false }, dryRun: false, confirm: true });
    if (major >= 6) assert.match(e.text, /did not return the url|403/, e.text);
    // Whatever the editor could do, the url must survive.
    assert.equal((await m2m("collectory_get", { uids: [dr] })).json.connectionParameters.url, "https://example.org/dwca.zip");
  });

  it("hub members: data resources by web service; institutions/collections by the admin form with a person's login", async () => {
    const dr = await create("dataResource", { name: `mcp-it hub member ${stamp}`, resourceType: "records" });
    const co = await create("collection", { name: `mcp-it hub collection ${stamp}` });
    const hub = await create("dataHub", { name: `mcp-it hub ${stamp}` });
    const s = await m2m("collectory_set_hub_members", { hubUid: hub, dataResources: { add: [dr] }, dryRun: false, confirm: true });
    assert.equal(s.json?.verified, true, s.text);
    const machineOnForm = await m2m("collectory_set_hub_members", { hubUid: hub, collections: { add: [co] }, dryRun: false, confirm: true });
    assert.equal(machineOnForm.isError, true, "a machine token must not pass the admin form");
    // 6.3.0 admin pages ignore Bearer tokens, even a person's with ROLE_ADMIN. Either way the MCP must be truthful:
    // refused with the login hint today, verified if collectory starts accepting them.
    const userJwtOnForm = await userToken("collectory_set_hub_members", { hubUid: hub, collections: { add: [co] }, dryRun: false, confirm: true });
    if (userJwtOnForm.isError) assert.match(userJwtOnForm.text, /login session|not logged in/);
    else assert.equal(userJwtOnForm.json?.verified, true, userJwtOnForm.text);
    const f = await admin("collectory_set_hub_members", { hubUid: hub, collections: { add: [co] }, dryRun: false, confirm: true });
    assert.equal(f.json?.verified, true, f.text);
    const h = (await m2m("collectory_get", { uids: [hub] })).json;
    assert.deepEqual(h.memberDataResources.map((m: any) => m.uid), [dr], "the data resources posted back by the form are kept");
  });

  it("contacts: created once by email and linked, the link updated, then unlinked", async () => {
    const co = await create("collection", { name: `mcp-it contacts ${stamp}` });
    const email = `mcp-it-${stamp}@example.org`;
    const r = await m2m("collectory_add_contact", { uid: co, email, firstName: "Ana", role: "Curator", publish: true, notify: true, dryRun: false, confirm: true });
    assert.equal(r.json?.verified, true, r.text);
    const l = (await m2m("collectory_contacts", { uid: co })).json;
    assert.ok(l.contacts.some((x: any) => x.email === email), JSON.stringify(l));
    const u = await m2m("collectory_update_contact", { uid: co, email, role: "Director", administrator: true, primaryContact: true, dryRun: false, confirm: true });
    assert.equal(u.json?.verified, true, u.text);
    const rm = await m2m("collectory_remove_contact", { uid: co, email, confirm: true });
    assert.equal(rm.json?.removed, true, rm.text);
  });

  it("contacts: an unpublished contact is seen with a login; without one, the web service hides it (#193)", async () => {
    const co = await create("collection", { name: `mcp-it hidden contact ${stamp}` });
    const email = `mcp-it-hidden-${stamp}@example.org`;
    const a = await admin("collectory_add_contact", { uid: co, email, lastName: "Hidden", role: "Curator", dryRun: false, confirm: true });
    assert.equal(a.json?.verified, true, a.text);
    const all = (await admin("collectory_contacts", { uid: co })).json;
    assert.deepEqual(all.contacts.map((c: any) => [c.email, c.publish]), [[email, false]], JSON.stringify(all));
    const ws = (await m2m("collectory_contacts", { uid: co })).json;
    assert.deepEqual(ws.contacts, [], "5.1.1 and 6.3.0 list only published contacts (#193)");
    assert.match(ws.note, /#193/);
  });

  it("delete checks what still refers to the entity", async () => {
    const dr = await create("dataResource", { name: `mcp-it delete ${stamp}`, resourceType: "records" });
    const hub = await create("dataHub", { name: `mcp-it delete hub ${stamp}` });
    await m2m("collectory_set_hub_members", { hubUid: hub, dataResources: { add: [dr] }, dryRun: false, confirm: true });
    const refused = await m2m("collectory_delete_entity", { uid: dr, confirm: true });
    assert.match(refused.text, /still referenced/);
    await m2m("collectory_set_hub_members", { hubUid: hub, dataResources: { remove: [dr] }, dryRun: false, confirm: true });
    const ok = await m2m("collectory_delete_entity", { uid: dr, confirm: true });
    if (major >= 6) {
      assert.equal(ok.json?.deleted, true, ok.text);
      made.splice(made.indexOf(dr), 1);
    } else {
      // 5.x answers "deleted" without flushing (#287): the MCP must say it did not happen.
      assert.equal(ok.json?.deleted, false, ok.text);
      assert.match(ok.json.warning, /#287/);
    }
  });

  it("admin pages accept a person's Bearer token (pending upstream: 6.3.0 needs a login session)", { todo: true }, async () => {
    const hub = await create("dataHub", { name: `mcp-it todo hub ${stamp}` });
    const co = await create("collection", { name: `mcp-it todo collection ${stamp}` });
    const r = await userToken("collectory_set_hub_members", { hubUid: hub, collections: { add: [co] }, dryRun: false, confirm: true });
    assert.equal(r.json?.verified, true, r.text);
  });

  it("health with a person's login reports the admin pages as usable", async () => {
    const h = (await admin("collectory_health")).json;
    assert.equal(h.adminPages.ok, true, JSON.stringify(h.adminPages));
  });

  it("record consumers through the admin form", async () => {
    const co = await create("collection", { name: `mcp-it consumer ${stamp}` });
    const dr = await create("dataResource", { name: `mcp-it consumer dr ${stamp}`, resourceType: "records" });
    const r = await admin("collectory_set_record_consumers", { uid: dr, source: "co", add: [co], dryRun: false, confirm: true });
    assert.equal(r.json?.verified, true, r.text);
  });

  // The harness issuer also serves a two-dataset IPT at <issuer>/ipt (rss.do, eml.do).
  const IPT = MINT ? new URL("/ipt", MINT).toString() : "";

  it("IPT: the preview matches the feed without writing; the scan updates the matched resource from its EML", async () => {
    const dp = await create("dataProvider", { name: `mcp-it IPT ${stamp}`, websiteUrl: IPT });
    const dr = await create("dataResource", { name: `mcp-it before scan ${stamp}`, resourceType: "records", dataProvider: { uid: dp }, websiteUrl: `${IPT}/resource?r=herbario` });
    const p = await m2m("collectory_ipt_preview", { dpUid: dp });
    assert.equal(p.json?.datasetsInIpt, 2, p.text);
    assert.equal(p.json.updated[0].uid, dr);
    assert.equal(p.json.new[0].title, "CI Birds");
    assert.equal((await m2m("collectory_get", { uids: [dr] })).json.name, `mcp-it before scan ${stamp}`, "the preview writes nothing");
    const s = await m2m("collectory_ipt_scan", { dpUid: dp, dryRun: false, confirm: true });
    assert.equal(s.isError, false, s.text);
    const name = (await m2m("collectory_get", { uids: [dr] })).json.name;
    if (major >= 6) assert.equal(name, "CI Herbarium", "the real scan rewrote the name from the IPT");
    else {
      assert.equal(name, `mcp-it before scan ${stamp}`, "5.x only reports without create");
      assert.match(s.json.note, /only reports/);
    }
  });

  it("IPT: create:true needs a person's login (6.3: provider page; 5.x: web service + session) and uses the given key", async () => {
    const dp = await create("dataProvider", { name: `mcp-it IPT create ${stamp}`, websiteUrl: IPT });
    const noLogin = await m2m("collectory_ipt_scan", { dpUid: dp, create: true, key: "occurrenceID", dryRun: false, confirm: true });
    assert.match(noLogin.text, /person's login/);
    const s = await admin("collectory_ipt_scan", { dpUid: dp, create: true, key: "occurrenceID", dryRun: false, confirm: true });
    assert.equal(s.isError, false, s.text);
    const drs = (await m2m("collectory_get", { uids: [dp] })).json.dataResources as Array<{ uid: string }>;
    assert.equal(drs.length, 2, JSON.stringify(drs));
    made.push(...drs.map((d) => d.uid));
    const created = (await m2m("collectory_get", { uids: [drs[0]!.uid] })).json;
    assert.deepEqual(created.connectionParameters.termsForUniqueKey, ["occurrenceID"]);
  });

  it("mapping check (Data mappings wiki): codes of the GBIF dataset, mapped through the MCP, then consumers", async () => {
    const dr = await create("dataResource", { name: `mcp-it mapping check ${stamp}`, resourceType: "records", guid: "a8adde1c-1d66-4ad0-846f-cdf59fc4cb0f" });
    const first = (await m2m("collectory_mapping_check", { uids: [dr] })).json.resources[0];
    assert.equal(first.codesFrom, "gbif", JSON.stringify(first));
    const pair = first.pairs.find((p: any) => p.institutionCode && p.collectionCode);
    assert.ok(pair, JSON.stringify(first.pairs));
    // another run of the suite against the same collectory may have mapped it already
    if (pair.verdict === "unmapped") {
      const co = await create("collection", { name: `mcp-it mapping check ${stamp}` });
      const s = await m2m("collectory_set_code_mapping", { collectionUid: co, institutionCodes: { add: [pair.institutionCode] }, collectionCodes: { add: [pair.collectionCode] }, dryRun: false, confirm: true });
      assert.equal(s.json?.verified, true, s.text);
    }
    const second = (await m2m("collectory_mapping_check", { uids: [dr] })).json.resources[0];
    const now = second.pairs.find((p: any) => p.institutionCode === pair.institutionCode && p.collectionCode === pair.collectionCode);
    assert.equal(now.verdict, "ok", JSON.stringify(now));
    assert.match(second.warnings.join("\n"), new RegExp(`${now.resolvesTo} receive records but are not record consumers`));
    const c = await admin("collectory_set_record_consumers", { uid: dr, source: "co", add: [now.resolvesTo], dryRun: false, confirm: true });
    assert.equal(c.json?.verified, true, c.text);
    const third = (await m2m("collectory_mapping_check", { uids: [dr] })).json.resources[0];
    assert.ok(!third.warnings.join().includes(`${now.resolvesTo} receive records`), JSON.stringify(third.warnings));
  });

  it("data file upload keeps the connection parameters; contacts as each version treats them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collectory-mcp-it-"));
    const file = join(dir, "a.zip");
    const meta = `<archive xmlns="http://rs.tdwg.org/dwc/text/"><core rowType="http://rs.tdwg.org/dwc/terms/Occurrence"><files><location>occurrence.txt</location></files><id index="0"/><field index="1" term="http://rs.tdwg.org/dwc/terms/catalogNumber"/></core></archive>`;
    const kept = `kept-${stamp}@example.org`;
    const other = `other-${stamp}@example.org`;
    const eml = `<eml:eml xmlns:eml="eml://ecoinformatics.org/eml-2.1.1" packageId="mcp-it-${stamp}"><dataset><title>mcp-it uploaded ${stamp}</title><contact><individualName><givenName>Kept</givenName><surName>K${stamp}</surName></individualName><electronicMailAddress>${kept}</electronicMailAddress></contact></dataset></eml:eml>`;
    writeFileSync(file, writeZip({ "meta.xml": meta, "eml.xml": eml, "occurrence.txt": "id\tcatalogNumber\n1\tA1\n" }, { deflate: true }));
    const dr = await create("dataResource", { name: `mcp-it upload ${stamp}`, resourceType: "records", pubDescription: "before", connectionParameters: { protocol: "DwCA", url: "https://example.org/a.zip", termsForUniqueKey: ["catalogNumber"], incremental: true } });
    for (const [email, first, last] of [[kept, "Kept", `K${stamp}`], [other, "Other", `O${stamp}`]]) {
      const c = await m2m("collectory_add_contact", { uid: dr, email, firstName: first, lastName: last, role: "Curator", publish: true, dryRun: false, confirm: true });
      assert.equal(c.json?.verified, true, c.text);
    }
    const p = await admin("collectory_upload_data_file", { uid: dr, file });
    if (major >= 6) assert.match(p.json.errors.join(), new RegExp(`unlink 1 contacts.*${other}`), p.text);
    else assert.deepEqual(p.json.errors, [], p.text);
    const u = await admin("collectory_upload_data_file", { uid: dr, file, ...(major >= 6 ? { contacts: "accept" } : {}), dryRun: false, confirm: true });
    assert.equal(u.json?.verified, true, u.text);
    assert.equal(u.json.connectionParameters.now.incremental, true, "incremental kept (#307)");
    assert.deepEqual(u.json.connectionParameters.now.termsForUniqueKey, ["catalogNumber"]);
    assert.equal(u.json.metadataNow.name, `mcp-it uploaded ${stamp}`, "the EML overwrites the name");
    assert.deepEqual([...u.json.contacts.after].sort(), major >= 6 ? [kept] : [kept, other].sort());
    // a field the EML lacks: 6.x clears it, 5.x keeps it
    const after = (await m2m("collectory_get", { uids: [dr] })).json;
    if (major >= 6) assert.equal(after.pubDescription ?? "", "");
    else assert.equal(after.pubDescription, "before", "5.x sets only the fields the EML has");
  });

  it("EML check: the EML collectory renders, against the GBIF EML profile from rs.gbif.org", async () => {
    const bare = await create("dataResource", { name: `mcp-it eml ${stamp}`, resourceType: "records" });
    const box = await create("dataResource", { name: `mcp-it eml box ${stamp}`, resourceType: "records", geographicDescription: "G", westBoundingCoordinate: "-10" });
    const r = await m2m("collectory_eml_check", { uids: [bare, box] });
    assert.equal(r.isError, false, r.text);
    const [b, x] = r.json.resources;
    assert.equal(b.gbif.source, "not-registered", JSON.stringify(b));
    assert.ok(b.problems.some((p: any) => p.severity === "warning" && p.element === "dataset/contact"), JSON.stringify(b.problems));
    if (major >= 6) assert.equal(b.valid, true, JSON.stringify(b.problems));
    else {
      assert.equal(b.valid, false);
      assert.match(b.problems.find((p: any) => p.element === "eml").fix, /packageId: upgrade/);
      assert.match(r.json.collectory, /#303/);
    }
    // 6.3.0 leaves coverage empty, 5.1.1 writes the missing coordinates empty
    assert.ok(x.problems.some((p: any) => p.severity === "error" && p.element.startsWith("dataset/coverage") && /bounding coordinates/.test(p.fix)), JSON.stringify(x.problems));
  });

  it("GBIF: preview compares with the real GBIF API; repatriation search and organisations read GBIF through collectory", async () => {
    const dp = await create("dataProvider", { name: `mcp-it GBIF ${stamp}` });
    await create("dataResource", { name: `mcp-it Flora d'Andorra ${stamp}`, resourceType: "records", dataProvider: { uid: dp }, guid: "a8adde1c-1d66-4ad0-846f-cdf59fc4cb0f" });
    const p = await m2m("collectory_gbif_preview", { dpUid: dp });
    assert.equal(p.isError, false, p.text);
    assert.match(p.json.resources[0].status, /IN_SYNC|WOULD_RELOAD/);
    const r = await admin("collectory_repatriation_search", { country: "AD", maxDatasets: 5, minRecordCount: 0 });
    assert.equal(r.isError, false, r.text);
    assert.ok(Array.isArray(r.json.candidates), r.text);
    assert.ok(!r.text.includes(LOGIN_PASS!));
    const o = await admin("collectory_gbif_organizations", { country: "AD" });
    assert.equal(o.isError, false, o.text);
  });

  it("licences: create, update by acronym + version, refuse a near-duplicate, delete", async () => {
    const acronym = `MCP-IT-${stamp}`.toUpperCase();
    const url = `https://example.org/licences/${stamp}`;
    const c = await admin("collectory_save_licence", { acronym, licenceVersion: "1.0", name: "CI licence", url, dryRun: false, confirm: true });
    assert.equal(c.json?.verified, true, c.text);
    const u = await admin("collectory_save_licence", { acronym, licenceVersion: "1.0", name: "CI licence, renamed", url, dryRun: false, confirm: true });
    assert.equal(u.json?.action, "update", u.text);
    assert.equal(u.json?.verified, true, u.text);
    const dup = await admin("collectory_save_licence", { acronym, licenceVersion: "1.x", name: "CI licence again", url, dryRun: false, confirm: true });
    assert.match(dup.text, /#289/);
    const d = await admin("collectory_delete_licence", { acronym, licenceVersion: "1.0", confirm: true });
    assert.equal(d.json?.deleted, true, d.text);
  });

  it("audit runs over the whole registry", async () => {
    const a = await m2m("collectory_audit", { limit: 200 });
    assert.equal(a.isError, false, a.text);
    assert.ok(Array.isArray(a.json.findings));
  });
});
