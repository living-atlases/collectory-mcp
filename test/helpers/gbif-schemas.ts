import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchemas, type Schemas } from "../../src/eml-check.ts";

/**
 * The GBIF EML profile schemas, downloaded once from rs.gbif.org into node_modules/.cache (they carry no licence to
 * copy them into this repository). undefined when offline and not cached: the schema tests then skip.
 */
export const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../node_modules/.cache/collectory-mcp/gbif-schema");
const FILES = ["eml-gbif-profile/1.1/eml.xsd", "eml-gbif-profile/1.1/eml-gbif-profile.xsd", "eml-gbif-profile/1.1/dc.xsd", "xml.xsd"];

export async function cachedSchemaDir(): Promise<string | undefined> {
  try {
    for (const f of FILES) {
      const p = join(SCHEMA_DIR, f);
      if (existsSync(p)) continue;
      const res = await fetch(`https://rs.gbif.org/schema/${f}`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`${f}: ${res.status}`);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, await res.text());
    }
    return SCHEMA_DIR;
  } catch {
    return undefined;
  }
}

export async function cachedSchemas(): Promise<Schemas | undefined> {
  const dir = await cachedSchemaDir();
  return dir ? loadSchemas(async (u) => readFileSync(join(dir, u.replace(/^local:\/\/schema\//, "")), "utf8"), "local://schema") : undefined;
}
