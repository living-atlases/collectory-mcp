import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { entityOf, isPublicMap, parseCsv } from "../src/collectory-client.ts";
import { loadConfig, secretsOf } from "../src/config.ts";
import { checkConnectionParameters, planEntityWrite, same } from "../src/entities.ts";
import { FormContractError, fill, findForm, pageMessages } from "../src/forms.ts";
import { Redactor } from "../src/redact.ts";
import { authFor } from "../src/stdio.ts";
import { overlap, parseIptRss } from "../src/workflows.ts";

describe("entities", () => {
  it("routes uids to entities", () => {
    assert.equal(entityOf("dr12"), "dataResource");
    assert.equal(entityOf("drt3"), "tempDataResource");
    assert.equal(entityOf("dh1"), "dataHub");
    assert.throws(() => entityOf("xx1"), /not a collectory uid/);
    assert.throws(() => entityOf("dr"), /not a collectory uid/);
  });

  it("refuses fields the web service ignores, naming where to change them", () => {
    assert.throws(() => planEntityWrite("dataHub", { name: "h" }, { memberCollections: "[]" }), /collectory_set_hub_members/);
    assert.throws(() => planEntityWrite("institution", { name: "i" }, { taxonomyHints: {} }), /taxonomyHints cannot be written/);
    assert.throws(() => planEntityWrite("dataResource", { name: "d" }, { foo: 1 }), /silently ignored/);
  });

  it("checks lengths, URLs, vocabularies and JSON shapes before sending", () => {
    assert.throws(() => planEntityWrite("dataResource", undefined, { name: "x", status: "ready" }), /status must be one of/);
    assert.throws(() => planEntityWrite("dataResource", undefined, { name: "x", resourceType: "occurrences" }), /resourceType must be one of/);
    assert.throws(() => planEntityWrite("dataResource", undefined, { name: "x", acronym: "a".repeat(46) }), /acronym is 46 characters/);
    assert.throws(() => planEntityWrite("collection", undefined, { name: "x", websiteUrl: "ftp://x" }), /websiteUrl must start with http/);
    assert.throws(() => planEntityWrite("dataResource", undefined, { name: "x", defaultDarwinCoreValues: { a: 1 } }), /flat object of strings/);
    assert.throws(() => planEntityWrite("dataResource", undefined, { name: "x", connectionParameters: "{}" }), /must be an object/);
    assert.throws(() => planEntityWrite("dataResource", undefined, { name: "x", dataCurrency: "2024-01-01" }), /"now" or yyyy-MM-ddTHH:mm:ss/);
    assert.throws(() => planEntityWrite("dataResource", undefined, { name: "x", dataProvider: "dp1" }), /dataProvider must be \{uid/);
    assert.throws(() => planEntityWrite("institution", undefined, { acronym: "X" }), /name is required/);
    assert.throws(() => planEntityWrite("dataHub", undefined, { name: "h", memberDataResources: ["dr1"] }), /ignores memberDataResources when a data hub is created/);
    assert.throws(() => planEntityWrite("institution", { name: "i" }, { attributions: "at1,at2" }), /space-separated/);
  });

  it("diffs against the current entity and warns about clearing and no-ops", () => {
    const p = planEntityWrite("dataResource", { name: "A", citation: "c", numRecords: "5" }, { name: "A", citation: null });
    assert.deepEqual(p.changes, [{ field: "citation", from: "c", to: null }]);
    assert.deepEqual(p.warnings, ["citation will be cleared"]);
    assert.deepEqual(planEntityWrite("dataResource", { name: "A" }, { name: "A" }).warnings, ["nothing changes: every value is already set"]);
    assert.equal(planEntityWrite("dataHub", { name: "h" }, { memberDataResources: ["dr1", "dr2"] }).body["memberDataResources"], '["dr1","dr2"]');
  });

  it("gives a new collection the -1 coordinates the admin UI sends (the web service rejects nulls)", () => {
    const p = planEntityWrite("collection", undefined, { name: "C", northCoordinate: 10 });
    assert.deepEqual([p.body["eastCoordinate"], p.body["westCoordinate"], p.body["northCoordinate"], p.body["southCoordinate"]], [-1, -1, 10, -1]);
    assert.match(p.warnings.join(), /set to -1/);
    assert.equal(planEntityWrite("collection", { name: "C" }, { name: "D" }).body["eastCoordinate"], undefined, "not on updates");
  });

  it("compares loosely like the web service answers", () => {
    assert.ok(same(5, "5"));
    assert.ok(same({ a: 1, b: [1] }, { b: [1], a: 1 }));
    assert.ok(same(undefined, null));
    assert.ok(!same("a", null));
  });

  it("checks connection parameters the loaders depend on", () => {
    assert.deepEqual(checkConnectionParameters({ protocol: "DwCA", url: "https://x/a.zip", termsForUniqueKey: ["occurrenceID"] }), []);
    assert.match(checkConnectionParameters({ protocol: "DwCA", url: "https://x" }).join(), /termsForUniqueKey is empty/);
    assert.match(checkConnectionParameters({ protocol: "DwCA", url: "https://x", termsForUniqueKey: ["a", "a"] }).join(), /repeats/);
    assert.match(checkConnectionParameters({ protocol: "DwCA", termsForUniqueKey: ["a"] }).join(), /no url/);
    assert.match(checkConnectionParameters({ protocol: "DwCA", url: "x.zip", termsForUniqueKey: ["a"] }).join(), /not an http/);
    assert.deepEqual(checkConnectionParameters({ protocol: "DwCA", url: "https://x" }, "website"), [], "only records resources need unique terms");
    assert.match(checkConnectionParameters({}).join(), /no protocol/);
  });
});

describe("forms", () => {
  const html = `<form action="/dataHub/base" method="post"><input type="hidden" name="uid" value="dh1"><input type="hidden" name="version" value="3">
    <textarea name="memberInstitutions">["in1"]</textarea><select name="kind"><option value="a">A</option><option value="b" selected>B</option></select>
    <select name="codes" multiple><option value="1" selected>x</option><option value="2" selected>y</option><option value="3">z</option></select>
    <input type="checkbox" name="exact" checked><input type="checkbox" name="matchAny"><input type="text" name="ro" value="r" disabled>
    <input type="submit" name="_action_updateDescription" value="Update"><input type="submit" name="_action_cancel" value="Cancel"></form>`;

  it("reads the live form: hidden fields, selects, multi-selects, checkboxes, submit buttons", () => {
    const f = findForm(html, "https://c.example.org/dataHub/edit/dh1", { submit: "_action_updateDescription" });
    assert.equal(f.action, "https://c.example.org/dataHub/base");
    assert.deepEqual(f.fields, [["uid", "dh1"], ["version", "3"], ["memberInstitutions", '["in1"]'], ["kind", "b"], ["codes", "1"], ["codes", "2"], ["exact", "on"]]);
    assert.ok(f.names.has("matchAny") && f.names.has("ro"));
  });

  it("posts back everything with only the requested changes and the chosen button", () => {
    const f = findForm(html, "https://c.example.org/x", { action: /\/base$/ });
    const body = fill(f, { memberInstitutions: "[]", codes: ["3"], exact: false, matchAny: true }, "_action_updateDescription");
    assert.equal(body.toString(), "uid=dh1&version=3&kind=b&memberInstitutions=%5B%5D&codes=3&matchAny=on&_action_updateDescription=Update");
  });

  it("fails closed when a field or button is not in the live form", () => {
    const f = findForm(html, "https://c.example.org/x", {});
    assert.throws(() => fill(f, { memberDataProviders: "[]" }), FormContractError);
    assert.throws(() => fill(f, {}, "_action_delete"), /no button/);
    assert.throws(() => findForm(html, "https://c.example.org/x", { submit: "_action_updateConsumers" }), /nothing was sent/);
  });

  it("reads Grails flash messages and errors", () => {
    assert.deepEqual(pageMessages(`<div class="message">Saved</div><ul class="errors"><li>Bad code</li></ul>`), { messages: ["Saved"], errors: ["Bad code"] });
  });
});

describe("parsers", () => {
  it("parses codeMapDump CSV with quoted names", () => {
    const rows = parseCsv('collectionCode,institutionCode,collectionUid,collectionName\r\nENT,MNCN,co2,"Entomología, ""general"""\nMA,MA,co1,Herbario\n');
    assert.deepEqual(rows, [
      { collectionCode: "ENT", institutionCode: "MNCN", collectionUid: "co2", collectionName: 'Entomología, "general"' },
      { collectionCode: "MA", institutionCode: "MA", collectionUid: "co1", collectionName: "Herbario" },
    ]);
    assert.deepEqual(parseCsv(""), []);
  });

  it("parses an IPT rss.do feed as collectory does (link as key, GBIF key from a non-URL guid)", () => {
    const items = parseIptRss(`<rss xmlns:ipt="http://ipt.gbif.org/"><channel><item><title>T</title><link>https://ipt/resource?r=a</link><description>D</description><pubDate>Mon, 05 Oct 2026 10:00:00 GMT</pubDate><guid>abcd/v1.2</guid><ipt:dwca>https://ipt/archive.do?r=a</ipt:dwca></item><item><title>U</title><link>https://ipt/resource?r=b</link><guid>https://ipt/resource?r=b</guid></item></channel></rss>`);
    assert.equal(items[0]!.gbifKey, "abcd");
    assert.equal(items[0]!.dwca, "https://ipt/archive.do?r=a");
    assert.equal(items[1]!.gbifKey, undefined);
  });
});

describe("config and secrets", () => {
  it("reads flags and env, strips /ws, and lists the secrets to mask", () => {
    const c = loadConfig(["--collectory", "https://c.example.org/ws/", "--readonly"], { COLLECTORY_TOKEN: "tok123", COLLECTORY_USERNAME: "a@b", COLLECTORY_PASSWORD: "pw1234" });
    assert.equal(c.url, "https://c.example.org");
    assert.equal(c.readonly, true);
    assert.deepEqual(secretsOf(c).filter(Boolean), ["tok123", "pw1234"]);
    assert.throws(() => loadConfig([], { COLLECTORY_OIDC_CLIENT_ID: "x" }), /COLLECTORY_OIDC_ISSUER/);
    assert.throws(() => loadConfig([], { COLLECTORY_TOKEN_STORE: "disk" }), /must be one of/);
  });

  it("picks the credentials in order: token, OIDC, API key, none", () => {
    assert.equal(authFor(loadConfig([], { COLLECTORY_TOKEN: "t", COLLECTORY_API_KEY: "k" })).describe, "COLLECTORY_TOKEN");
    assert.match(authFor(loadConfig([], { COLLECTORY_OIDC_CLIENT_ID: "c", COLLECTORY_OIDC_TOKEN_URL: "https://x/token", COLLECTORY_OIDC_CLIENT_SECRET: "s" })).describe, /client credentials/);
    assert.match(authFor(loadConfig([], { COLLECTORY_API_KEY: "k" })).describe, /API_KEY/);
    assert.match(authFor(loadConfig([], {})).describe, /none/);
  });

  it("redacts secrets, bearer tokens, URL userinfo and secret-named fields", () => {
    const r = new Redactor(["pw1234"]);
    assert.equal(r.str("login pw1234 Bearer abc.def https://u:p@h/x"), "login *** Bearer *** https://***@h/x");
    assert.deepEqual(r.value({ password: "x", list: [{ name: "password", value: "gbif" }], ok: "fine" }), { password: "***", list: [{ name: "password", value: "***" }], ok: "fine" });
  });
});

describe("public map detection", () => {
  it("recognises collectory's root and /public/map, also under a context path", () => {
    assert.equal(isPublicMap("http://localhost:8080", "/"), true);
    assert.equal(isPublicMap("http://localhost:8080", "/public/map"), true);
    assert.equal(isPublicMap("http://localhost:8080", "/licence/list"), false);
    assert.equal(isPublicMap("https://example.org/collectory", "/collectory/"), true);
    assert.equal(isPublicMap("https://example.org/collectory/", "/collectory"), true);
    assert.equal(isPublicMap("https://example.org/collectory", "/collectory/public/map"), true);
    assert.equal(isPublicMap("https://example.org/collectory", "/collectory/licence/list"), false);
    assert.equal(isPublicMap("https://example.org/collectory", "/"), false);
  });
});

describe("code mapping overlap", () => {
  const m = (i: string[], c: string[], matchAny = false) => ({ institutionCodes: i, collectionCodes: c, matchAny });
  it("shared pairs, case-insensitively", () => {
    assert.deepEqual(overlap(m(["MNCN"], ["ENT", "BOT"]), m(["mncn"], ["ent"])), [{ institutionCode: "MNCN", collectionCode: "ENT" }]);
    assert.deepEqual(overlap(m(["MNCN"], ["ENT"]), m(["MNCN"], ["BOT"])), []);
    assert.deepEqual(overlap(m(["MA"], ["ENT"]), m(["MNCN"], ["ENT"])), []);
  });
  it("a map that matches any collection code takes every code of its institution codes", () => {
    assert.deepEqual(overlap(m(["MNCN"], ["ENT"]), m(["MNCN"], [], true)), [{ institutionCode: "MNCN", collectionCode: "ENT" }]);
    assert.deepEqual(overlap(m(["MNCN"], [], true), m(["MNCN"], ["ENT"])), [{ institutionCode: "MNCN", collectionCode: "ENT" }]);
    assert.deepEqual(overlap(m(["MNCN"], [], true), m(["MNCN"], [], true)), [{ institutionCode: "MNCN", collectionCode: "*" }]);
  });
});
