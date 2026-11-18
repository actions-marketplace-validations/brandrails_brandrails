import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createHandler, serveHttp, serveStdio } from "../src/mcp/server.js";
import { CONTENT_TOOLS, localTools } from "../src/mcp/tools.js";

const css = readFileSync(new URL("../examples/react-tailwind/src/index.css", import.meta.url), "utf8");
const handle = createHandler([...CONTENT_TOOLS, ...localTools(process.cwd())]);
let id = 0;
const rpc = (method: string, params?: Record<string, unknown>) => handle({ jsonrpc: "2.0", id: ++id, method, params }) as any;
const callTool = (name: string, args: Record<string, unknown>) => rpc("tools/call", { name, arguments: args }).result;

describe("MCP protocol", () => {
  it("negotiates the client's protocol version and offers tools only", () => {
    const { result } = rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(result.serverInfo.name).toBe("brandrails");
    expect(rpc("initialize", { protocolVersion: "1999-01-01" }).result.protocolVersion).toBe("2025-11-25");
  });

  it("lists tools with explicit boolean annotations, as the ChatGPT directory requires", () => {
    const { tools } = rpc("tools/list").result;
    expect(tools.map((t: { name: string }) => t.name)).toEqual(["extract_tokens", "generate_rules", "check_drift", "generate_in_repo", "check_repo"]);
    for (const t of tools) {
      for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"]) expect(typeof t.annotations[hint]).toBe("boolean");
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("ignores notifications and rejects unknown methods", () => {
    expect(handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
    expect(rpc("nope").error.code).toBe(-32601);
    expect((handle({ hello: 1 }) as any).error.code).toBe(-32600);
  });
});

describe("content tools", () => {
  it("extract_tokens → generate_rules → check_drift round trip", () => {
    const extracted = callTool("extract_tokens", { files: [{ path: "src/index.css", content: css }] });
    expect(extracted.isError).toBe(false);
    const tokensJson = extracted.structuredContent.tokensJson as string;
    expect(JSON.parse(tokensJson).color.accent.$value).toBe("#4f46e5");

    const rules = callTool("generate_rules", { tokens: tokensJson, existing: { "AGENTS.md": "# My project\n\nHand-written.\n" } });
    const files = rules.structuredContent.files as Record<string, string>;
    expect(Object.keys(files)).toContain(".cursor/rules/design.mdc");
    expect(files["AGENTS.md"]).toContain("Hand-written.");
    expect(files["AGENTS.md"]).toContain("brandrails:start");

    const diff = [
      "+++ b/src/Card.tsx",
      "@@ -0,0 +1,2 @@",
      '+<div className="p-[13px]">',
      '+<div className="p-4">',
      "+++ b/src/Card.css",
      "@@ -0,0 +1 @@",
      "+  color: #4f46e6;",
    ].join("\n");
    const drift = callTool("check_drift", { diff, tokens: tokensJson });
    expect(drift.structuredContent.problemCount).toBe(2);
    expect(drift.content[0].text).toContain("color.accent");
  });

  it("follows SCSS partials among the supplied files", () => {
    const result = callTool("extract_tokens", {
      files: [
        { path: "styles/main.scss", content: '@use "tokens";\nbody { margin: 0; }' },
        { path: "styles/_tokens.scss", content: "$color-brand: #ff0066;\n$spacers: (sm: 4px, md: 8px);" },
      ],
    });
    const tokens = JSON.parse(result.structuredContent.tokensJson);
    expect(tokens.color.brand.$value).toBe("#ff0066");
    expect(tokens.spacing.md.$value).toBe("8px");
    expect(result.content[0].text).toMatch(/^Read 3 tokens/);
  });

  it("never reads outside the supplied files", () => {
    const escape = callTool("extract_tokens", { files: [{ path: "../etc/passwd.css", content: "" }] });
    expect(escape.isError).toBe(true);
    expect(escape.content[0].text).toMatch(/stay inside/);

    const viaUse = callTool("extract_tokens", {
      files: [{ path: "main.scss", content: `@use "${process.cwd()}/examples/react-tailwind/src/index";\n@use "../../../../../../${process.cwd()}/test/x";` }],
    });
    expect(viaUse.isError).toBe(false);
    expect(viaUse.structuredContent.tokenCount).toBe(0);
  });

  it("returns bad input as a tool error the model can read", () => {
    const result = callTool("generate_rules", { tokens: "{ not json" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not valid JSON/);
    expect(callTool("check_drift", {}).isError).toBe(true);
  });
});

describe("transports", () => {
  it("serves stateless Streamable HTTP at /mcp", async () => {
    const server = serveHttp({ port: 0, host: "127.0.0.1", token: "secret" });
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (body: unknown, auth = "Bearer secret") =>
      fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: auth }, body: JSON.stringify(body) });
    try {
      expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, "Bearer wrong")).status).toBe(401);
      const list = await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
      // The hosted server must not offer tools that touch its own disk.
      expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["extract_tokens", "generate_rules", "check_drift"]);
      expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
      expect((await fetch(`${base}/mcp`, { headers: { authorization: "Bearer secret" } })).status).toBe(405);
    } finally {
      server.close();
    }
  });

  it("speaks newline-delimited JSON-RPC over stdio", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    serveStdio(process.cwd(), input, output);
    const lines: string[] = [];
    output.setEncoding("utf8").on("data", (d: string) => lines.push(...d.split("\n").filter(Boolean)));
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
    input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    input.write("not json\n");
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    await new Promise((r) => setTimeout(r, 50));
    input.end();
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).result.serverInfo.name).toBe("brandrails");
    expect(JSON.parse(lines[1]).error.code).toBe(-32700);
    expect(JSON.parse(lines[2]).result.tools).toHaveLength(5);
  });
});
