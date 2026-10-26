# Development notes (POC)

## What this is, and what it should become

A proof of concept to answer: *can an assistant do the fiddly collectory administration (code mappings, data hubs,
connection parameters, IPT and GBIF syncs) without breaking the registry?* It talks to collectory over HTTP and does
not modify it. As with spatial-mcp and ipt-mcp, a useful outcome is the list of small collectory changes that would make
automation safe by design (Findings, below).

Written against **collectory 6.3.0**, the current release (2026-10-11). Also runs against 5.1.x (ALA production) and
6.0–6.2 (with the limits `collectory_health` reports).

## How it works

```
MCP client ──stdio or Streamable HTTP──▶ collectory-mcp ──HTTP──▶ collectory
                                              │                    ├─ /ws/* web services (JSON)           → Bearer JWT / API key
                                              │                    └─ admin pages (GSP forms)              → a person's session
                                              └─ previews: IPT rss.do, GBIF API (read only)
```

- `src/collectory-client.ts`: the web services, the admin pages (`page`, `submit`), version detection from
  `/openapi/openapi.json` (published by 5.1.x and 6.x) or `/buildInfo`.
- `src/entities.ts`: what `POST /ws/{entity}` writes, from `CrudService` (fields per entity, JSON-in-a-string fields,
  lengths and validators of the domain classes, status/resourceType vocabularies), and the connection parameter checks.
- `src/forms.ts`: the admin forms read live and posted back with only the requested changes. A field or button the
  live form does not have is refused (fail closed).
- `src/workflows.ts`: preview → write → read back, per task (code mapping, hub members, record consumers, connection
  parameters, IPT and GBIF previews and scans, repatriation, GBIF registration, audit).
- `src/server.ts`: the tools. Same pattern as spatial-mcp and la_toolkit_mcp: `dryRun` by default plus `confirm`,
  `next` hints for long jobs, annotations, ` [changes collectory]` on every write, redaction of every output.
- `src/auth.ts`, `src/web-session.ts`, `src/token-store.ts`, `src/redact.ts`: from spatial-mcp.

### Two lanes, because collectory has two auth models

| Lane | Used for | collectory 6.3.0 accepts | 5.1.x accepts |
|---|---|---|---|
| Web services `/ws/*` | entities, `recordsMapping`, hub `memberDataResources`, connection parameters, contacts, `/ws/ipt/scan`, `/ws/gbif/scan`, `/ws/syncGBIF` | `@PermissionRequired(roles, scopes)`: a user JWT with `ROLE_EDITOR`/`ROLE_ADMIN`, or a client JWT with scope `REQUIRED_SCOPES` (`ala/internal`) | API key (`apiKey` header, `Authorization`, body `api_key`…) or a JWT |
| Admin pages | hub institutions/collections, record consumers, IPT scan with `create`, GBIF registration, repatriation, GBIF organisation import, load status, GBIF health | a person's **login session** with the role. Bearer tokens are ignored there, even a person's with `ROLE_ADMIN` (verified on 6.3.0: it starts the OIDC login); so `WebSession` logs in like a browser | the OIDC session (`EditRoleInterceptor`, `AdminRoleInterceptor`) |

### Tool reference

| Tool | Endpoint(s) | Kind |
|---|---|---|
| `collectory_health` | `/openapi/openapi.json`, `/ws/dataHub`, `/ws/contacts/0` (credential probe), `/manage/list` | read |
| `collectory_list`, `collectory_get`, `collectory_count` | `/ws/{entity}`, `/ws/{entity}/{uid}`, `POST /ws/find/{entity}`, `/ws/{entity}/count` | read |
| `collectory_lookup_codes`, `collectory_code_map` | `/ws/lookup/inst/{i}/coll/{c}`; every collection's `recordsProviderMapping` (`POST /ws/find/collection`) plus, with a login, `/providerMap/list` and `show` for maps without a collection | read |
| `collectory_mapping_check` | the resource, `/ws/lookup`; codes from biocache-service `/occurrences/search` facets (`COLLECTORY_BIOCACHE_URL`) or GBIF `occurrence/search` facets by dataset | read |
| `collectory_eml_check` | `/ws/eml/{uid}`, validated with the GBIF EML profile 1.1 schemas (read from rs.gbif.org, xmllint compiled to WebAssembly); GBIF API `dataset/{key}`, `dataset/{key}/document`, `installation/{key}` | read |
| `collectory_contacts`, `collectory_licences` | with a login `/{entity}/edit/{uid}?page=/shared/showContacts`, `/ws/contacts/{id}` and the `editRole` forms (every contact); without, `/ws/{entity}/{uid}/contacts` (published ones only, #193); `/ws/licence` | read |
| `collectory_audit` | the above, over the whole registry | read |
| `collectory_save_entity` | `POST /ws/{entity}[/{uid}]` | write, dry run by default |
| `collectory_dependencies`, `collectory_delete_entity` | `/ws/{entity}/{uid}`, `DELETE /ws/{entity}/{uid}` | read / destructive, confirm |
| `collectory_set_code_mapping` | `POST /ws/collection/{uid}` `recordsMapping`, `/ws/codeMapDump`, `/ws/lookup` | write, dry run by default |
| `collectory_set_hub_members` | `POST /ws/dataHub/{uid}` `memberDataResources`; `/dataHub/edit/{uid}?page=/dataHub/members` → `/dataHub/base` `_action_updateDescription` | write, dry run by default |
| `collectory_set_record_consumers` | `/{dataResource,dataProvider}/editConsumers/{uid}?source=co|in` → `…/base` `_action_updateConsumers` | write, dry run by default |
| `collectory_set_connection_parameters` | `POST /ws/dataResource/{uid}` `connectionParameters` | write, dry run by default |
| `collectory_update_contact`, `collectory_remove_contact` | `POST`/`DELETE /ws/{entity}/{uid}/contacts/{id}` | write, dry run by default / destructive, confirm |
| `collectory_taxonomy_hints`, `collectory_set_taxonomy_hints` | `/{entity}/edit/{uid}?page=/shared/editTaxonomyHints` and `taxonomicRange` → `/{entity}/base` (`_action_updateTaxonomyHints`, `_action_updateTaxonomicRange`) | read / write, dry run by default (admin) |
| `collectory_set_image` (stdio only: reads a local file), `collectory_remove_image` | `/{entity}/edit/{uid}?page=/shared/images` → multipart `/{entity}/image` (`_action_updateImages`, `_action_removeImage`) | write, dry run by default / destructive, confirm (admin) |
| `collectory_add_contact` | `/ws/contacts/email/{e}`, `POST /ws/contacts`, `POST /ws/{entity}/{uid}/contacts/{id}` | write, dry run by default |
| `collectory_ipt_preview` | the provider's IPT `rss.do` + `/ws/find/dataResource` | read |
| `collectory_ipt_scan` | `/ws/ipt/scan/{dp}.json`; with `create`: `/dataProvider/iptScan` (admin page) | write, dry run by default |
| `collectory_gbif_preview`, `collectory_gbif_scan` | GBIF API `dataset/{key}`; `/ws/gbif/scan/{dp}` | read / write |
| `collectory_load_status` | `/manage/externalLoadStatus?loadGuid=` | read (admin) |
| `collectory_repatriation_search`, `collectory_repatriation_load` | `/manage/repatriate` → `searchForRepatResources` → `updateFromExternalSources` | read / write (admin) |
| `collectory_gbif_register` | `/{entity}/registerGBIF|updateGBIF|deleteGBIF/{uid}` | write, confirm (admin) |
| `collectory_gbif_health`, `collectory_gbif_organizations`, `collectory_gbif_import_organization` | `/gbif/healthCheck`, `/dataProvider/searchForOrganizations`, `importFromOrganization` | read / write (admin) |
| `collectory_gbif_sync_all` | `/ws/syncGBIF` | destructive, confirm |
| `collectory_upload_data_file` (stdio only: reads a local file) | `/dataResource/upload/{uid}` (the protocol's parameters) → multipart `/dataResource/uploadDataFile`, verified with `/ws/dataResource/{uid}` and the contacts | write, dry run by default (admin) |
| `collectory_save_licence`, `collectory_delete_licence` | `/licence/list|create|edit|show` admin forms, verified with `/ws/licence` | write, dry run by default / destructive, confirm (admin) |

Sources for the operations: the LA wiki (Data-mappings, Data-Hub, Collectory-entities, Other-ways-to-add-data-resource,
Upload-data, Data-ingestion, Data-Removing, Securing-Collectory-Uploads, Troubleshooting), ALA's data load checklist
(AtlasOfLivingAustralia/data-management#1402), the collectory issues cited below, and the 5.1.1/6.3.0 code.

## Findings about collectory (6.3.0 unless said otherwise)

What the MCP guards against, and what could be fixed or added upstream:

1. **No web service for several routine tasks.** ProviderCode/ProviderMap (except through a collection's
   `recordsMapping`), licences, record consumers and the institution/collection members of a hub can only be changed in
   the admin pages, whose guards list roles but no scope: a machine client cannot do them. Hub `memberDataResources`
   is only applied on update (ignored on create) and must be a JSON-encoded string.
2. **`recordsMapping` replaces every code** of the collection's map. Writing it from a partial view loses codes;
   `collectory_set_code_mapping` reads, merges and checks conflicts first. Duplicate pairs across collections make the
   lookup ambiguous (#206, #214), and nothing in collectory prevents them.
3. **`connectionParameters.url` is hidden** from callers without `ROLE_ADMIN` or the scope. A read-modify-write by such a
   caller erases it; the MCP refuses. collectory never validates connection parameters (`termsForUniqueKey` empty or
   lost made reloads duplicate records: #207, #208, #307).
4. **The IPT scan has no dry run** and always rewrites the EML fields and contacts of matched resources, clearing values
   the IPT does not have; resources are matched by exact `websiteUrl` only (an `http`/`https` difference makes a
   duplicate). `/ws/ipt/scan` refuses `create=true` since 6.3.0; the provider page's button still creates. New resources
   get `termsForUniqueKey: [catalogNumber]` unless `key` is given.
5. **GET requests with side effects**: `registerGBIF`, `updateGBIF`, `deleteGBIF`, `importFromOrganization` and
   `iptScan` change data on a GET (no CSRF protection either).
6. **The repatriation review page puts the GBIF API password in a hidden field** (`repatriateReview.gsp`:
   `configuration.password`), so it reaches every admin's browser. The MCP masks it.
7. **`/admin/gbif/sync` silently does nothing** in 6.3.0: it calls `isAuthorised` with one argument, the exception is
   swallowed. `/ws/syncGBIF` works.
8. **Endpoints that fail with a NullPointerException** because they never resolve the entity (`check()`):
   `GET /ws/dataResource/{uid}/connectionParameters`, `GET /ws/dataHub/{uid}/institutions|collections`, `HEAD
   /ws/{entity}/{uid}`. Dead URL mappings: `/ws/notify`, `/ws/{entity}/contacts/{uid}`.
9. **Contact links**: `notify` is ignored when `POST /ws/{entity}/{uid}/contacts/{id}` creates a link (a second POST,
   which updates it, sets it); `GET /ws/{entity}/{uid}/contacts/{id}` ignores the entity. Reading the code suggested
   that updating an existing link is lost (it binds the link but saves the contact), but the flush persists it: checked
   on 5.1.1 and 6.3.0, so `collectory_update_contact` uses the web service, and unlinking works on 5.1.1 too.
10. **`codeMapDump`** hard-codes ALA's `dp20`/`dh1` (OZCAM) in every row, leaves out maps that match any collection code
    and list none (they still take lookups), and fails (NullPointerException) when a provider map without a collection
    has collection codes. The MCP reads the collections' own mappings instead.
11. **`CrudService.updateExternalIdentifiers`** saves identifiers without linking them to the entity in 6.x (the UI path
    does link them). Treat `externalIdentifiers` writes through the web service as unreliable.
12. **6.0.x**: every single data resource GET and every anonymous protected call answers 500 (`FindBest`), including the
    LA demo at the time of writing. `collectory_health` says so and reads go through `POST /ws/find`.
13. **5.1.x**: deletes through the web service answer "deleted" without being flushed (#287), so they do not happen;
    the MCP reports them as not done. The IPT scan only reports unless `create` is given, and `create` also needs a
    person's login session. Editors are shown `connectionParameters.url` too.

Found while running against a real 6.3.0 (the integration harness):

14. **collectory does not start when `biocacheServicesUrl` refuses connections**: `BootStrap` fetches
    `<biocacheServicesUrl>/facets/i18n` inside a `try/finally` with no `catch`. It also refuses to start without
    `gbifDefaultEntityCountry`, and with OIDC login disabled (no `SSOStrategy` bean) even when only JWTs are used.
15. **Creating a collection through the web service fails** unless the four bounding coordinates are sent (they are not
    nullable; the admin UI fills them with -1). `collectory_save_entity` sends -1, as the UI does.
16. **`hubMembership` of an entity is stale**: it comes from `DataHubService.listDataHubs()`, `@Cacheable('dataHubCache')`,
    which hub edits never evict. The MCP reads the hubs themselves.
17. **A delete can answer before it is committed**: a GET right after `DELETE /ws/…` may still return the entity.
18. **`POST /ws/find/{entity}` answers an array of JSON strings**, not objects (#253, kept for compatibility).
19. **collectory answers requests before Liquibase has finished migrating the schema**: right after start, queries on
    tables still being migrated fail with 500 (`Unknown column contact0_.organization_name`). `harness/up.sh` waits for
    an authenticated contacts query; `collectory_health` mentions it on a 500.
20. **Pages guarded only by `@PermissionRequired` (licences, data resources…) send an anonymous browser to the public
    map** (`/`, the URL mapping of `public/map`) instead of starting the login, and so do 6.x's error pages: a show page
    that fails to render redirects to `/` too. The MCP logs in again when an admin page bounces to `/` (the session may
    have expired), and reports a 403 if it still does; a form save whose landing page bounces is reported and verified
    through the web service.
21. **The licence edit and show forms post to `/ws/licence`** (Grails reverse-maps `licence/index` there) with
    `_action_update`/`_action_delete`, so a browser session is needed on a `/ws/` URL. The licence vocabulary has no
    uniqueness (3.0 vs 3.x duplicates, #289); 5.1.1's `/ws/licence` has no acronym or version, so the MCP reads the
    admin list there.
22. **Every data resource show page fails** when `gbifLicenceMappingUrl` points to a missing file (the default,
    `default-gbif-licence-mapping.json`, which ala-install deploys); `null` uses the built-in mapping.
23. **Provider maps without a collection** (`ProviderMap.collection` is `nullable: true`, and `findMatch` falls back to
    the institution) cannot be created on a database built from `initial.sql` (5.1.1 and 6.3.0: `collection_id`
    `NOT NULL`, a 500), and #214 made the collection mandatory in the form. Older databases may still hold them: they
    make `codeMapDump` fail when they have collection codes, the admin UI cannot delete them (`delete()` reads
    `collection.uid`, NullPointerException), and they take lookups away from collections. The MCP does not create them;
    the conflict check, `collectory_code_map` and the audit include them when there is a login, and a mapping is
    refused (unless `allowConflicts`) when `codeMapDump` fails and they cannot be read.
24. **Codes are compared case-insensitively** by the lookup (MySQL collation), so `mncn` and `MNCN` conflict.

How pipelines uses the mappings (gbif/pipelines `livingatlas`, which `collectory_mapping_check` follows instead of the
wiki's biocache-store steps):

25. `ALAAttributionInterpreter.interpretCodes` looks up **every record that has a collectionCode** in
    `/ws/lookup/inst/{i}/coll/{c}` and takes `collectionUid` and `institutionUid` from the match only. Record consumers
    are not consulted (biocache-store required them, `hasMappedCollections`); collectory uses them to list a resource
    on collection and institution pages. A record without collectionCode gets no collection and no institution;
    `ALADefaultValuesTransform` runs first and fills the resource's `defaultDarwinCoreValues` where a record lacks the
    term (`putIfAbsent`), so the wiki's default collectionCode works. A mapped collection without an institution gives
    its records no `institutionUid` (the lookup answers `institutionUid: null`); the audit flags them. The index
    (biocache-service over pipelines) has `institutionCode`, `collectionCode`, `collectionUid`, `institutionUid` and
    `dataResourceUid`; the check uses one `collectionCode` facet per institution code, so it reports the pairs that occur,
    not a cross product.

Uploading a data file (`/dataResource/uploadDataFile`, `DataImportService.importDataFileForDataResource`; wiki
Upload-data, #207, #208, #307):

26. **Every parameter of the protocol's profile is set from the request**: one not sent becomes null (a checkbox not
    sent, false), so the admin page loses `incremental`, `termsForUniqueKey` or the CSV options unless they are typed
    again (#307). `termsForUniqueKey` falls back to `occurrenceID`; the url becomes the uploaded file. The tool reads the
    profile from the upload page and sends the stored values back. The page itself answers 500 without
    `/data/collectory/config/connection-profiles.json` (the harness mounts ala-install's). The default upload limit is
    25 MB (`grails.controllers.upload.maxFileSize`).
27. **The archive's EML overwrites the resource's metadata** (`EmlImportService.emlFields`: name, guid from packageId,
    description, contact email and phone, rights, citation, coverage, dates, purpose, methods, licence). 6.x clears a
    field the EML has no element for; 5.1.1 keeps it.
28. **6.x syncs contacts from the EML** (`IptService.syncContacts`): links no EML party matches (by last name, first
    name, email, organisation, position) are removed and contacts no other entity uses are deleted. A CSV upload or a
    DwCA without `eml.xml` therefore **removes every contact** of the resource (also in develop). The tool refuses until
    `contacts: "accept"`, or `"restore"`, which re-creates and re-links them after an upload without EML. 5.1.1 only adds
    the EML's contacts, as primary contacts.
29. **The contacts web service lists only published contacts** (`/ws/{entity}/{uid}/contacts`, #193), so a write
    verified through it cannot see an unpublished contact. With a login the tools read the entity's contacts admin page
    instead, with `/ws/contacts/{id}` and each link's `editRole` form.

The EML collectory publishes (`/ws/eml/{uid}`, `EmlRenderService`; #303, #310), checked with the GBIF EML profile 1.1
schema, which collectory itself declares:

30. **5.1.1 never renders valid EML**, whatever the data: no `packageId`, a `rights` element the GBIF profile does not
    have, `citation` written even when empty, and empty `coverage`, `methods` and `intellectualRights` when the fields
    are empty. 6.3.0 fixes these (#318) and the 500 on non-strict taxonomic hints (#311); ALA's dr376, from a build in
    between (whose OpenAPI document still says 5.1.1, so the fixes are told by the symptom, not by the version), has
    `packageId` missing, two licence `ulink`s (near-duplicate licences 4.0/4.x matched by acronym, #289), an empty
    `methods` and `citation` out of order.
31. **6.3.0 (and develop) still render invalid EML** in two cases: `geographicDescription` with `westBoundingCoordinate`
    but not the other three coordinates opens an empty `coverage`; taxonomic hints without a range write an empty
    `generalTaxonomicCoverage`. Without a primary contact with a name, the resource contact is the portal's own
    organisation (the `eml.*` config) and GBIF's validator warns `RESOURCE_CONTACTS_MISSING_OR_INCOMPLETE`. The web
    service writes the bounding box, dates and methods, not `purpose` or the taxonomic hints (admin UI).
32. **Whether GBIF's copy comes from collectory**: GBIF keeps the EML it last crawled (`dataset/{key}/document`) and
    rewrites its `system` attribute, but keeps collectory's `{serverURL}/public/show/{uid}` (the resource's
    `alaPublicUrl`), so finding it there means the copy is collectory's (dr376); a dataset of an `IPT_INSTALLATION` takes
    its EML from the IPT (Flora d'Andorra). The fixes were checked round trip: `collectory_save_entity` with the
    coordinates and `methodStepDescription`, then the check again.

Taxonomy hints, images and attributions (`ProviderGroupController`, form lane):

33. **The taxonomic coverage and range have no web service.** `taxonomyHints` is a JSON of `coverage` (rank/name pairs,
    written to the EML's `taxonomicClassification`) and `range` (written to `generalTaxonomicCoverage`), set only
    through `/{entity}/base` (`_action_updateTaxonomyHints` with `rank_N`/`name_N`, `_action_updateTaxonomicRange` with
    `range`). The web service returns the coverage read-only as `taxonomyCoverageHints` and never the range, so
    `collectory_taxonomy_hints` reads both back from the edit forms (a login). Setting a range is the data-side fix for
    the empty `<generalTaxonomicCoverage/>` of finding 31; `collectory_set_taxonomy_hints` does it and the round trip
    (set, then `collectory_eml_check`) is in the integration suite.
34. **The image/logo upload does not sanitise the filename.** `updateImages` only replaces non-Latin-1 characters; it
    does not call `UploadPathHelper.sanitizeFilename` (which the data upload does), so a crafted name is stored and
    served verbatim, outside the images directory (also in develop; relates to #272). `collectory_set_image` (stdio
    only, like the data upload) sanitises the name itself, refuses path separators, and enforces the 200 KB limit before
    sending. Attributions are written through the ordinary web service (`attributions`), so they need no form.

What would make this safe by design: a JSON API for provider maps, licences, consumers and hub members accepting the
same scope as the other writes; server-side validation of connection parameters; a dry-run mode for the IPT scan;
POST (with CSRF protection) for the GBIF actions; the GBIF password out of the review page; an upload that keeps the
connection parameters it is not given and leaves contacts alone when the file has no EML; a web service for the
taxonomic coverage and range; and `sanitizeFilename` on the image upload.

### Why not a plugin inside collectory?

The same reasons as spatial-mcp: no fork or custom WAR to deploy, no coupling to collectory releases, and the HTTP
transport already gives the "nothing to install" option. The findings above are the useful contribution upstream.

## Tests

| Suite | Runs against | What it pins |
|---|---|---|
| `test/units.test.ts` | — | the EML check on real collectory output (`test/fixtures/eml`: 5.1.1, 6.3.0, ALA's dr376), field rules, connection parameter checks, form parsing and fail-closed filling, CSV and IPT RSS parsing, config, redaction |
| `test/mcp-e2e.test.ts` | fake collectory 6.3.0 (`test/helpers/fake-collectory.ts`) | every workflow over MCP: previews write nothing, merges keep data, conflicts and hidden URLs are refused, form lane with a session, machine token refused on forms, repatriation posts only the chosen rows, secrets masked, 6.0.0 fallback |
| `test/stdio.test.ts` | fake collectory | the server as an MCP client starts it |
| `test/integration/collectory.test.ts` | a real collectory | anonymous: version, refusal; with JWTs from the test issuer and a person's login: create/update, code mapping + lookup + conflict, connection parameters (admin vs editor), hub members by web service and by form (machine and user tokens refused there), record consumers, contacts (an unpublished one seen only with a login), delete with dependencies, data file upload (parameters kept, contacts per version), IPT preview and scan (with and without create), GBIF preview, repatriation search, GBIF organisations, licences (create, update, near-duplicate, delete), EML check, taxonomy hints and range round
trip, image upload with a sanitised filename and removal, audit |

The fake implements the behaviour taken from the 6.3.0 code (CrudService, PermissionInterceptor, the GSP field names).
The guards were mutation-checked: disabling each of the hidden-url refusal, the code merge, the conflict check, the
repatriation row selection, the form fail-closed rule, the dry-run default, the public-map denial, the login-redirect
detection, the delete dependency check (and its reading of the hubs instead of the stale `hubMembership`), the delete
retry, the hub reindex list, the `/ws/find` string parsing, the -1 coordinates of a new collection, the licence
near-duplicate, in-use and vocabulary checks, the login on a bounce to the public map (also with an expired session, and a 403 rather than a login error for a person
without the role), the root of a collectory under a context path, the tolerated landing bounce after a form save, the session on the `/ws/licence`
form post, the 5.x licence fallback, the code mapping conflicts with matchAny maps, in any case, and with maps without
a collection (refused when they cannot be read), the lookup that resolves to an institution, and the contact link
notify, email case, and update preview, and the mapping check verdicts (reprocess vs missing mapping, real pairs, the
default collectionCode suggestion, consumers, a lookup cache per call), the full contact listing with a login, and
the upload's stored parameters sent back, unknown parameters, unique key change, key terms missing from the file,
contact removal refusal, restore refused with an EML, contact restore, and cleared EML fields, and the EML check's
local schema imports, schema hash comparison, duplicate-message merge, element paths, the fixes that depend on the
collectory version and on the party, the #310 diagnosis, the contact warning and the GBIF source (collectory
fingerprint, IPT), and the taxonomy hints and range read back from the forms, the filename sanitising (base name,
separators, non-Latin-1, leading dots), the image size limit and the duplicate file field, makes at least one test
fail.

### Integration harness

```bash
harness/up.sh 6.3.0          # official WAR from nexus.ala.org.au + MySQL 8 + fake OIDC issuer (docker compose)
COLLECTORY_TEST_URL=http://localhost:8080 COLLECTORY_TEST_MINT=http://localhost:4000/mint npm run test:integration
docker compose -p collectory-mcp-it -f harness/docker-compose.yml down -v
```

`harness/issuer.mjs` is a throw-away OIDC provider: collectory validates Bearer JWTs against its discovery document and
JWKS, the tests mint the tokens they need (`/mint`: a machine token with `scope=ala/internal`, or a person's with
roles), and its authorize/token/userinfo endpoints give the browser-like login the admin pages need (accounts
`admin@example.org:admin-pass`, `editor@example.org:editor-pass`). It also serves a two-dataset IPT (`/ipt/rss.do`,
`/ipt/eml.do`) for the scan tests. collectory and the issuer use the host network so both see the same
`http://localhost:4000`. The GBIF tests read the real GBIF API (Flora d'Andorra, Andorra's organisations).

### CI

`.github/workflows/ci.yml`: unit tests on Node 20/22 and build; `npm audit` in its own job (only a warning on the nightly run, Dependabot opens the fix); the integration suite against collectory
6.3.0 and 5.1.1 in the harness; the anonymous suite against the LA demo (nightly too), skipped while it is down.

## License

MPL-2.0. collectory is MPL-1.1 (its `LICENSE.txt`), which allows use under later versions, so MPL-2.0 keeps this
compatible and open to contributing parts upstream. `src/auth.ts`, `web-session.ts`, `token-store.ts` and `redact.ts`
come from spatial-mcp (MPL-2.0). Dependencies are MIT (`xmllint-wasm` is libxml2, MIT). The GBIF EML profile schemas
carry no licence, so they are not copied here: the server and the tests download them from rs.gbif.org (the tests into
`node_modules/.cache`) and compare them with the SHA-256 they were tested with.

## Not covered yet

Creating ProviderMaps of an institution without a collection (fresh schemas refuse them), temp data resources
(sandbox), the OIDC browser login of spatial-mcp (admin pages reject a person's token on 5.1.1 and 6.3.0).
