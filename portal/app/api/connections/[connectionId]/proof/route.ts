import { withRoute } from "@/server/logging";
import { proofGetHandler } from "@/server/connections/route-handlers";

type Context = { params: Promise<{ connectionId: string }> };

export const GET = withRoute<Context>("/api/connections/[connectionId]/proof", async (request, context, log) =>
  proofGetHandler((await context.params).connectionId, request, context, log)
);
