import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { noAuth, staticToken } from "../src/auth.ts";
import { CollectoryClient } from "../src/collectory-client.ts";
import { createServer } from "../src/server.ts";
import { WebSession } from "../src/web-session.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeZip } from "../src/zip.ts";
import { ADMIN_LOGIN, startFakeCollectory, USER_LOGIN } from "./helpers/fake-collectory.ts";

type Fake = Awaited<ReturnType<typeof startFakeCollectory>>;

async function connect(fake: Fake, o: { token?: string; login?: boolean | typeof USER_LOGIN; readonly?: boolean; secrets?: string[]; index?: boolean; remote?: boolean } = {}) {
  const account = o.login === true ? ADMIN_LOGIN : o.login || undefined;
  const client = new CollectoryClient(fake.base, { auth: o.token ? staticToken(o.token) : noAuth, session: account ? new WebSession(account.username, account.password) : undefined });
  const server = createServer({ client, config: { readonly: !!o.readonly, gbifApi: `${fake.base}/gbif/v1`, biocacheApi: o.index ? `${fake.base}/biocache` : undefined }, localFiles: !o.remote, secrets: o.secrets ?? [ADMIN_LOGIN.password, o.token] });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const mcp = new Client({ name: "test", version: "0" });
  await mcp.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    const text = r.content[0]!.text;
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { isError: !!r.isError, text, json };
  };
  return { mcp, call };
}

/** A small registry: an IPT provider with one resource, a collection, a hub. */
function seed(fake: Fake) {
  fake.add("institution", { uid: "in1", name: "Museo de Ciencias" });
  fake.add("collection", { uid: "co1", name: "Herbario MA", institution: "in1" });
  fake.add("collection", { uid: "co2", name: "Entomología" });
  fake.add("dataProvider", { uid: "dp1", name: "IPT GBIF.ES", websiteUrl: `${fake.base}/ipt` });
  fake.add("dataResource", { uid: "dr1", name: "Old name", dataProvider: "dp1", resourceType: "records", status: "dataAvailable", licenseType: "CC-BY", websiteUrl: `${fake.base}/ipt/resource?r=herbario`, guid: "9a2f0000-0000-0000-0000-000000000002", lastUpdated: "2024-01-01T00:00:00Z", connectionParameters: JSON.stringify({ protocol: "DwCA", url: "https://ipt.example.org/archive.do?r=herbario", termsForUniqueKey: ["occurrenceID"], incremental: false }) });
  fake.add("dataResource", { uid: "dr2", name: "No unique terms", dataProvider: "dp1", resourceType: "records", connectionParameters: JSON.stringify({ protocol: "DwCA", url: "https://x/a.zip" }) });
  fake.add("dataHub", { uid: "dh1", name: "Hub 1", memberDataResources: JSON.stringify(["dr1"]) });
  fake.state.providerMaps.set("co2", { institutionCodes: ["MNCN"], collectionCodes: ["ENT"], exact: true, matchAnyCollectionCode: false });
  fake.state.ipt.push(
    { title: "Herbario MA (v2)", link: `${fake.base}/ipt/resource?r=herbario`, description: "new description", pubDate: "Mon, 05 Oct 2026 10:00:00 GMT", dwca: `${fake.base}/ipt/archive.do?r=herbario`, guid: "aaaa1111-0000-0000-0000-000000000000/v2" },
    { title: "Brand new dataset", link: `${fake.base}/ipt/resource?r=nuevo`, description: "", pubDate: "Mon, 05 Oct 2026 10:00:00 GMT", dwca: `${fake.base}/ipt/archive.do?r=nuevo`, guid: `${fake.base}/ipt/resource?r=nuevo` },
  );
  fake.state.gbif.set("9a2f0000-0000-0000-0000-000000000002", { pubDate: "2026-09-01T00:00:00.000+00:00" });
}

describe("collectory-mcp over MCP against a fake collectory 6.3.0", () => {
  let fake: Fake;
  before(async () => (fake = await startFakeCollectory()));
  after(() => fake.close());
  beforeEach(() => {
    fake.state.entities.clear();
    fake.state.providerMaps.clear();
    fake.state.legacyMaps = [];
    fake.state.index = [];
    fake.state.gbifOccurrences = [];
    fake.state.ipt.length = 0;
    fake.state.requests.length = 0;
    fake.state.contacts.clear();
    fake.state.links.length = 0;
    fake.state.hubCache = undefined;
    fake.state.licences = new Map([[1, { name: "Creative Commons Attribution", acronym: "CC-BY", licenceVersion: "4.0", url: "https://creativecommons.org/licenses/by/4.0/", version: 0 }]]);
    seed(fake);
  });

  it("lists tools with annotations, marks every write and gives writes a dry run or confirm", async () => {
    const { mcp } = await connect(fake);
    const { tools } = await mcp.listTools();
    assert.ok(tools.length >= 25);
    for (const t of tools) {
      const props = Object.keys((t.inputSchema as { properties?: object }).properties ?? {});
      if (t.annotations?.readOnlyHint) assert.ok(!t.description!.includes("[changes collectory]"), t.name);
      else {
        assert.ok(t.description!.endsWith("[changes collectory]"), t.name);
        assert.ok(props.includes("confirm"), `${t.name} has no confirm`);
      }
    }
    assert.equal(tools.find((t) => t.name === "collectory_delete_entity")!.annotations!.destructiveHint, true);
  });

  it("health reports version, and that a machine token passes web services but not admin pages", async () => {
    const { call } = await connect(fake, { token: "m2m-token" });
    const h = (await call("collectory_health")).json;
    assert.equal(h.version.version, "6.3.0");
    assert.equal(h.webServiceWrites.ok, true);
    assert.equal(h.adminPages.configured, false);
    const anon = (await (await connect(fake)).call("collectory_health")).json;
    assert.equal(anon.webServiceWrites.ok, false);
  });

  it("save_entity previews field changes without writing, then saves and verifies", async () => {
    const { call } = await connect(fake, { token: "m2m-token" });
    const p = await call("collectory_save_entity", { uid: "dr1", fields: { citation: "Cite me", licenseType: "CC-BY" } });
    assert.equal(p.json.dryRun, true);
    assert.deepEqual(p.json.changes, [{ field: "citation", from: null, to: "Cite me" }]);
    assert.ok(!fake.state.requests.some((r) => r.method === "POST"), "a dry run must not write");
    const s = await call("collectory_save_entity", { uid: "dr1", fields: { citation: "Cite me" }, dryRun: false, confirm: true });
    assert.equal(s.isError, false, s.text);
    assert.equal(fake.state.entities.get("dr1")!["citation"], "Cite me");
    assert.equal(s.json.notApplied, undefined);
  });

  it("save_entity refuses fields the web service ignores and values collectory rejects, before sending", async () => {
    const { call } = await connect(fake, { token: "m2m-token" });
    const r = await call("collectory_save_entity", { uid: "co1", fields: { memberInstitutions: "[]", websiteUrl: "www.example.org", pubShortDescription: "x".repeat(101) } });
    assert.equal(r.isError, true);
    assert.match(r.text, /memberInstitutions cannot be written.*collectory_set_hub_members/);
    assert.match(r.text, /websiteUrl must start with http/);
    assert.match(r.text, /pubShortDescription is 101 characters/);
    const m = await call("collectory_save_entity", { uid: "co1", fields: { recordsMapping: { institutionCodes: ["X"] } } });
    assert.match(m.text, /collectory_set_code_mapping/);
  });

  it("save_entity creates a collection with the coordinates collectory requires", async () => {
    const { call } = await connect(fake, { token: "m2m-token" });
    const r = await call("collectory_save_entity", { entity: "collection", fields: { name: "Nueva colección" }, dryRun: false, confirm: true });
    assert.equal(r.isError, false, r.text);
    assert.equal(fake.state.entities.get(r.json.uid)!["southCoordinate"], -1);
  });

  it("save_entity creates an entity and reads the new uid from Location", async () => {
    const { call } = await connect(fake, { token: "m2m-token" });
    const r = await call("collectory_save_entity", { entity: "institution", fields: { name: "Nuevo Museo", websiteUrl: "https://museo.example.org" }, dryRun: false, confirm: true });
    assert.equal(r.isError, false, r.text);
    assert.match(r.json.uid, /^in\d+$/);
    assert.equal(fake.state.entities.get(r.json.uid)!["name"], "Nuevo Museo");
  });

  it("writes need confirm and are refused in read-only mode (dry runs still work)", async () => {
    const { call } = await connect(fake, { token: "m2m-token", readonly: true });
    const no = await call("collectory_save_entity", { uid: "dr1", fields: { citation: "x" }, dryRun: false });
    assert.match(no.text, /read-only/);
    assert.equal((await call("collectory_save_entity", { uid: "dr1", fields: { citation: "x" } })).json.dryRun, true);
    const { call: c2 } = await connect(fake, { token: "m2m-token" });
    assert.match((await c2("collectory_save_entity", { uid: "dr1", fields: { citation: "x" }, dryRun: false })).text, /needs confirm:true/);
  });

  it("anonymous writes report the credentials needed", async () => {
    const { call } = await connect(fake);
    const r = await call("collectory_save_entity", { uid: "dr1", fields: { citation: "x" }, dryRun: false, confirm: true });
    assert.equal(r.isError, true);
    assert.match(r.text, /403.*COLLECTORY_TOKEN/s);
  });

  it("code mapping merges with the current codes, flags conflicts with other collections, and verifies by lookup", async () => {
    const { call } = await connect(fake, { token: "m2m-token" });
    const p = await call("collectory_set_code_mapping", { collectionUid: "co1", institutionCodes: { add: ["MA"] }, collectionCodes: { add: ["MA", "MA-BRIO"] } });
    assert.equal(p.json.dryRun, true);
    assert.deepEqual(p.json.after.collectionCodes, ["MA", "MA-BRIO"]);
    const s = await call("collectory_set_code_mapping", { collectionUid: "co1", institutionCodes: { add: ["MA"] }, collectionCodes: { add: ["MA", "MA-BRIO"] }, dryRun: false, confirm: true });
    assert.equal(s.json.verified, true, s.text);
    // A second change keeps what was there (collectory itself would replace every code).
    await call("collectory_set_code_mapping", { collectionUid: "co1", collectionCodes: { add: ["MA-LIQ"], remove: ["MA-BRIO"] }, dryRun: false, confirm: true });
    assert.deepEqual(fake.state.providerMaps.get("co1")!.collectionCodes, ["MA", "MA-LIQ"]);
    assert.deepEqual(fake.state.providerMaps.get("co1")!.institutionCodes, ["MA"]);
    const c = await call("collectory_set_code_mapping", { collectionUid: "co1", institutionCodes: { add: ["MNCN"] }, collectionCodes: { add: ["ENT"] }, dryRun: false, confirm: true });
    assert.equal(c.isError, true);
    assert.match(c.text, /MNCN\/ENT -> co2/);
    assert.ok(!fake.state.providerMaps.get("co1")!.institutionCodes.includes("MNCN"), "a conflicting mapping must not be saved");
  });

  it("code mapping conflicts include maps that match any collection code (absent from codeMapDump) and differ in case", async () => {
    fake.state.providerMaps.set("co2", { institutionCodes: ["MNCN"], collectionCodes: [], exact: false, matchAnyCollectionCode: true });
    const { call } = await connect(fake, { token: "m2m-token" });
    const p = await call("collectory_set_code_mapping", { collectionUid: "co1", institutionCodes: { add: ["mncn"] }, collectionCodes: { add: ["HERB"] } });
    assert.deepEqual(p.json.conflicts.map((c: any) => c.alreadyMappedTo), ["co2 Entomología"], p.text);
    const s = await call("collectory_set_code_mapping", { collectionUid: "co1", institutionCodes: { add: ["mncn"] }, collectionCodes: { add: ["HERB"] }, dryRun: false, confirm: true });
    assert.equal(s.isError, true);
    assert.equal(fake.state.providerMaps.get("co1"), undefined, "a conflicting mapping must not be saved");
    const m = await call("collectory_code_map", { filter: "MNCN" });
    assert.deepEqual(m.json.mappings.map((x: any) => [x.uid, x.matchAny]), [["co2", true]]);
  });

  it("provider maps without a collection (old databases): checked through the admin list, refused without it, and named when they take a lookup", async () => {
    fake.add("institution", { uid: "in9", name: "Old museum" });
    fake.state.legacyMaps.push({ id: 7, institution: "in9", institutionCodes: ["OLD"], collectionCodes: ["X"], matchAnyCollectionCode: false });
    const args = { collectionUid: "co1", institutionCodes: { add: ["OLD"] }, collectionCodes: { add: ["X"] }, dryRun: false, confirm: true };
    const token = await connect(fake, { token: "m2m-token" });
    const blind = await token.call("collectory_set_code_mapping", args);
    assert.equal(blind.isError, true);
    assert.match(blind.text, /cannot check every mapping.*codeMapDump fails/s);
    assert.equal(fake.state.providerMaps.get("co1"), undefined);
    const both = await connect(fake, { token: "m2m-token", login: true });
    const seen = await both.call("collectory_set_code_mapping", args);
    assert.match(seen.text, /OLD\/X -> in9 Old museum \(provider map 7 without a collection\)/);
    const forced = await both.call("collectory_set_code_mapping", { ...args, allowConflicts: true });
    assert.equal(forced.json.verified, false);
    assert.match(forced.json.lookups[0].problem, /resolves to institution in9/);
    const a = (await both.call("collectory_audit")).json.findings.map((f: any) => `${f.uid}: ${f.problem}`).join("\n");
    assert.match(a, /in9: provider map 7 has no collection: it makes \/ws\/codeMapDump fail/);
    assert.match(a, /\/ws\/codeMapDump fails/);
    assert.match(a, /OLD\/X is also mapped to in9|OLD\/X is also mapped to co1/);
  });

  it("mapping check from the index: per code pair, mapped, missing a mapping, needing a reprocess, or without collectionCode", async () => {
    fake.state.providerMaps.set("co1", { institutionCodes: ["MA"], collectionCodes: ["MA"], exact: false, matchAnyCollectionCode: false });
    fake.add("dataResource", { uid: "dr5", name: "Herbarium records", consumers: ["co2"] });
    fake.state.index.push(
      { dataResourceUid: "dr5", institutionCode: "MNCN", collectionCode: "ENT", collectionUid: "co2", count: 70 },
      { dataResourceUid: "dr5", institutionCode: "MA", collectionCode: "MA", count: 20 },
      { dataResourceUid: "dr5", institutionCode: "MA", collectionCode: "LIQ", count: 7 },
      { dataResourceUid: "dr5", institutionCode: "MA", count: 3 },
      { dataResourceUid: "dr9", institutionCode: "X", collectionCode: "Y", count: 1000 },
    );
    const { call } = await connect(fake, { index: true, token: "m2m-token" });
    const r = (await call("collectory_mapping_check", { uids: ["dr5"] })).json.resources[0];
    assert.equal(r.codesFrom, "index");
    const v = Object.fromEntries(r.pairs.map((p: any) => [`${p.institutionCode}/${p.collectionCode}`, p.verdict]));
    assert.deepEqual(v, { "MNCN/ENT": "ok", "MA/MA": "reindex", "MA/LIQ": "unmapped", "MA/null": "no-collection-code" });
    assert.match(r.problems.join("\n"), /1 code pairs resolve to no collection.*MA\/LIQ/);
    assert.match(r.suggestions.join("\n"), /defaultDarwinCoreValues/);
    assert.match(r.suggestions.join("\n"), /reprocess and reindex dr5/);
    assert.match(r.warnings.join("\n"), /co1 receive records but are not record consumers/);
    const m = await call("collectory_set_code_mapping", { collectionUid: "co1", collectionCodes: { add: ["LIQ"] }, dryRun: false, confirm: true });
    assert.equal(m.json?.verified, true, m.text);
    const mapped = (await call("collectory_mapping_check", { uids: ["dr5"] })).json.resources[0];
    assert.equal(mapped.pairs.find((p: any) => p.collectionCode === "LIQ").verdict, "reindex", "a mapping made since the last check is seen");
    fake.state.entities.get("dr5")!["defaultDarwinCoreValues"] = JSON.stringify({ collectionCode: "MA" });
    const again = (await call("collectory_mapping_check", { uids: ["dr5"] })).json.resources[0];
    assert.ok(!again.suggestions.join().includes("defaultDarwinCoreValues"), "no suggestion when a default is set");
    const gaps = (await call("collectory_mapping_check", {})).json.resources;
    assert.deepEqual(gaps.map((g: any) => [g.uid, g.recordsWithCodesButNoCollection]), [["dr9", 1000], ["dr5", 27]]);
  });

  it("mapping check without an index reads the codes of the GBIF dataset", async () => {
    fake.add("dataResource", { uid: "dr6", name: "Repatriated", guid: "11111111-2222-3333-4444-555555555555", consumers: ["co2"] });
    fake.state.gbifOccurrences.push({ datasetKey: "11111111-2222-3333-4444-555555555555", institutionCode: "MNCN", collectionCode: "ENT", count: 5 }, { datasetKey: "11111111-2222-3333-4444-555555555555", institutionCode: "MNCN", count: 2 });
    const { call } = await connect(fake);
    const r = (await call("collectory_mapping_check", { uids: ["dr6"] })).json.resources[0];
    assert.equal(r.codesFrom, "gbif");
    assert.deepEqual(r.pairs.map((p: any) => [p.institutionCode, p.collectionCode, p.records, p.verdict]), [["MNCN", "ENT", 5, "ok"], ["MNCN", null, 2, "no-collection-code"]]);
    const none = await call("collectory_mapping_check", {});
    assert.match(none.text, /COLLECTORY_BIOCACHE_URL/);
  });

  describe("data file upload", () => {
    const dir = mkdtempSync(join(tmpdir(), "collectory-mcp-upload-"));
    const meta = `<archive xmlns="http://rs.tdwg.org/dwc/text/"><core rowType="http://rs.tdwg.org/dwc/terms/Occurrence"><files><location>occurrence.txt</location></files><id index="0"/><field index="1" term="http://rs.tdwg.org/dwc/terms/catalogNumber"/></core></archive>`;
    const eml = `<eml:eml xmlns:eml="eml://ecoinformatics.org/eml-2.1.1" packageId="pkg-1"><dataset><title>New title</title><contact><individualName><givenName>Ana</givenName><surName>A</surName></individualName><electronicMailAddress>ana@example.org</electronicMailAddress></contact></dataset></eml:eml>`;
    const zip = join(dir, "a.zip");
    const csv = join(dir, "a.csv");
    writeFileSync(zip, writeZip({ "meta.xml": meta, "eml.xml": eml, "occurrence.txt": "id\tcatalogNumber\n1\tA1\n" }));
    writeFileSync(csv, "catalogNumber,scientificName\nA1,Abies\n");
    const setup = async (call: (n: string, a: Record<string, unknown>) => Promise<any>) => {
      fake.add("dataResource", { uid: "dr7", name: "Old", pubDescription: "keep me", resourceType: "records", connectionParameters: JSON.stringify({ protocol: "DwCA", url: "https://x/a.zip", termsForUniqueKey: ["catalogNumber"], incremental: true }) });
      for (const [email, first, last] of [["ana@example.org", "Ana", "A"], ["bob@example.org", "Bob", "B"]]) {
        const r = await call("collectory_add_contact", { uid: "dr7", email, firstName: first, lastName: last, role: "Curator", notify: true, dryRun: false, confirm: true });
        assert.equal(r.json.verified, true, r.text);
      }
    };

    it("keeps every connection parameter, shows what the EML overwrites, and refuses removing contacts unless accepted", async () => {
      const { call } = await connect(fake, { token: "m2m-token", login: true });
      await setup(call);
      const p = await call("collectory_upload_data_file", { uid: "dr7", file: zip });
      assert.equal(p.json.dryRun, true);
      assert.match(p.json.errors.join(), /unlink 1 contacts.*bob@example.org.*contacts:"accept"/);
      assert.deepEqual(p.json.metadataFromEml.find((m: any) => m.field === "name"), { field: "name", from: "Old", to: "New title" });
      assert.ok(p.json.cleared.includes("pubDescription"), p.text);
      const refused = await call("collectory_upload_data_file", { uid: "dr7", file: zip, dryRun: false, confirm: true });
      assert.equal(refused.isError, true);
      assert.equal(fake.state.links.filter((l) => l.uid === "dr7").length, 2, "nothing uploaded");
      const u = await call("collectory_upload_data_file", { uid: "dr7", file: zip, contacts: "accept", dryRun: false, confirm: true });
      assert.equal(u.json.verified, true, u.text);
      const cp = JSON.parse(String(fake.state.entities.get("dr7")!["connectionParameters"]));
      assert.equal(cp.incremental, true, "incremental kept (#307)");
      assert.deepEqual(cp.termsForUniqueKey, ["catalogNumber"], "unique key kept (#207, #208)");
      assert.deepEqual(u.json.contacts.after, ["ana@example.org"]);
      assert.equal(fake.state.entities.get("dr7")!["name"], "New title");
    });

    it("a CSV upload, which wipes every contact in 6.x, can restore them with their flags", async () => {
      const { call } = await connect(fake, { token: "m2m-token", login: true });
      await setup(call);
      const p = await call("collectory_upload_data_file", { uid: "dr7", file: csv, protocol: "DwC" });
      assert.match(p.json.errors.join(), /unlink 2 contacts.*CSV upload removes every contact.*contacts:"restore"/s);
      const u = await call("collectory_upload_data_file", { uid: "dr7", file: csv, protocol: "DwC", contacts: "restore", dryRun: false, confirm: true });
      assert.equal(u.json.verified, true, u.text);
      assert.deepEqual(u.json.contacts.after.sort(), ["ana@example.org", "bob@example.org"]);
      assert.ok(u.json.contacts.restored.every((r: any) => r.restored && r.recreated), "collectory deleted the orphaned contacts: re-created");
      assert.ok(fake.state.links.filter((l) => l.uid === "dr7").every((l) => l.notify && l.role === "Curator"));
    });

    it("refuses a unique key change, key terms missing from the file and unknown parameters; not offered over HTTP", async () => {
      const { call } = await connect(fake, { token: "m2m-token", login: true });
      await setup(call);
      const key = await call("collectory_upload_data_file", { uid: "dr7", file: zip, termsForUniqueKey: ["occurrenceID"], contacts: "accept" });
      assert.match(key.json.errors.join(), /termsForUniqueKey changes from catalogNumber to occurrenceID/);
      assert.match(key.json.errors.join(), /occurrenceID is not a column of the file/);
      const unknown = await call("collectory_upload_data_file", { uid: "dr7", file: zip, set: { colour: "red" } });
      assert.match(unknown.text, /colour: not parameters of DwCA/);
      const restore = await call("collectory_upload_data_file", { uid: "dr7", file: zip, contacts: "restore", dryRun: false, confirm: true });
      assert.match(restore.text, /"restore" is for uploads without an EML/);
      assert.ok(!fake.state.requests.some((q) => q.path.startsWith("/dataResource/uploadDataFile")), "nothing uploaded");
      const remote = await connect(fake, { token: "m2m-token", remote: true });
      const r = await remote.call("collectory_upload_data_file", { uid: "dr7", file: zip });
      assert.equal(r.isError, true);
    });
  });

  it("hub members: data resources through the web service, as a JSON string, with the resources to reindex", async () => {
    const { call } = await connect(fake, { token: "m2m-token" });
    const p = await call("collectory_set_hub_members", { hubUid: "dh1", dataResources: { add: ["dr2"] } });
    assert.equal(p.json.via, "web service");
    assert.deepEqual(p.json.reindex, ["dr2"]);
    const s = await call("collectory_set_hub_members", { hubUid: "dh1", dataResources: { add: ["dr2"] }, dryRun: false, confirm: true });
    assert.equal(s.json.verified, true, s.text);
    assert.equal(fake.state.entities.get("dh1")!["memberDataResources"], '["dr1","dr2"]');
    const missing = await call("collectory_set_hub_members", { hubUid: "dh1", dataResources: { add: ["dr99"] }, dryRun: false, confirm: true });
    assert.match(missing.text, /do not exist: dr99/);
  });

  it("hub members: institutions and collections go through the admin form with a person's login, keeping the other lists", async () => {
    const { call } = await connect(fake, { token: "m2m-token", login: true });
    const s = await call("collectory_set_hub_members", { hubUid: "dh1", collections: { add: ["co1"] }, dryRun: false, confirm: true });
    assert.equal(s.isError, false, s.text);
    assert.equal(s.json.verified, true);
    const h = fake.state.entities.get("dh1")!;
    assert.equal(h["memberCollections"], '["co1"]');
    assert.equal(h["memberDataResources"], '["dr1"]', "the other lists are posted back unchanged");
    assert.ok(fake.state.requests.some((r) => r.path === "/dataHub/base" && r.auth === "session" && r.body?.includes("_action_updateDescription")));
  });

  it("the admin form lane refuses a machine token with a clear hint", async () => {
    const { call } = await connect(fake, { token: "m2m-token" });
    const r = await call("collectory_set_hub_members", { hubUid: "dh1", institutions: { add: ["in1"] }, dryRun: false, confirm: true });
    assert.equal(r.isError, true);
    assert.match(r.text, /not logged in|COLLECTORY_USERNAME/);
  });

  it("the admin form lane refuses a logged-in person without the role (sent to the public map)", async () => {
    const { call } = await connect(fake, { login: USER_LOGIN });
    const r = await call("collectory_set_hub_members", { hubUid: "dh1", institutions: { add: ["in1"] }, dryRun: false, confirm: true });
    assert.equal(r.isError, true);
    assert.match(r.text, /403.*public map/s);
    assert.equal(fake.state.entities.get("dh1")!["memberInstitutions"], undefined);
    const again = await call("collectory_set_hub_members", { hubUid: "dh1", institutions: { add: ["in1"] }, dryRun: false, confirm: true });
    assert.match(again.text, /403.*public map/s, "with a valid session the bounce is still a 403, not a login error");
  });

  it("record consumers via the admin form, with verification", async () => {
    const { call } = await connect(fake, { token: "m2m-token", login: true });
    const r = await call("collectory_set_record_consumers", { uid: "dr1", source: "co", add: ["co1"], dryRun: false, confirm: true });
    assert.equal(r.json.verified, true, r.text);
    assert.deepEqual(fake.state.entities.get("dr1")!["consumers"], ["co1"]);
    const plan = await call("collectory_set_hub_members", { hubUid: "dh1", collections: { add: ["co1"] } });
    assert.deepEqual(plan.json.reindex, ["dr1"], "resources linked to a collection joining a hub must be reindexed");
  });

  it("connection parameters: merge keeps the url and other keys; refuses when the url is hidden; checks unique terms", async () => {
    const admin = await connect(fake, { token: "m2m-token" });
    const s = await admin.call("collectory_set_connection_parameters", { uid: "dr1", set: { incremental: true }, dryRun: false, confirm: true });
    assert.equal(s.isError, false, s.text);
    const stored = JSON.parse(fake.state.entities.get("dr1")!["connectionParameters"]);
    assert.equal(stored.url, "https://ipt.example.org/archive.do?r=herbario");
    assert.deepEqual(stored.termsForUniqueKey, ["occurrenceID"]);
    assert.equal(stored.incremental, true);

    const editor = await connect(fake, { token: "editor-token" });
    const hidden = await editor.call("collectory_set_connection_parameters", { uid: "dr1", set: { incremental: false }, dryRun: false, confirm: true });
    assert.equal(hidden.isError, true);
    assert.match(hidden.text, /did not return the url/);
    assert.equal(JSON.parse(fake.state.entities.get("dr1")!["connectionParameters"]).url, "https://ipt.example.org/archive.do?r=herbario", "the url must survive");

    const bad = await admin.call("collectory_set_connection_parameters", { uid: "dr1", set: { termsForUniqueKey: [] }, dryRun: false, confirm: true });
    assert.match(bad.text, /termsForUniqueKey is empty/);
    const csv = await admin.call("collectory_set_connection_parameters", { uid: "dr2", set: { termsForUniqueKey: "catalogNumber, institutionCode" } });
    assert.deepEqual(csv.json.after.termsForUniqueKey, ["catalogNumber", "institutionCode"]);
  });

  it("IPT preview computes updates, new datasets and URL near misses without writing; scan reports what to reload", async () => {
    fake.add("dataResource", { uid: "dr3", name: "Https twin", dataProvider: "dp1", websiteUrl: `${fake.base.replace("http:", "https:")}/ipt/resource?r=nuevo` });
    const { call } = await connect(fake, { token: "m2m-token" });
    const p = (await call("collectory_ipt_preview", { dpUid: "dp1" })).json;
    assert.equal(p.datasetsInIpt, 2);
    assert.equal(p.updated[0].uid, "dr1");
    assert.deepEqual(p.updated[0].metadataChanges.find((c: any) => c.field === "name"), { field: "name", from: "Old name", to: "Herbario MA (v2)" });
    assert.equal(p.new[0].title, "Brand new dataset");
    assert.equal(p.nearMisses[0].uid, "dr3");
    assert.ok(p.notInIpt.some((d: any) => d.uid === "dr2"));
    assert.equal(fake.state.entities.get("dr1")!["name"], "Old name", "preview must not write");
    const s = await call("collectory_ipt_scan", { dpUid: "dp1", dryRun: false, confirm: true });
    assert.equal(s.isError, false, s.text);
    assert.equal(fake.state.entities.get("dr1")!["name"], "Herbario MA (v2)");
    const c = await call("collectory_ipt_scan", { dpUid: "dp1", create: true, dryRun: false, confirm: true });
    assert.match(c.text, /needs a person's login/);
  });

  it("IPT scan with create uses the provider page with a person's login and the given key", async () => {
    const { call } = await connect(fake, { token: "m2m-token", login: true });
    const s = await call("collectory_ipt_scan", { dpUid: "dp1", create: true, key: "occurrenceID", dryRun: false, confirm: true });
    assert.equal(s.isError, false, s.text);
    const created = [...fake.state.entities.values()].find((e) => e["name"] === "Brand new dataset")!;
    assert.deepEqual(JSON.parse(created["connectionParameters"]).termsForUniqueKey, ["occurrenceID"]);
  });

  it("GBIF preview compares GBIF publication dates; scan returns a loadGuid; load status is followed", async () => {
    const { call } = await connect(fake, { token: "m2m-token", login: true });
    const p = (await call("collectory_gbif_preview", { dpUid: "dp1" })).json;
    assert.deepEqual(p.wouldReload, ["dr1"]);
    assert.equal(p.resources.find((r: any) => r.uid === "dr2").status, "NO_GBIF_DATASET");
    const s = await call("collectory_gbif_scan", { dpUid: "dp1", dryRun: false, confirm: true });
    assert.match(s.json.next, /collectory_load_status/);
    const st1 = (await call("collectory_load_status", { loadGuid: s.json.loadGuid })).json;
    assert.equal(st1.finished, false);
    assert.match(st1.next, /again/);
    const st2 = (await call("collectory_load_status", { loadGuid: s.json.loadGuid })).json;
    assert.equal(st2.finished, true);
    assert.equal(st2.percentComplete, 100);
  });

  it("repatriation: search lists candidates; load posts only the chosen rows, renumbered, and hides the GBIF password", async () => {
    const { call } = await connect(fake, { login: true });
    const s = await call("collectory_repatriation_search", { country: "ES" });
    assert.equal(s.isError, false, s.text);
    assert.equal(s.json.candidates.length, 2);
    assert.ok(!s.text.includes("gbif-api-pass"));
    const l = await call("collectory_repatriation_load", { country: "ES", datasets: [{ guid: "9a2f0000-0000-0000-0000-000000000002" }, { guid: "9a2f0000-0000-0000-0000-000000000001" }], dryRun: false, confirm: true });
    assert.equal(l.isError, false, l.text);
    const post = fake.state.requests.find((r) => r.path === "/manage/updateFromExternalSources")!;
    const f = new URLSearchParams(post.body);
    assert.equal(f.get("resources[0].guid"), "9a2f0000-0000-0000-0000-000000000002");
    assert.equal(f.get("resources[0].uid"), "dr1");
    assert.equal(f.get("resources[0].addResource"), null, "a dataset that already has a resource is not added again");
    assert.equal(f.get("resources[1].guid"), "9a2f0000-0000-0000-0000-000000000001");
    assert.equal(f.get("resources[1].addResource"), "on", "a dataset without a collectory resource is added");
    assert.equal(f.get("resources[2].guid"), null);
    assert.equal(f.get("_resources[0].addResource"), null, "only the chosen rows are posted");
    const bad = await call("collectory_repatriation_load", { country: "ES", datasets: [{ guid: "nope" }], dryRun: false, confirm: true });
    assert.match(bad.text, /not in the current search results/);
  });

  it("GBIF registration asks for confirmation, then reads the result from the page and the entity", async () => {
    const { call } = await connect(fake, { login: true });
    const ask = await call("collectory_gbif_register", { uid: "dr2", action: "register" });
    assert.equal(ask.json.needsConfirmation, true);
    assert.ok(!fake.state.requests.some((r) => r.path.includes("registerGBIF")));
    const r = await call("collectory_gbif_register", { uid: "dr2", action: "register", confirm: true });
    assert.equal(r.json.ok, true, r.text);
    assert.deepEqual(r.json.messages, ["Successfully registered in GBIF"]);
    assert.match(r.json.gbifRegistryKey.after, /^[0-9a-f-]{36}$/);
  });

  it("GBIF organisations can be listed and imported as data providers", async () => {
    const { call } = await connect(fake, { login: true });
    const o = (await call("collectory_gbif_organizations", { country: "ES" })).json;
    assert.equal(o.importable[0].organizationKey, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    const i = await call("collectory_gbif_import_organization", { organizationKey: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", confirm: true });
    assert.equal(i.json.created[0].name, "Museo Nacional");
  });

  it("licences: create through the admin form, refuse near-duplicates, update by acronym + version", async () => {
    const { call } = await connect(fake, { login: true });
    const p = await call("collectory_save_licence", { acronym: "CC0", licenceVersion: "1.0", name: "Public domain", url: "https://creativecommons.org/publicdomain/zero/1.0/" });
    assert.equal(p.json.action, "create");
    assert.equal(fake.state.licences.size, 1, "the preview writes nothing");
    const c = await call("collectory_save_licence", { acronym: "CC0", licenceVersion: "1.0", name: "Public domain", url: "https://creativecommons.org/publicdomain/zero/1.0/", dryRun: false, confirm: true });
    assert.equal(c.json.verified, true, c.text);
    const dup = await call("collectory_save_licence", { acronym: "CC-BY", licenceVersion: "4.x", name: "CC BY again", url: "https://creativecommons.org/licenses/by/4.0/", dryRun: false, confirm: true });
    assert.match(dup.text, /#289/);
    assert.equal(fake.state.licences.size, 2);
    const u = await call("collectory_save_licence", { acronym: "cc-by", licenceVersion: "4.0", name: "Creative Commons Attribution 4.0 International", url: "https://creativecommons.org/licenses/by/4.0/", dryRun: false, confirm: true });
    assert.equal(u.json.action, "update");
    assert.deepEqual(u.json.changes, [{ field: "name", from: "Creative Commons Attribution", to: "Creative Commons Attribution 4.0 International" }]);
    assert.equal(fake.state.licences.get(1)!.name, "Creative Commons Attribution 4.0 International");
    assert.equal(fake.state.licences.size, 2);
  });

  it("an expired session is renewed when an admin page bounces to the public map", async () => {
    const { call } = await connect(fake, { login: true });
    const c = await call("collectory_save_licence", { acronym: "CC0", licenceVersion: "1.0", name: "Public domain", url: "https://creativecommons.org/publicdomain/zero/1.0/", dryRun: false, confirm: true });
    assert.equal(c.json?.verified, true, c.text);
    fake.dropSessions();
    const u = await call("collectory_save_licence", { acronym: "CC0", licenceVersion: "1.0", name: "CC0 1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/", dryRun: false, confirm: true });
    assert.equal(u.json?.verified, true, u.text);
  });

  it("a form save is reported even when the page collectory lands on fails (6.x bounces it to the public map)", async () => {
    const broken = await startFakeCollectory({ brokenShowPages: true });
    try {
      seed(broken);
      const { call } = await connect(broken, { token: "m2m-token", login: true });
      const r = await call("collectory_set_record_consumers", { uid: "dr1", source: "co", add: ["co1"], dryRun: false, confirm: true });
      assert.equal(r.json?.verified, true, r.text);
    } finally {
      await broken.close();
    }
  });

  it("licences on 5.x, whose web service has no acronym or version: matched and verified through the admin list", async () => {
    const old = await startFakeCollectory({ version: "5.1.1", legacyLicenceWs: true });
    try {
      const { call } = await connect(old, { login: true });
      const u = await call("collectory_save_licence", { acronym: "CC-BY", licenceVersion: "4.0", name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/", dryRun: false, confirm: true });
      assert.equal(u.json?.action, "update", u.text);
      assert.equal(u.json.verified, true, u.text);
      assert.equal(old.state.licences.size, 1);
    } finally {
      await old.close();
    }
  });

  it("licences: delete refuses while resources use the licence; the audit flags licences outside the vocabulary", async () => {
    const { call } = await connect(fake, { token: "m2m-token", login: true });
    fake.state.entities.get("dr1")!["licenseVersion"] = "4.0";
    const ask = await call("collectory_delete_licence", { acronym: "CC-BY", licenceVersion: "4.0" });
    assert.deepEqual(ask.json.usedBy.map((u: any) => u.uid), ["dr1"]);
    const refused = await call("collectory_delete_licence", { acronym: "CC-BY", licenceVersion: "4.0", confirm: true });
    assert.match(refused.text, /1 data resources use CC-BY 4.0 \(dr1\)/);
    assert.equal(fake.state.licences.size, 1);
    fake.state.entities.get("dr1")!["licenseType"] = "CC-BY-NC";
    const a = (await call("collectory_audit")).json;
    assert.ok(a.findings.some((f: any) => f.uid === "dr1" && /not in the licence vocabulary/.test(f.problem)), JSON.stringify(a.findings));
    const ok = await call("collectory_delete_licence", { acronym: "CC-BY", licenceVersion: "4.0", confirm: true });
    assert.equal(ok.json.deleted, true, ok.text);
  });

  it("delete checks dependencies first", async () => {
    const { call } = await connect(fake, { token: "m2m-token" });
    const ask = await call("collectory_delete_entity", { uid: "dr1" });
    assert.equal(ask.json.needsConfirmation, true);
    assert.ok(ask.json.dependencies.hubs);
    const refused = await call("collectory_delete_entity", { uid: "dr1", confirm: true });
    assert.match(refused.text, /still referenced \(hubs\)/);
    assert.ok(fake.state.entities.has("dr1"));
    // collectory's hubMembership is a snapshot from before dr2 joined dh1: the check must read the hubs themselves.
    assert.deepEqual((await call("collectory_get", { uids: ["dr2"] })).json.hubMembership, []);
    await call("collectory_set_hub_members", { hubUid: "dh1", dataResources: { add: ["dr2"] }, dryRun: false, confirm: true });
    assert.deepEqual((await call("collectory_get", { uids: ["dr2"] })).json.hubMembership, [], "the fake's hubMembership stays stale");
    assert.match((await call("collectory_delete_entity", { uid: "dr2", confirm: true })).text, /still referenced \(hubs\)/);
    await call("collectory_set_hub_members", { hubUid: "dh1", dataResources: { remove: ["dr2"] }, dryRun: false, confirm: true });
    const ok = await call("collectory_delete_entity", { uid: "dr2", confirm: true });
    assert.equal(ok.json.deleted, true, ok.text);
  });

  it("add_contact reuses a contact by email and links it", async () => {
    const { call } = await connect(fake, { token: "m2m-token" });
    const r = await call("collectory_add_contact", { uid: "dr1", email: "ana@example.org", firstName: "Ana", role: "Curator", administrator: true, dryRun: false, confirm: true });
    assert.equal(r.json.saved, true, r.text);
    assert.equal(fake.state.links[0]!.administrator, true);
    const again = await call("collectory_add_contact", { uid: "co1", email: "ana@example.org", dryRun: false, confirm: true });
    assert.equal(again.json.contact.action, "reuse existing contact");
    assert.equal(fake.state.contacts.size, 1);
  });

  it("contacts: unpublished ones are not listed by the web service (#193): with a login they are seen and verified", async () => {
    const token = await connect(fake, { token: "m2m-token" });
    const a = await token.call("collectory_add_contact", { uid: "co1", email: "hidden@example.org", lastName: "H", dryRun: false, confirm: true });
    assert.equal(a.json.verified, null, a.text);
    assert.match(a.json.note, /#193/);
    const blind = await token.call("collectory_update_contact", { uid: "co1", email: "hidden@example.org", role: "X", dryRun: false, confirm: true });
    assert.match(blind.text, /lists only published contacts.*COLLECTORY_USERNAME/);
    const both = await connect(fake, { token: "m2m-token", login: true });
    const listed = (await both.call("collectory_contacts", { uid: "co1" })).json;
    assert.deepEqual(listed.contacts.map((c: any) => [c.email, c.publish]), [["hidden@example.org", false]]);
    const u = await both.call("collectory_update_contact", { uid: "co1", email: "hidden@example.org", role: "Curator", notify: true, dryRun: false, confirm: true });
    assert.equal(u.json.verified, true, u.text);
  });

  it("contacts: notify set although collectory ignores it on create; role and flags changed on the existing link; unlinked", async () => {
    const { call } = await connect(fake, { token: "m2m-token", login: true });
    const a = await call("collectory_add_contact", { uid: "co1", email: "eva@example.org", role: "Curator", notify: true, dryRun: false, confirm: true });
    assert.equal(a.json.verified, true, a.text);
    assert.equal(fake.state.links[0]!.notify, true);
    const again = await call("collectory_add_contact", { uid: "co1", email: "eva@example.org", dryRun: false, confirm: true });
    assert.match(again.json.link, /collectory_update_contact/);
    const p = await call("collectory_update_contact", { uid: "co1", email: "EVA@example.org", role: "Director", primaryContact: true });
    assert.deepEqual(p.json.changes.map((c: any) => c.field), ["role", "primaryContact"]);
    assert.equal(fake.state.links[0]!.role, "Curator", "the preview writes nothing");
    const u = await call("collectory_update_contact", { uid: "co1", email: "eva@example.org", role: "Director", primaryContact: true, dryRun: false, confirm: true });
    assert.equal(u.json.verified, true, u.text);
    const { id: _linkId, ...link0 } = fake.state.links[0]! as any;
    assert.deepEqual(link0, { uid: "co1", contactId: fake.state.links[0]!.contactId, role: "Director", administrator: false, primaryContact: true, notify: true });
    const missing = await call("collectory_update_contact", { uid: "co2", email: "eva@example.org", role: "X", dryRun: false, confirm: true });
    assert.match(missing.text, /not a contact of co2/);
    const ask = await call("collectory_remove_contact", { uid: "co1", email: "eva@example.org" });
    assert.match(ask.text, /primary contact and the only contact/);
    assert.equal(fake.state.links.length, 1);
    const rm = await call("collectory_remove_contact", { uid: "co1", email: "eva@example.org", confirm: true });
    assert.equal(rm.json.removed, true, rm.text);
    assert.equal(fake.state.links.length, 0);
  });

  it("audit finds resources without unique terms, broken hub members and ambiguous or missing code mappings", async () => {
    fake.add("dataHub", { uid: "dh2", name: "Hub 2", memberDataResources: JSON.stringify(["dr77"]) });
    fake.state.providerMaps.set("co1", { institutionCodes: ["MNCN"], collectionCodes: ["ENT"], exact: false, matchAnyCollectionCode: false });
    const { call } = await connect(fake, { token: "m2m-token" });
    const a = (await call("collectory_audit")).json;
    const problems = a.findings.map((f: any) => `${f.uid}: ${f.problem}`);
    assert.ok(problems.some((p: string) => p.startsWith("dr2: connection parameters: termsForUniqueKey is empty")), problems.join("\n"));
    assert.ok(problems.some((p: string) => p.includes("dh2: member dr77 does not exist")));
    assert.ok(problems.some((p: string) => p.includes("MNCN/ENT is also mapped")));
    assert.ok(problems.some((p: string) => p.startsWith("dr2: no licence")));
    assert.ok(problems.includes("co2: mapped collection without an institution: its records get no institutionUid"), problems.join("\n"));
    assert.ok(!problems.some((p: string) => p.startsWith("co1: mapped collection without")), "co1 belongs to in1");
  });

  it("never shows configured secrets to the model", async () => {
    const { call } = await connect(fake, { token: "m2m-token", login: true, secrets: [ADMIN_LOGIN.password, "m2m-token"] });
    fake.add("dataResource", { uid: "dr50", name: `leaky ${ADMIN_LOGIN.password}`, notes: "Bearer m2m-token" });
    const r = await call("collectory_get", { uids: ["dr50"] });
    assert.ok(!r.text.includes(ADMIN_LOGIN.password));
    assert.ok(!r.text.includes("m2m-token"));
  });

  it("works with collectory 6.0.0, whose single data resource GET fails, by reading through /ws/find", async () => {
    const old = await startFakeCollectory({ version: "6.0.0", brokenDrGet: true });
    try {
      seed(old);
      const { call } = await connect(old, { token: "m2m-token" });
      const h = (await call("collectory_health")).json;
      assert.ok(h.notes.some((n: string) => n.includes("< 6.3")));
      const g = await call("collectory_get", { uids: ["dr1", "dr2"] });
      assert.equal(g.json.length, 2, g.text);
    } finally {
      await old.close();
    }
  });
});
