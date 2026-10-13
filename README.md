# collectory-mcp

> **Proof of concept.** Try it on a test portal first.

An [MCP](https://modelcontextprotocol.io) server that lets an assistant (Claude, or any MCP client) do the routine,
fiddly administration of a Living Atlas **collectory**: the registry of institutions, collections, data providers,
data resources and data hubs. It talks to collectory over HTTP, like a person or a script would, and changes nothing in
collectory itself.

It works like its siblings [spatial-mcp](https://github.com/living-atlases/spatial-mcp) and
[ipt-mcp](https://github.com/vjrj/ipt-mcp): every change is previewed first and only made after you agree.

## What you can do with it

- **Map institution and collection codes to collections** (the wiki's *Data mappings* procedure): add or remove codes
  without losing the existing ones, with a check against every other mapping (duplicates break lookups) and a lookup
  afterwards to prove records will resolve.
- **Check the data mappings of a resource**, following the wiki page step by step: which institutionCode/collectionCode
  pairs its records carry, whether each resolves to a collection, is missing a mapping or only needs a reprocess,
  records without collectionCode (and the default value that fixes it), and its record consumers. With the portal's
  index it also lists the resources whose records have codes that resolved to no collection.
- **Maintain data hubs**: add or remove data resources, collections and institutions, and get the list of data
  resources to reprocess and reindex so the hub shows them.
- **Edit connection parameters safely**: change the protocol, URL, unique key terms or the incremental flag without
  losing the rest, and refuse saves that would leave a records resource without unique key terms (reloads would then
  duplicate every record).
- **Sync with an IPT**: see what a scan would change *before* running it (metadata that would be overwritten, new
  datasets, datasets whose URL does not match and would be duplicated), then scan.
- **Upload a data file** (local server only) to a data resource keeping its connection parameters (incremental, unique
  key terms, CSV options), with a preview of the metadata the archive's EML overwrites or clears and of the contacts
  collectory would unlink, which it refuses unless you say so (or re-links them after a CSV upload).
- **GBIF**: see which resources are older than their GBIF dataset and reload them; search the datasets of a country to
  repatriate and load the ones you choose; register or update entities in the GBIF registry; import GBIF
  organisations as data providers; check the GBIF sharing summary.
- **Everyday edits**: create institutions, collections, providers and resources, change fields (with a preview of each
  change), add contacts and change their role or flags or unlink them (unpublished contacts too, with a login), set
  an entity's taxonomic coverage and range, upload its image or logo (local server), check what refers to an entity
  before deleting it.
- **Licences**: add or update the licences resources can choose, refusing near-duplicates (3.0 vs 3.x), and refuse to
  delete one that resources still use.
- **Check the EML** collectory publishes for each data resource against the GBIF EML profile, as GBIF does, with what
  fixes each problem (a field, the portal's config, or upgrading collectory), and whether GBIF's copy of the metadata
  comes from collectory or from an IPT.
- **Find problems**: resources without licence (or with one outside the vocabulary) or unique key terms, broken
  website URLs, hub members that no longer exist, ambiguous code mappings (including those that match any collection
  code, and provider maps without a collection left in old databases), collections nothing maps to.

## Before you start

- A collectory **5.1.x or 6.x** (6.3.0 or later recommended).
- Credentials, depending on what you want to do:
  - **Reading**: nothing.
  - **Web service changes** (entities, code mappings, data resource hub members, connection parameters, contacts, IPT
    and GBIF scans): an access token of a user with `ROLE_EDITOR`/`ROLE_ADMIN`, or a machine client whose token
    carries the scope collectory expects (`ala/internal` by default). On 5.1.x, the legacy API key also works.
  - **Admin pages** (hub institutions and collections, record consumers, licences, GBIF registration, repatriation,
    creating resources from an IPT, data file uploads): a **person's** account with `ROLE_EDITOR`/`ROLE_ADMIN`, which the server uses to log in
    like a browser. collectory ignores tokens on those pages.

## Install

```bash
npm install && npm run build
```

Claude Code:

```bash
claude mcp add collectory -e COLLECTORY_URL=https://collections.example.org -e COLLECTORY_USERNAME=you@example.org -- node /path/to/collectory-mcp/dist/stdio.js
```

Other clients (JSON config):

```json
{
  "mcpServers": {
    "collectory": {
      "command": "node",
      "args": ["/path/to/collectory-mcp/dist/stdio.js"],
      "env": {
        "COLLECTORY_URL": "https://collections.example.org",
        "COLLECTORY_OIDC_ISSUER": "https://auth.example.org/cas/oidc",
        "COLLECTORY_OIDC_CLIENT_ID": "collectory-mcp",
        "COLLECTORY_OIDC_CLIENT_SECRET": "…",
        "COLLECTORY_USERNAME": "you@example.org"
      }
    }
  }
}
```

The password of `COLLECTORY_USERNAME` is never put in the config: store it once, from a terminal, in the OS keyring
(or a 0600 file where there is none):

```bash
COLLECTORY_URL=https://collections.example.org COLLECTORY_USERNAME=you@example.org node dist/stdio.js set-password
```

| Variable | Meaning |
|---|---|
| `COLLECTORY_URL` | collectory base URL, without `/ws` (default: the LA demo) |
| `COLLECTORY_READONLY=1` | refuse every change (previews still work) |
| `COLLECTORY_TOKEN` | a Bearer access token |
| `COLLECTORY_OIDC_ISSUER` or `_TOKEN_URL`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_SCOPE` | client credentials grant (token cached and renewed); `_USERNAME`/`_PASSWORD` for the password grant |
| `COLLECTORY_API_KEY` | legacy API key (5.1.x) |
| `COLLECTORY_USERNAME` | person for the admin pages (password from `set-password`) |
| `COLLECTORY_BIOCACHE_URL` | biocache-service of the portal (e.g. `https://biocache-ws.ala.org.au/ws`), to read the codes in the indexed records (as of their last processing) for the mapping check; without it the codes come from GBIF for datasets registered there |
| `COLLECTORY_GBIF_API` | GBIF API used for previews (default `https://api.gbif.org/v1`) |
| `COLLECTORY_GBIF_SCHEMA_URL` | where the GBIF EML profile schemas are read from (default `https://rs.gbif.org/schema`) |

## Things to ask

- "Check my collectory: version, what my credentials can do, and any problems in the registry."
- "Records with institutionCode MNCN and collectionCode ENT should go to the Entomology collection. Set it up."
- "Add dr12 and dr15 and the Herbarium collection to the Plants hub. Which resources do I need to reindex?"
- "dr40 reloads keep duplicating records. Look at its connection parameters and fix the unique key."
- "What would an IPT scan of dp3 change? … Go ahead, and create the new datasets with occurrenceID as key."
- "Which of dp5's resources are out of date with GBIF? Reload them and tell me when it finishes."
- "List the GBIF datasets about Spain we could repatriate, with more than 10 000 records."
- "Register dr22 in GBIF."
- "Check the data mappings of dp3's resources and fix what is missing."

## Is it safe?

- Every change is a **dry run** unless the assistant passes `dryRun:false` *and* `confirm:true`, which it is told to
  do only after showing you the preview. Deletes, scans and GBIF actions ask for `confirm:true`.
- Before writing, it refuses what collectory would silently ignore or reject (unknown fields, too-long values,
  website URLs without `http`, conflicting code mappings, connection parameters it cannot read back in full).
- After writing, it reads the entity back and says if something did not stick.
- Admin forms are read live and posted back with only the requested fields changed; if a collectory release renames a
  field, the change is refused instead of half-applied.
- Passwords, tokens and keys are masked in everything the assistant sees. `COLLECTORY_READONLY=1` disables changes.

## Using it without installing anything (for portal operators)

`collectory-mcp-http` (or the Docker image) serves the same tools over Streamable HTTP at `/mcp`, stateless, with the
caller's own Bearer token forwarded to collectory and never stored. Run it next to collectory behind the same proxy.
Limitation: collectory's admin pages ignore tokens, so over HTTP only the web service tools work (everything except hub
institutions/collections, record consumers, licences, GBIF registration and repatriation, and creating resources from
an IPT).

## More

[DEVELOPMENT.md](DEVELOPMENT.md): how it works, tool reference, findings about collectory, tests. License: MPL-2.0.
