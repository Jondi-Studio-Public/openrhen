import { withRoute } from "@/server/logging";
import { protectedResourceMetadata } from "@/server/mcp-oauth";

/** The same metadata at the path RFC 9728 section 3 gives the `/mcp` resource, which is where `WWW-Authenticate` points. */
export const GET = withRoute("/.well-known/oauth-protected-resource/mcp", (request) =>
  protectedResourceMetadata(request)
);
