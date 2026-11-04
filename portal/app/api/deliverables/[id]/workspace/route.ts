import { notFoundResponse } from "@/server/not-found-response";
import type { z } from "zod";
import { workspaceMoveRequestSchema } from "@openrhen/contracts";
import { revertibleAnswer } from "@/server/agent-revertible";
import { redact, withRoute } from "@/server/logging";
import {
  CommandConflictError,
  CommandIdReusedError,
  CommittedReadFailedError,
  InvalidCommandError
} from "@/server/persistence/postgres/command-errors";
import { applyWorkspaceTool } from "@/server/deliverables/workspace-moves";
import { commandRequestHash } from "@/server/persistence/postgres/command-receipt";
import { getStateStore } from "@/server/persistence/state-store";
import type { PortalState } from "@/state/portal-state";
import type { WorkspaceToolCall } from "@/server/imports/openai-deliverable-chat";

function summarizeZodIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

/**
 * Applies one workspace move on behalf of an external coordinator (a CLI agent or desktop AI app
 * driving `rhen deliverable ...`), through the same `applyWorkspaceTool` the built-in chat
 * uses — same version guard, same blocker dedupe, same session rollover — but with the running-session
 * requirement switched off: an external coordinator has no browser tab with an unsaved draft to
 * protect. See the external coordination design note, "API contract (the seam)".
 *
 * A move is one deliverable save, so an agent's move is imaged under the caller's `commandId` and answers
 * `revertible` (`rhen_undo`, Review > Agent changes). The blocker feedback `resolve_blocker` retains as a
 * source is a second store and is not imaged.
 */
export const POST = withRoute(
  "/api/deliverables/[id]/workspace",
  async (request: Request, { params }: { params: Promise<{ id: string }> }, log) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "The request is not valid JSON." }, { status: 400 });
    }
    const parsed = workspaceMoveRequestSchema.safeParse(body);
    if (!parsed.success) return Response.json({ error: summarizeZodIssues(parsed.error) }, { status: 400 });
    const { id } = await params;
    const state = (await getStateStore().get()) as PortalState | null;
    const deliverable = state?.deliverables.find((item) => item.id === id);
    if (!deliverable) return notFoundResponse("deliverable", id);
    // A repeat of a move that already landed (its answer was lost) replays before the move is checked against the
    // phase it already moved the deliverable out of, which would call it stale. The receipt must be this move: the
    // same deliverable and call. An id from any other write answers 409 (CommandIdReusedError).
    const { commandId } = parsed.data;
    const requestHash = commandRequestHash("deliverable_move", { deliverableId: id, call: parsed.data.call });
    if (
      commandId &&
      (await getStateStore().hasCommandReceiptFor({ id: commandId, commandType: "deliverable", requestHash }))
    )
      return Response.json({
        summary: "That move was already recorded under this command id.",
        applied: true,
        replayed: true,
        deliverable,
        ...(await revertibleAnswer(commandId))
      });
    try {
      const {
        summary,
        applied,
        state: updated
      } = await applyWorkspaceTool(id, parsed.data.call as WorkspaceToolCall, {
        requireSession: false,
        commandId,
        requestHash
      });
      const after = (updated as PortalState).deliverables.find((item) => item.id === id) ?? deliverable;
      // An agent's move keeps the rows it touched (the deliverable's whole aggregate), so it can be undone.
      return Response.json({
        summary,
        applied,
        deliverable: after,
        ...(await revertibleAnswer(parsed.data.commandId))
      });
    } catch (error) {
      if (
        error instanceof CommandConflictError ||
        error instanceof CommandIdReusedError ||
        error instanceof CommittedReadFailedError ||
        error instanceof InvalidCommandError
      )
        throw error;
      log.setError(error);
      return Response.json(
        { error: error instanceof Error ? redact(error.message) : "The move could not be applied." },
        { status: 400 }
      );
    }
  }
);
