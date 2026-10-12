import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { nonInteractive } from "./auth.ts";
import { CollectoryClient, CollectoryError, ENTITIES, entityOf } from "./collectory-client.ts";
import type { Config } from "./config.ts";
import { Redactor } from "./redact.ts";
import { Workflows } from "./workflows.ts";

export const VERSION = "0.1.0";

const INSTRUCTIONS = `Experimental proof of concept: an MCP server for routine ALA collectory administration (the registry of
institutions, collections, data providers, data resources and data hubs of a Living Atlas).

Start with collectory_health: it says which collectory version this is and what the configured credentials can do
(web services with a token, admin pages with a person's login).

Common tasks and the tools for them:
- Look things up: collectory_list, collectory_get, collectory_lookup_codes, collectory_code_map, collectory_contacts.
- Create or edit an entity: collectory_save_entity (preview of the field changes first).
- Map institutionCode/collectionCode to a collection (the Data mappings wiki page): collectory_set_code_mapping.
- Data hub members: collectory_set_hub_members. Record consumers of a resource/provider: collectory_set_record_consumers.
- Connection parameters of a data resource (protocol, url, termsForUniqueKey…): collectory_set_connection_parameters.
- IPT: collectory_ipt_preview (what a scan would change, computed without writing), then collectory_ipt_scan.
- GBIF repatriation: collectory_gbif_preview + collectory_gbif_scan for a provider's resources;
  collectory_repatriation_search + collectory_repatriation_load for new datasets of a country; collectory_load_status.
- GBIF registry: collectory_gbif_register, collectory_gbif_health, collectory_gbif_organizations / _import_organization.
- Find problems: collectory_audit (read only).

Rules:
- Every write is a dry run unless dryRun:false AND confirm:true: show the preview to the user and ask first.
- Records already indexed do not change when the registry changes: after mappings, hub members, consumers or
  connection parameters change, tell the user which data resources to reprocess and reindex (the "next" and
  "reindex" fields of the results).
- Never ask the user for passwords or tokens: credentials are configured outside the conversation.`;

type ToolResult = { isError?: boolean; content: Array<{ type: "text"; text: string }> };

export interface ServerDeps {
  client: CollectoryClient;
  config: Pick<Config, "readonly" | "gbifApi">;
  secrets?: Array<string | undefined>;
}

export function createServer(deps: ServerDeps): McpServer {
  const { client, config } = deps;
  const wf = new Workflows(client, config.gbifApi);
  const redactor = new Redactor(deps.secrets ?? []);
  const render = (v: unknown) => (typeof v === "string" ? redactor.str(v) : JSON.stringify(redactor.value(v), null, 2));
  const server = new McpServer({ name: "collectory-mcp", version: VERSION }, { instructions: INSTRUCTIONS });

  type Kind = "read" | "write" | "destructive";
  const tool = <S extends z.ZodRawShape>(name: string, kind: Kind, description: string, shape: S, fn: (a: z.infer<z.ZodObject<S>>) => Promise<unknown>) => {
    const annotations = { readOnlyHint: kind === "read", destructiveHint: kind === "destructive", openWorldHint: true };
    server.registerTool(name, { description: kind === "read" ? description : `${description} [changes collectory]`, inputSchema: shape, annotations }, (async (args: z.infer<z.ZodObject<S>>): Promise<ToolResult> => {
      try {
        const a = args as { dryRun?: boolean; confirm?: boolean };
        const preview = "dryRun" in a ? a.dryRun !== false : !a.confirm;
        if (kind !== "read" && config.readonly && !preview) throw new Error("this server is read-only (COLLECTORY_READONLY): writes are disabled; dry runs still work");
        return { content: [{ type: "text", text: render(await fn(args)) }] };
      } catch (e) {
        const msg = e instanceof CollectoryError || e instanceof Error ? e.message : String(e);
        return { isError: true, content: [{ type: "text", text: redactor.str(msg) }] };
      }
    }) as never);
  };

  const dryRun = z.boolean().default(true).describe("Preview only (default). Set false, together with confirm:true, to really do it");
  const confirm = z.boolean().default(false).describe("Must be true (and dryRun false) to really do it");
  const mustConfirm = (a: { dryRun?: boolean; confirm?: boolean }) => {
    if (a.dryRun === false && !a.confirm) throw new Error("dryRun:false needs confirm:true: show the preview to the user and ask first");
    return a.dryRun !== false;
  };
  const confirmOnly = (a: { confirm?: boolean }, what: string) => (a.confirm ? undefined : { needsConfirmation: true, message: `This will ${what}. Call again with confirm:true once the user has agreed.` });
  const uid = (prefixes?: string) => z.string().regex(prefixes ? new RegExp(`^(${prefixes})\\d+$`) : /^[a-z]{2,3}\d+$/, "a collectory uid such as dr12, co3, in4, dp2, dh1");
  const delta = z.object({ add: z.array(z.string()).optional(), remove: z.array(z.string()).optional() }).optional();
  const entity = z.enum(ENTITIES);

  // ---------------- health & discovery ----------------

  tool("collectory_health", "read", "Which collectory this is (URL, version), whether it answers, and what the configured credentials can do: web service writes (token/API key) and admin pages (a person's login)", {}, async () =>
    nonInteractive.run(true, async () => {
      const version = await client.version().catch((e: Error) => ({ error: e.message }));
      const ws = await client.list("dataHub").then(
        (l) => ({ ok: true, dataHubs: l.length }),
        (e: Error) => ({ ok: false, error: e.message }),
      );
      // /ws/contacts/0 needs the same rights as a write (ROLE_EDITOR/ROLE_ADMIN or the scope): "no such id" (400) means accepted.
      const probe = await client.raw("/ws/contacts/0", { user: "optional" }).catch((e: Error) => e);
      const writes = probe instanceof Error ? { ok: false, error: probe.message } : { ok: probe.status < 500 && ![301, 302, 401, 403].includes(probe.status), status: probe.status, ...(probe.status >= 500 ? { error: "collectory failed while checking the credentials (6.0.x does with anonymous callers)" } : {}) };
      let admin: unknown = { configured: client.hasSession };
      if (client.hasSession) admin = await client.page("/manage/list").then(
        () => ({ configured: true, ok: true }),
        (e: Error) => ({ configured: true, ok: false, error: e.message }),
      );
      const v = version as { major?: number; minor?: number; version?: string };
      const notes: string[] = [];
      if (v.major === 6 && (v.minor ?? 0) < 3) notes.push("collectory < 6.3: single data resource GETs may answer 500 (FindBest, fixed in 6.3.0) and several endpoints lack permission checks; upgrade if you can");
      if (v.major !== undefined && v.major < 6) notes.push("collectory 5.x: web service writes take the legacy API key (COLLECTORY_API_KEY) or a JWT; deletes are not flushed there (#287); an IPT scan only reports unless create is given");
      return { url: client.baseUrl, version, auth: client.authDescription, readonly: config.readonly, webServices: ws, webServiceWrites: writes, adminPages: admin, notes };
    }),
  );

  tool("collectory_list", "read", "List entities of a type (uid, name), optionally filtered by any property, e.g. {resourceType: 'records'} or {status: 'dataAvailable'}", { entity, filters: z.record(z.string()).optional() }, async (a) => {
    const l = await client.list(a.entity, a.filters ?? {});
    return { count: l.length, items: l.map(({ uid, name }) => ({ uid, name })) };
  });

  tool("collectory_get", "read", "Full JSON of one entity by uid (dr…, co…, in…, dp…, dh…, drt…), or of several data resources at once", { uids: z.array(uid()).min(1).max(200) }, async (a) => {
    if (a.uids.length === 1) return client.get(a.uids[0]!);
    if (a.uids.every((u) => u.startsWith("dr"))) return wf.resources(a.uids);
    return Promise.all(a.uids.map((u) => client.get(u).catch((e: Error) => ({ uid: u, error: e.message }))));
  });

  tool("collectory_count", "read", "Count entities of a type, optionally grouped by a property (e.g. dataResource by resourceType)", { entity, groupBy: z.string().optional() }, async (a) => client.count(a.entity, a.groupBy));

  tool("collectory_lookup_codes", "read", "Which collection (or institution) an institutionCode/collectionCode pair of the occurrence records resolves to, as biocache/pipelines resolve it", { institutionCode: z.string(), collectionCode: z.string() }, async (a) => client.lookupCodes(a.institutionCode, a.collectionCode));

  tool("collectory_code_map", "read", "Every institutionCode/collectionCode -> collection mapping (from /ws/codeMapDump), optionally filtered by a code or collection uid", { filter: z.string().optional() }, async (a) => {
    const rows = await client.codeMap();
    const f = a.filter?.toLowerCase();
    const out = f ? rows.filter((r) => [r["institutionCode"], r["collectionCode"], r["collectionUid"], r["institutionUid"]].some((x) => x?.toLowerCase() === f)) : rows;
    return { count: out.length, mappings: out.map((r) => ({ institutionCode: r["institutionCode"], collectionCode: r["collectionCode"], collectionUid: r["collectionUid"], collectionName: r["collectionName"], institutionUid: r["institutionUid"] })) };
  });

  tool("collectory_contacts", "read", "Contacts linked to an entity, with their role and flags", { uid: uid() }, async (a) => client.contactsFor(a.uid));

  tool("collectory_licences", "read", "Licences known to collectory (the vocabulary for licenseType)", {}, async () => client.licences());

  tool("collectory_audit", "read", "Check the registry for common problems: records resources without connection parameters, unique key terms or licence; broken websiteUrls; hub members that no longer exist; ambiguous code mappings; collections no code mapping points to", { limit: z.number().int().positive().max(5000).optional().describe("Data resources to check (default 500)") }, async (a) => wf.audit({ limit: a.limit }));

  // ---------------- entities ----------------

  tool(
    "collectory_save_entity",
    "write",
    "Create an entity (give entity) or change fields of an existing one (give uid). Only the fields given change. The preview lists each field change and refuses fields the web service ignores, values collectory rejects (lengths, URLs, status lists) and recordsMapping (use collectory_set_code_mapping)",
    { uid: uid().optional(), entity: entity.optional().describe("Type to create when no uid is given"), fields: z.record(z.unknown()).describe('e.g. {"name": "…", "websiteUrl": "https://…", "dataProvider": {"uid": "dp2"}}; null clears a field'), dryRun, confirm },
    async (a) => {
      if (mustConfirm(a)) return { dryRun: true, ...(await wf.previewEntity({ uid: a.uid, entity: a.entity }, a.fields)) };
      return wf.saveEntity({ uid: a.uid, entity: a.entity }, a.fields);
    },
  );

  tool("collectory_dependencies", "read", "What still refers to an entity (hubs, collections, resources, consumers, code mapping): check before deleting", { uid: uid() }, async (a) => wf.dependencies(a.uid));

  tool("collectory_delete_entity", "destructive", "Delete an entity. Refuses while hubs, mappings, collections or resources still refer to it unless force:true", { uid: uid(), force: z.boolean().default(false), confirm }, async (a) => {
    const deps = await wf.dependencies(a.uid);
    const ask = confirmOnly(a, `delete ${a.uid} (${String(deps.name)})${deps.safe ? "" : `, which is still referenced: ${JSON.stringify(deps.dependencies)}`}`);
    if (ask) return { ...ask, dependencies: deps.dependencies };
    return wf.deleteEntity(a.uid, a.force);
  });

  // ---------------- registry links ----------------

  const codes = z.object({ add: z.array(z.string()).optional(), remove: z.array(z.string()).optional() }).optional();
  tool(
    "collectory_set_code_mapping",
    "write",
    "Add or remove institutionCode/collectionCode values that map occurrence records to a collection (merged with the current mapping, checked against every other mapping for conflicts, verified with the lookup afterwards)",
    { collectionUid: uid("co"), institutionCodes: codes, collectionCodes: codes, exact: z.boolean().optional(), matchAnyCollectionCode: z.boolean().optional().describe("Match any collection code of the institution code"), warning: z.string().optional(), allowConflicts: z.boolean().default(false), dryRun, confirm },
    async (a) => {
      const o = { institutionCodes: a.institutionCodes, collectionCodes: a.collectionCodes, exact: a.exact, matchAnyCollectionCode: a.matchAnyCollectionCode, warning: a.warning };
      if (mustConfirm(a)) return { dryRun: true, ...(await wf.planCodeMapping(a.collectionUid, o)) };
      return wf.setCodeMapping(a.collectionUid, o, a.allowConflicts);
    },
  );

  tool(
    "collectory_set_hub_members",
    "write",
    "Add or remove data resources, institutions and collections of a data hub. Data resources go through the web service; institutions and collections through the admin form (needs a person's login). Lists the data resources to reindex",
    { hubUid: uid("dh"), dataResources: delta, institutions: delta, collections: delta, dryRun, confirm },
    async (a) => {
      const o = { dataResources: a.dataResources, institutions: a.institutions, collections: a.collections };
      if (mustConfirm(a)) return { dryRun: true, ...(await wf.planHubMembers(a.hubUid, o)) };
      return wf.setHubMembers(a.hubUid, o);
    },
  );

  tool(
    "collectory_set_record_consumers",
    "write",
    "Link a data resource or provider to the collections (source co) or institutions (source in) its records belong to (admin form, needs a person's login)",
    { uid: uid("dr|dp"), source: z.enum(["co", "in"]), add: z.array(z.string()).optional(), remove: z.array(z.string()).optional(), dryRun, confirm },
    async (a) => wf.setRecordConsumers(a.uid, a.source, { add: a.add, remove: a.remove }, !mustConfirm(a)).then((r) => (mustConfirm(a) ? { dryRun: true, ...r } : r)),
  );

  tool(
    "collectory_set_connection_parameters",
    "write",
    "Change a data resource's connection parameters (protocol, url, termsForUniqueKey, incremental, strip, csv settings…) without losing the rest: merges with the current value, refuses when collectory hides the url from these credentials, and checks the unique key terms",
    { uid: uid("dr"), set: z.record(z.unknown()).optional().describe('Keys to set, e.g. {"termsForUniqueKey": ["occurrenceID"], "incremental": false}'), unset: z.array(z.string()).optional(), replace: z.record(z.unknown()).optional().describe("Replace the whole object instead of merging"), acceptProblems: z.boolean().default(false), dryRun, confirm },
    async (a) => {
      const o = { set: a.set, unset: a.unset, replace: a.replace };
      if (mustConfirm(a)) return { dryRun: true, ...(await wf.planConnectionParameters(a.uid, o)) };
      return wf.setConnectionParameters(a.uid, o, a.acceptProblems);
    },
  );

  tool(
    "collectory_add_contact",
    "write",
    "Link a person to an entity as a contact (reuses the contact with that email or creates it)",
    { uid: uid(), email: z.string().email(), firstName: z.string().optional(), lastName: z.string().optional(), title: z.string().max(20).optional(), phone: z.string().optional(), publish: z.boolean().optional().describe("Show the contact on public pages"), role: z.string().max(128).optional(), administrator: z.boolean().optional().describe("Can edit the entity"), primaryContact: z.boolean().optional(), dryRun, confirm },
    async (a) => {
      const { uid: u, dryRun: _d, confirm: _c, ...c } = a;
      const preview = mustConfirm(a);
      const r = await wf.addContact(u, c, !preview);
      return preview ? { dryRun: true, ...r } : r;
    },
  );

  // ---------------- IPT ----------------

  tool("collectory_ipt_preview", "read", "What an IPT scan of a data provider would do, computed without writing: resources it would update (and their metadata changes), new datasets, datasets whose URL does not match, and resources no longer in the IPT", { dpUid: uid("dp") }, async (a) => wf.iptPreview(a.dpUid));

  tool(
    "collectory_ipt_scan",
    "write",
    "Scan a data provider's IPT: updates the metadata and contacts of existing resources from the IPT (overwriting edits made in collectory) and lists the resources with new data. create:true also creates resources for new datasets (needs a person's login in 6.3+)",
    { dpUid: uid("dp"), create: z.boolean().default(false), key: z.string().optional().describe("Unique key term for new resources (default catalogNumber in collectory; occurrenceID is usually right)"), isShareableWithGBIF: z.boolean().optional(), checkDataCurrency: z.boolean().default(true), dryRun, confirm },
    async (a) => {
      if (mustConfirm(a)) return { dryRun: true, ...(await wf.iptPreview(a.dpUid)), ...(a.create && !a.key ? { warning: "new resources get termsForUniqueKey [catalogNumber] unless you pass key (e.g. occurrenceID)" } : {}) };
      return wf.iptScan(a.dpUid, { create: a.create, key: a.key, isShareableWithGBIF: a.isShareableWithGBIF, check: a.checkDataCurrency });
    },
  );

  // ---------------- GBIF ----------------

  tool("collectory_gbif_preview", "read", "Which data resources of a provider are older than their GBIF dataset, i.e. what collectory_gbif_scan would reload (reads the GBIF API, writes nothing)", { dpUid: uid("dp") }, async (a) => wf.gbifPreview(a.dpUid));

  tool("collectory_gbif_scan", "write", "Reload from GBIF the resources of a provider whose GBIF dataset is newer (repatriation of known datasets). Returns a loadGuid to follow with collectory_load_status", { dpUid: uid("dp"), dryRun, confirm }, async (a) => {
    if (mustConfirm(a)) return { dryRun: true, ...(await wf.gbifPreview(a.dpUid)) };
    const r = await client.gbifScan(a.dpUid);
    return { ...r, next: r["loadGuid"] ? `poll collectory_load_status {loadGuid: "${String(r["loadGuid"])}"} every minute or two` : undefined };
  });

  tool("collectory_load_status", "read", "Progress of a GBIF load started by collectory_gbif_scan or collectory_repatriation_load (admin page)", { loadGuid: z.string().min(8) }, async (a) => wf.loadStatus(a.loadGuid));

  const repat = {
    country: z.string().regex(/^[A-Z]{2}$/).describe("ISO country code, e.g. ES"),
    recordType: z.string().optional().describe("GBIF dataset type, e.g. OCCURRENCE (default of the page)"),
    dataProviderUid: uid("dp").optional().describe("Provider new resources are attached to"),
    maxDatasets: z.number().int().positive().max(500).optional(),
    minRecordCount: z.number().int().nonnegative().optional(),
    maxRecordCount: z.number().int().positive().optional(),
  };
  tool("collectory_repatriation_search", "read", "GBIF datasets about a country that could be repatriated, with the resources they match in collectory (the Repatriation admin page; reads only)", repat, async (a) => wf.repatriationSearch(a));

  tool(
    "collectory_repatriation_load",
    "write",
    "Load chosen GBIF datasets into collectory (create resources and/or update metadata and connection). Run collectory_repatriation_search with the same query first and pass the guids the user chose",
    { ...repat, datasets: z.array(z.object({ guid: z.string(), addResource: z.boolean().optional(), updateMetadata: z.boolean().optional(), updateConnection: z.boolean().optional() })).min(1), dryRun, confirm },
    async (a) => {
      const { datasets, dryRun: _d, confirm: _c, ...q } = a;
      if (mustConfirm(a)) {
        const s = await wf.repatriationSearch(q);
        const chosen = new Set(datasets.map((d) => d.guid));
        return { dryRun: true, wouldLoad: s.candidates.filter((c) => chosen.has(c.guid)), notFound: datasets.filter((d) => !s.candidates.some((c) => c.guid === d.guid)).map((d) => d.guid) };
      }
      return wf.repatriationLoad(q, datasets);
    },
  );

  tool(
    "collectory_gbif_register",
    "write",
    "Register an entity in the GBIF registry, update its GBIF record, or remove a data resource from GBIF (the buttons of its admin page; needs a person with the GBIF registration role)",
    { uid: uid("dr|dp|in"), action: z.enum(["register", "update", "delete"]), syncDataResources: z.boolean().default(false), syncContacts: z.boolean().default(true), confirm },
    async (a) => {
      const pg = await client.get<Record<string, unknown>>(a.uid);
      const ask = confirmOnly(a, `${a.action} ${a.uid} (${String(pg["name"])}) in the GBIF registry configured in collectory (current GBIF key: ${String(pg["gbifRegistryKey"] ?? "none")})`);
      if (ask) return ask;
      const action = ({ register: "registerGBIF", update: "updateGBIF", delete: "deleteGBIF" } as const)[a.action];
      return wf.gbifRegistration(a.uid, action, a);
    },
  );

  tool("collectory_gbif_health", "read", "GBIF sharing breakdown of the admin page: indexed and shareable records, licence issues, resources not shareable or provided by GBIF", {}, async () => wf.gbifHealth());

  tool("collectory_gbif_organizations", "read", "GBIF organisations of a country that can be imported as data providers", { country: z.string().regex(/^[A-Z]{2}$/) }, async (a) => wf.gbifOrganizations(a.country));

  tool("collectory_gbif_import_organization", "write", "Create a data provider from a GBIF organisation", { organizationKey: z.string().uuid(), confirm }, async (a) => {
    const ask = confirmOnly(a, `create a data provider from GBIF organisation ${a.organizationKey}`);
    return ask ?? wf.gbifImportOrganization(a.organizationKey);
  });

  tool("collectory_gbif_sync_all", "destructive", "Push every data provider, its contacts and resources to the GBIF registry configured in collectory (/ws/syncGBIF). Runs in the background on the server; check collectory_gbif_health before", { confirm }, async (a) => {
    const ask = confirmOnly(a, "update the GBIF registry entries of every data provider and resource in this collectory");
    return ask ?? client.syncGbif();
  });

  return server;
}

export { entityOf };
