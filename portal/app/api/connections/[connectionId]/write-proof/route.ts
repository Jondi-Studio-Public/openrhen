import { withRoute } from "@/server/logging";
import { writeProofPostHandler } from "@/server/connections/route-handlers";

type Context = { params: Promise<{ connectionId: string }> };

export const POST = withRoute<Context>("/api/connections/[connectionId]/write-proof", async (request, context, log) =>
  writeProofPostHandler((await context.params).connectionId, request, context, log)
);
