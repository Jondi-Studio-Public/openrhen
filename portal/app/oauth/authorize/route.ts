import { withRoute } from "@/server/logging";
import { handleAuthorizeRequest } from "@/server/mcp-authorize";

/**
 * The owner's consent step of the authorization-code flow. Always
 * served, like `/oauth/register`: it checks the owner credential itself, which is why GET and POST are in
 * `OWNER_AUTH_EXEMPT`.
 */
export const GET = withRoute("/oauth/authorize", (request) => handleAuthorizeRequest(request));
export const POST = withRoute("/oauth/authorize", (request) => handleAuthorizeRequest(request));
