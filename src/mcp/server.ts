import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { CONTENT_TOOLS, LIMITS, localTools, type Tool } from "./tools.js";

/**
 * A Model Context Protocol server with no dependencies: JSON-RPC 2.0 over stdio (Claude Code,
 * Cursor, Codex, Claude Desktop) or stateless Streamable HTTP (ChatGPT apps, Claude connectors).
 * Only the tools capability is offered.
 */

const VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
  } catch {
    // Bundled by a serverless host without package.json next to it.
    return "unknown";
  }
})();
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `Brandrails keeps AI-written UI on a project's design system.
1. extract_tokens: send the project's main stylesheet(s) (Tailwind @theme, :root custom properties, SCSS, angular.json) to get one DTCG tokens.json.
2. generate_rules: send tokens.json to get rules files for AGENTS.md, CLAUDE.md, Cursor, Copilot and Figma Make. Write them to the repository as returned.
3. check_drift: send a git diff or files to find hard-coded colours and px values that should use tokens.
Use token names from tokens.json in any UI code you write.`;

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type RpcResponse = { jsonrpc: "2.0"; id: string | number | null } & ({ result: unknown } | { error: { code: number; message: string } });

export function createHandler(tools: Tool[]) {
  const byName = new Map(tools.map((t) => [t.name, t]));

  function call(params: Record<string, unknown> = {}) {
    const tool = byName.get(String(params.name));
    if (!tool) throw Object.assign(new Error(`Unknown tool: ${params.name}`), { code: -32602 });
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    try {
      const { text, data } = tool.run(typeof args === "object" && args ? args : {});
      return { content: [{ type: "text", text }], structuredContent: data, isError: false };
    } catch (error) {
      // Bad input and things like a missing tokens.json go back to the model as a tool error, so it can fix the call.
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  }

  function dispatch(req: RpcRequest): unknown {
    switch (req.method) {
      case "initialize": {
        const asked = String(req.params?.protocolVersion ?? "");
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "brandrails", title: "Brandrails", version: VERSION },
          instructions: INSTRUCTIONS,
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations: { title, ...annotations } })),
        };
      case "tools/call":
        return call(req.params);
      // Some clients ask for these even when the capability is not offered.
      case "resources/list":
        return { resources: [] };
      case "resources/templates/list":
        return { resourceTemplates: [] };
      case "prompts/list":
        return { prompts: [] };
      default:
        throw Object.assign(new Error(`Method not found: ${req.method}`), { code: -32601 });
    }
  }

  /** Handles one JSON-RPC message; returns undefined for notifications. */
  return function handle(message: unknown): RpcResponse | undefined {
    const req = message as RpcRequest;
    if (!req || typeof req !== "object" || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      return { jsonrpc: "2.0", id: (req as RpcRequest)?.id ?? null, error: { code: -32600, message: "Invalid request" } };
    }
    const isNotification = req.id === undefined;
    try {
      const result = dispatch(req);
      return isNotification ? undefined : { jsonrpc: "2.0", id: req.id!, result };
    } catch (error) {
      if (isNotification) return undefined;
      const code = (error as { code?: number }).code ?? -32603;
      return { jsonrpc: "2.0", id: req.id!, error: { code, message: error instanceof Error ? error.message : String(error) } };
    }
  };
}

const PARSE_ERROR: RpcResponse = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };

/** Newline-delimited JSON-RPC on stdin/stdout. Offers the local repository tools too. */
export function serveStdio(cwd = process.cwd(), input: Readable = process.stdin, output: Writable = process.stdout): void {
  const handle = createHandler([...CONTENT_TOOLS, ...localTools(cwd)]);
  const rl = createInterface({ input, crlfDelay: Infinity });
  const send = (r: RpcResponse | undefined) => r && output.write(JSON.stringify(r) + "\n");
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return send(PARSE_ERROR);
    }
    if (Array.isArray(message)) message.forEach((m) => send(handle(m)));
    else send(handle(message));
  });
}

export interface HttpOptions {
  port: number;
  host: string;
  /** When set, requests need `Authorization: Bearer <token>`. */
  token?: string;
}

interface HttpReply {
  status: number;
  headers: Record<string, string>;
  body?: string;
}

class TooLarge extends Error {}

/**
 * Stateless Streamable HTTP, shared by the Node server and the fetch handler. Content tools only:
 * a hosted server must not touch its own disk.
 */
function httpResponder(token?: string) {
  const handle = createHandler(CONTENT_TOOLS);
  const json = (status: number, body: unknown, headers: Record<string, string> = {}): HttpReply => ({
    status,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return async (method: string, path: string, authorization: string | null | undefined, readBody: () => Promise<string>): Promise<HttpReply> => {
    if (path === "/health") return json(200, { ok: true, version: VERSION });
    if (path !== "/mcp") return json(404, { error: "Not found. The MCP endpoint is /mcp." });
    if (token && authorization !== `Bearer ${token}`) return json(401, { error: "Unauthorized" }, { "www-authenticate": "Bearer" });
    // Stateless: no server-initiated stream and no sessions to end.
    if (method !== "POST") return json(405, { error: "Use POST." }, { allow: "POST" });
    let body: string;
    try {
      body = await readBody();
    } catch (error) {
      if (error instanceof TooLarge) return json(413, { error: "Request too large." });
      throw error;
    }
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      return json(400, PARSE_ERROR);
    }
    const responses = (Array.isArray(message) ? message : [message]).map(handle).filter(Boolean);
    if (!responses.length) return { status: 202, headers: {} };
    return json(200, Array.isArray(message) ? responses : responses[0]);
  };
}

const MAX_BODY = LIMITS.bytes * 2;

/** Node HTTP server for `brandrails mcp --http`. */
export function serveHttp({ port, host, token }: HttpOptions): Server {
  const respond = httpResponder(token);
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const reply = await respond(req.method ?? "GET", path, req.headers.authorization, () => readBody(req, MAX_BODY));
    res.writeHead(reply.status, reply.headers).end(reply.body);
  });
  server.listen(port, host);
  return server;
}

/**
 * Web-standard handler for serverless hosts (Vercel, Cloudflare, Deno). `/api/mcp` is treated as `/mcp`
 * so it works behind a rewrite or without one.
 */
export function fetchHandler(token = process.env.BRANDRAILS_MCP_TOKEN || undefined) {
  const respond = httpResponder(token);
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname.replace(/^\/api\//, "/").replace(/\/$/, "") || "/";
    const reply = await respond(request.method, path, request.headers.get("authorization"), async () => {
      if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) throw new TooLarge();
      const text = await request.text();
      if (Buffer.byteLength(text) > MAX_BODY) throw new TooLarge();
      return text;
    });
    return new Response(reply.body ?? null, { status: reply.status, headers: reply.headers });
  };
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on("end", () => (size > limit ? reject(new TooLarge()) : resolve(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", reject);
  });
}
