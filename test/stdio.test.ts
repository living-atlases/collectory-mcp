import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startFakeCollectory } from "./helpers/fake-collectory.ts";

describe("the stdio server, as an MCP client starts it", () => {
  let fake: Awaited<ReturnType<typeof startFakeCollectory>>;
  before(async () => {
    fake = await startFakeCollectory();
    fake.add("dataHub", { uid: "dh1", name: "Hub" });
  });
  after(() => fake.close());

  it("starts from the environment, answers tools/list and a read tool", async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/stdio.ts"], env: { ...(process.env as Record<string, string>), COLLECTORY_URL: fake.base, COLLECTORY_TOKEN: "m2m-token" }, stderr: "pipe" });
    const mcp = new Client({ name: "smoke", version: "0" });
    await mcp.connect(transport);
    try {
      const { tools } = await mcp.listTools();
      assert.ok(tools.some((t) => t.name === "collectory_health"));
      const r = (await mcp.callTool({ name: "collectory_list", arguments: { entity: "dataHub" } })) as { content: Array<{ text: string }> };
      assert.deepEqual(JSON.parse(r.content[0]!.text), { count: 1, items: [{ uid: "dh1", name: "Hub" }] });
    } finally {
      await mcp.close();
    }
  });
});

describe("the HTTP transport", () => {
  it("forwards the caller's own bearer token to collectory and serves /health", async () => {
    const { startHttp } = await import("../src/http.ts");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const { loadConfig } = await import("../src/config.ts");
    const fake = await startFakeCollectory();
    fake.add("dataResource", { uid: "dr1", name: "R" });
    const http = await startHttp(loadConfig(["--collectory", fake.base], {}), 0, "127.0.0.1");
    const port = (http.address() as { port: number }).port;
    try {
      assert.equal((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).ok, true);
      const mcp = new Client({ name: "http", version: "0" });
      await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: "Bearer m2m-token" } } }));
      const r = (await mcp.callTool({ name: "collectory_save_entity", arguments: { uid: "dr1", fields: { citation: "c" }, dryRun: false, confirm: true } })) as { isError?: boolean; content: Array<{ text: string }> };
      assert.ok(!r.isError, r.content[0]!.text);
      assert.ok(fake.state.requests.some((q) => q.method === "POST" && q.auth === "m2m-token"));
      assert.ok(!r.content[0]!.text.includes("m2m-token"));
      await mcp.close();
    } finally {
      http.close();
      await fake.close();
    }
  });
});
