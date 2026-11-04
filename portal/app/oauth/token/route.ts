import { withRoute } from "@/server/logging";
import { handleTokenRequest } from "@/server/mcp-oauth";

/**
 * The token endpoint of the remote MCP authorization server:
 * `client_credentials` (the long-lived agent token as `client_secret`), `authorization_code` + PKCE and
 * `refresh_token` for public clients. It checks those credentials itself, which is why it is in `OWNER_AUTH_EXEMPT`.
 */
export const POST = withRoute("/oauth/token", (request) => handleTokenRequest(request));
