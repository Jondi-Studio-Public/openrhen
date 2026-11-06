import { withRoute } from "@/server/logging";
import { handleMcpRequest } from "@/server/mcp-endpoint";

/**
 * The remote MCP endpoint.
 * It authenticates itself with an audience-bound access token, which is why it is in `OWNER_AUTH_EXEMPT`. Only
 * POST is exported; the framework answers any other method 405.
 */
export const POST = withRoute("/mcp", (request, _context, log) => handleMcpRequest(request, undefined, log));
