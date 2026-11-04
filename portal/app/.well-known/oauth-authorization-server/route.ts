import { withRoute } from "@/server/logging";
import { authorizationServerMetadata } from "@/server/mcp-oauth";

/** RFC 8414 metadata: the token endpoint and `client_credentials`, nothing else. Public. */
export const GET = withRoute("/.well-known/oauth-authorization-server", (request) =>
  authorizationServerMetadata(request)
);
