import { withRoute } from "@/server/logging";
import { importPreviewHandler } from "@/server/connections/route-handlers";

type Context = { params: Promise<{ connectionId: string }> };

export const POST = withRoute<Context>(
  "/api/connections/[connectionId]/import/preview",
  async (request, context, log) => importPreviewHandler((await context.params).connectionId, request, context, log)
);
