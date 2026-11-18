// Vercel function: the hosted MCP server (content tools only) at /mcp, plus /health.
// `npm run build` runs first (see vercel.json), so this imports the compiled server.
// Set BRANDRAILS_MCP_TOKEN in the project's environment variables to require a bearer token.
import { fetchHandler } from "../dist/mcp/server.js";

const handle = fetchHandler();

export default {
  fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // A rewrite may hand the function either the public path or /api/mcp; normalise both.
    url.pathname = url.searchParams.has("health") || url.pathname === "/health" ? "/health" : "/mcp";
    return handle(new Request(url, request));
  },
};
