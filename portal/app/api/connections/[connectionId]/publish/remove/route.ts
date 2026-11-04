import { withRoute } from "@/server/logging";
import { publishRemoveHandler } from "@/server/connections/route-handlers";

type Context = { params: Promise<{ connectionId: string }> };

export const POST = withRoute<Context>(
  "/api/connections/[connectionId]/publish/remove",
  async (request, context, log) => publishRemoveHandler((await context.params).connectionId, request, context, log)
);
