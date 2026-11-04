import { withRoute } from "@/server/logging";
import { publishPostHandler, publishGetHandler } from "@/server/connections/route-handlers";

type Context = { params: Promise<{ connectionId: string }> };

export const POST = withRoute<Context>("/api/connections/[connectionId]/publish", async (request, context, log) =>
  publishPostHandler((await context.params).connectionId, request, context, log)
);

export const GET = withRoute<Context>("/api/connections/[connectionId]/publish", async (request, context, log) =>
  publishGetHandler((await context.params).connectionId, request, context, log)
);
