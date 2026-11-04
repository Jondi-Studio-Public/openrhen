import { withRoute } from "@/server/logging";
import { calendarsGetHandler, calendarsPutHandler } from "@/server/connections/route-handlers";

type Context = { params: Promise<{ connectionId: string }> };

export const GET = withRoute<Context>("/api/connections/[connectionId]/calendars", async (request, context, log) =>
  calendarsGetHandler((await context.params).connectionId, request, context, log)
);

export const PUT = withRoute<Context>("/api/connections/[connectionId]/calendars", async (request, context, log) =>
  calendarsPutHandler((await context.params).connectionId, request, context, log)
);
