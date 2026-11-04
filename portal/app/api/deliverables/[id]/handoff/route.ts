import { notFoundResponse } from "@/server/not-found-response";
import type { z } from "zod";
import { handoffRequestSchema, type HandoffKind, type TranscriptRow } from "@openrhen/contracts";
import { redact, withRoute } from "@/server/logging";
import { getStateStore } from "@/server/persistence/state-store";
import { withDeliverableChatStore } from "@/server/persistence/postgres/deliverable-chat-store";
import type { PortalState } from "@/state/portal-state";

function summarizeZodIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

const generatedContent: Record<HandoffKind, (tool: string) => string> = {
  pick_up: (tool) => `Picked up in ${tool}`,
  drop_off: (tool) => `Handed back from ${tool}`,
  note: () => ""
};

/**
 * Records one handoff event — a pick-up, a progress note, or a drop-off — from an external
 * coordinator (a CLI agent or desktop AI app driving `rhen deliverable ...`) into the
 * deliverable's chat transcript as an `external`-role row. "Currently handed off" is derived from
 * this transcript by `coordinationState`: the latest `external` row is a `pick_up`. See
 * The external coordination design note, "API contract (the seam)".
 */
export const POST = withRoute(
  "/api/deliverables/[id]/handoff",
  async (request: Request, { params }: { params: Promise<{ id: string }> }, log) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "The request is not valid JSON." }, { status: 400 });
    }
    const parsed = handoffRequestSchema.safeParse(body);
    if (!parsed.success) return Response.json({ error: summarizeZodIssues(parsed.error) }, { status: 400 });
    const { kind, tool, text } = parsed.data;
    if (kind === "note" && !text) return Response.json({ error: "A note needs text." }, { status: 400 });
    try {
      const { id } = await params;
      const state = (await getStateStore().get()) as PortalState | null;
      const deliverable = state?.deliverables.find((item) => item.id === id);
      if (!deliverable) return notFoundResponse("deliverable", id);
      const current = await withDeliverableChatStore((store) => store.coordinationState(id));
      // Idempotent pick-up: a second pick-up by the SAME tool while already handed off to it records
      // nothing new — the design's own words: "a second pick-up by the same tool re-prints the pack
      // and records nothing new".
      if (kind === "pick_up" && current.handedOff && current.tool === tool) {
        return Response.json({ coordination: current, row: null });
      }
      const content = text || generatedContent[kind](tool);
      const stored = await withDeliverableChatStore((store) =>
        store.append(id, "external", content, [], { kind, tool })
      );
      const coordination = await withDeliverableChatStore((store) => store.coordinationState(id));
      const row: TranscriptRow = {
        id: stored.id,
        role: stored.role,
        content: stored.content,
        createdAt: stored.createdAt,
        ...(stored.meta ? { meta: stored.meta } : {})
      };
      return Response.json({ coordination, row });
    } catch (error) {
      log.setError(error);
      return Response.json(
        { error: error instanceof Error ? redact(error.message) : "The handoff could not be recorded." },
        { status: 400 }
      );
    }
  }
);
