import { withRoute } from "@/server/logging";
import { protectedResourceMetadata } from "@/server/mcp-oauth";

/** RFC 9728 metadata for the remote MCP resource. Public by design. */
export const GET = withRoute("/.well-known/oauth-protected-resource", (request) => protectedResourceMetadata(request));
