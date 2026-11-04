import { withRoute } from "@/server/logging";
import { handleRegisterRequest } from "@/server/mcp-oauth";

/**
 * Dynamic client registration (RFC 7591) for the remote MCP authorization server
 *: open, public clients only, throttled on failure. It reads no
 * owner credential, which is why it is in `OWNER_AUTH_EXEMPT`.
 */
export const POST = withRoute("/oauth/register", (request) => handleRegisterRequest(request));
