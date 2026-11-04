import { requestAgent } from "@/server/agent-actor";
import { databaseJournalStore } from "@/server/agent-journal-runner";
import { withRoute } from "@/server/logging";

const ENTRY_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Undoes one agent write, or puts it back (`{ redo: true }`), for the owner's "Agent changes" list. The id is a row
 * of the write ledger (the list's `writeId`, which is also its `id`), reverted by the server's own revert command
 * run as the owner, which may undo any agent's write and, with `force`, overwrite a later edit; a refusal comes back
 * as the command's own 404 or 409. An id that is not an agent write in the ledger answers 404. Owner only: an agent
 * token is refused here (and by the route map), so an agent cannot reverse its own or another agent's writes by this
 * door; it has `rhen_undo` for its own.
 */
export const POST = withRoute<{ params: Promise<{ id: string }> }>(
  "/api/agent-changes/[id]/undo",
  async (request, context, log) => {
    if (requestAgent() !== null)
      return Response.json({ error: "Undoing agent changes is for the owner." }, { status: 403 });
    const { id } = await context.params;
    if (!ENTRY_ID.test(id)) return Response.json({ error: "No agent change has that id." }, { status: 404 });
    const raw = (await request.text()).trim();
    let body: unknown = {};
    if (raw !== "") {
      try {
        body = JSON.parse(raw);
      } catch {
        return Response.json({ error: "Send { redo } as a JSON object." }, { status: 400 });
      }
    }
    if (body === null || typeof body !== "object" || Array.isArray(body))
      return Response.json({ error: "Send { redo } as a JSON object." }, { status: 400 });
    const redo = (body as { redo?: unknown }).redo;
    if (redo !== undefined && typeof redo !== "boolean")
      return Response.json({ error: "redo must be true or false." }, { status: 400 });
    const force = (body as { force?: unknown }).force;
    if (force !== undefined && typeof force !== "boolean")
      return Response.json({ error: "force must be true or false." }, { status: 400 });
    log.setCommandType(redo === true ? "redo_agent_change" : "undo_agent_change");

    const store = await databaseJournalStore();
    if (!store) return Response.json({ error: "Agent changes require PostgreSQL." }, { status: 503 });
    // The owner's own revert command, as `/api/commands/revert` runs it for the owner, so the checks, the refusal to
    // overwrite a later edit and `writes.state` are the server's.
    const ledger = await store.ledgerWrite?.(id).catch(() => undefined);
    if (ledger === undefined && store.ledgerWrite) {
      return Response.json({ error: "The portal could not read that change; try again." }, { status: 503 });
    }
    if (ledger && store.revertLedgerWrite) {
      await store.revertLedgerWrite({
        commandId: crypto.randomUUID(),
        target: ledger.id,
        direction: redo === true ? "redo" : "undo",
        ...(force === true ? { force: true } : {})
      });
      return Response.json({ ok: true, direction: redo === true ? "redo" : "undo", id: ledger.id });
    }
    return Response.json({ error: "No agent change has that id." }, { status: 404 });
  }
);
