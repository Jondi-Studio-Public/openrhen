import { withRoute } from "@/server/logging";
import { syncGetHandler, syncPostHandler } from "@/server/connections/route-handlers";

type Context = { params: Promise<{ connectionId: string }> };

/** Runs a calendar source's sync; the worker's scheduled trigger and a "Sync now" click post here. */
export const POST = withRoute<Context>("/api/connections/[connectionId]/sync", async (request, context, log) =>
  syncPostHandler((await context.params).connectionId, request, context, log)
);

/** The most recent run's outcome, for Connections to show and the worker to seed its schedule from. */
export const GET = withRoute<Context>("/api/connections/[connectionId]/sync", async (request, context, log) =>
  syncGetHandler((await context.params).connectionId, request, context, log)
);
