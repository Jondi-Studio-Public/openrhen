import { z } from "zod";
import { redact, withRoute } from "@/server/logging";
import { InvalidCommandError } from "@/server/persistence/postgres/command-errors";
import { getStateStore } from "@/server/persistence/state-store";
import {
  buildDeviceSnapshot,
  deviceETag,
  planArriveCommand,
  planAtOriginCommand,
  planOnMyWayCommand,
  planStartCommand,
  readDeviceCheckIn,
  resolveDeviceCommandId
} from "@/server/device/device-now";
import { clearCachedDeviceState } from "@/server/device/device-state-cache";
import type { PortalState } from "@/state/portal-state";

/**
 * The id the device mints for one button tap, echoed back on every retry of that same tap
 * (the handheld firmware's network code). 8-64 characters keeps a genuine uuid (36 chars) comfortably inside the
 * range while still admitting a shorter test id; the charset is exactly what a uuid uses plus nothing
 * else, so a malformed value fails loudly here rather than reaching `stableUuid`
 * (`resolveDeviceCommandId`) as a surprise. Optional: older firmware that has not been reflashed since
 * the 60-second-heuristic removal never sends one, and the route falls back to minting its own id per
 * call, exactly as it always has.
 */
const deviceCommandIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9-]{8,64}$/, "commandId must be 8-64 characters of letters, digits and hyphens.");

/**
 * What the ESP32 handheld's four buttons do. The device never builds a command itself — it names
 * what it wants ("start", "stop", "arrived", "check_in") and the server resolves the rest from
 * current state, the same way `GET /api/device/now` describes what's on the clock. Kept local rather
 * than in `platform/contracts`: this is a device-specific vocabulary layered over the existing
 * session/activity/entity commands, not a new contract those commands need to know about.
 */
const deviceActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), commandId: deviceCommandIdSchema.optional() }),
  z.object({
    type: z.literal("stop"),
    outcome: z.enum(["completed", "unsure"]).optional(),
    commandId: deviceCommandIdSchema.optional()
  }),
  z.object({ type: z.literal("arrived"), commandId: deviceCommandIdSchema.optional() }),
  z.object({ type: z.literal("on_my_way"), commandId: deviceCommandIdSchema.optional() }),
  z.object({ type: z.literal("at_origin"), commandId: deviceCommandIdSchema.optional() }),
  z.object({
    type: z.literal("check_in"),
    promptId: z.string().uuid("promptId must be a uuid."),
    answer: z.enum(["yes", "no", "unsure"]),
    commandId: deviceCommandIdSchema.optional()
  })
]);

export const POST = withRoute("/api/device/action", async (request, _context, log) => {
  const parsed = deviceActionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json({ error: "Device action validation failed.", issues: parsed.error.issues }, { status: 400 });
  log.setCommandType(parsed.data.type);

  const store = getStateStore();
  // Deliberately uncached: this is a read-modify-write against the current row, so it must never see
  // the poll cache's possibly-stale snapshot (`device-state-cache.ts`).
  const state = (await store.get()) as PortalState | null;
  if (!state) return Response.json({ error: "State is unavailable." }, { status: 503 });
  const now = new Date();

  /** Every branch below ends here: the fresh, GET-shaped snapshot of whatever the command produced. */
  const respond = async (updated: PortalState) => {
    // The write just changed what the next poll should see, so the cache built from the pre-action
    // state can't be allowed to answer it.
    clearCachedDeviceState();
    const checkIn = await readDeviceCheckIn();
    const snapshot = buildDeviceSnapshot(updated, new Date(), checkIn);
    // Quoted, and `no-store`, for the same reasons `GET /api/device/now` is: this is the same
    // snapshot shape, and the device compares the tag it gets here against its next poll's.
    return Response.json(snapshot, {
      headers: { "Cache-Control": "no-store", ETag: deviceETag(snapshot.stateVersion) }
    });
  };

  // The device's own id for this tap, resolved to the uuid it will actually be stored under
  // (`resolveDeviceCommandId`). Checked against `writes` *before* any state-based
  // precondition below runs: a first POST that applied its write but never got its response back (a
  // timeout, a dropped reply) leaves those preconditions false on the identical retry — "nothing to
  // start", "nothing being tracked" — even though the retry names the exact command that already
  // succeeded. Replaying the current snapshot here answers the retry the way the first request would
  // have, rather than letting a now-stale precondition turn a genuine success into a false 409.
  const commandId = parsed.data.commandId ? await resolveDeviceCommandId(parsed.data.commandId) : null;
  if (commandId && (await store.hasCommandReceipt(commandId))) return respond(state);
  const effectiveCommandId = commandId ?? crypto.randomUUID();

  switch (parsed.data.type) {
    case "start": {
      const planned = planStartCommand(state, now, effectiveCommandId);
      if (!planned) return Response.json({ error: "Nothing to start right now." }, { status: 409 });
      if (planned.kind === "blocked") return Response.json({ error: planned.reason }, { status: 409 });
      return respond(
        planned.kind === "session"
          ? await store.runSessionCommand(planned.command)
          : await store.runActivityCommand(planned.command)
      );
    }
    case "stop": {
      const session = state.activeSession;
      if (!session || (session.status !== "running" && session.status !== "paused"))
        return Response.json({ error: "Nothing is being tracked." }, { status: 409 });
      const isActionSession = !session.targetType || session.targetType === "action";
      return respond(
        isActionSession
          ? await store.runSessionCommand({
              commandId: effectiveCommandId,
              expectedVersion: session.version ?? null,
              type: "finish",
              sessionId: session.id,
              outcome: parsed.data.outcome === "completed" ? "completed" : "unsure"
            })
          : await store.runActivityCommand({
              commandId: effectiveCommandId,
              expectedVersion: session.version ?? null,
              type: "finish_activity",
              sessionId: session.id,
              outcome: parsed.data.outcome === "completed" ? "completed" : "stopped"
            })
      );
    }
    case "arrived": {
      const command = planArriveCommand(state, now, effectiveCommandId);
      if (!command) return Response.json({ error: "No arrival is pending." }, { status: 409 });
      return respond(await store.saveEntity(command));
    }
    case "on_my_way": {
      const command = planOnMyWayCommand(state, now, effectiveCommandId);
      if (!command) return Response.json({ error: "No leave-by leg to confirm." }, { status: 409 });
      return respond(await store.saveEntity(command));
    }
    case "at_origin": {
      const command = planAtOriginCommand(state, now, effectiveCommandId);
      if (!command) return Response.json({ error: "No assumed origin to confirm." }, { status: 409 });
      return respond(await store.saveEntity(command));
    }
    case "check_in": {
      try {
        return respond(
          await store.runCheckInCommand({
            commandId: effectiveCommandId,
            expectedVersion: null,
            type: "answer_check_in",
            checkInId: parsed.data.promptId,
            status: parsed.data.answer === "yes" ? "on_track" : parsed.data.answer === "no" ? "deviated" : "unknown",
            answerSource: "in_app_banner"
          })
        );
      } catch (error) {
        // device-api.md: 409 means the plan changed under the tap. A check-in that has since timed out,
        // been answered or been superseded is exactly that, not a malformed body (400), so a device
        // that treats 400 as "do not retry" does not drop a legitimately stale tap as a client bug.
        if (error instanceof InvalidCommandError)
          return Response.json({ error: redact(error.message) }, { status: 409 });
        throw error;
      }
    }
  }
});
