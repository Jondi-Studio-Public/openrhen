import { notFoundResponse } from "@/server/not-found-response";
import { redact, withRoute } from "@/server/logging";
import {
  streamDeliverableChat,
  toChatTurn,
  type ChatAttachment,
  type DeliverableChatContext,
  type WorkspaceToolCall
} from "@/server/imports/openai-deliverable-chat";
import { sseFrame } from "@/shared/sse";
import { phaseOf } from "@/features/deliverables/deliverable-model";
import { withDeliverableChatStore } from "@/server/persistence/postgres/deliverable-chat-store";
import { withDeliverableProposalStore } from "@/server/persistence/postgres/deliverable-proposal-store";
import { getStateStore } from "@/server/persistence/state-store";
import type { PortalState } from "@/state/portal-state";
import { runtimeEnv } from "@/server/runtime-env";
import { applyWorkspaceTool, revertDeliverableToPreTurnSnapshot } from "@/server/deliverables/workspace-moves";
import { coordinationPrompts } from "@/server/deliverables/coordination-prompts";

const MAX_TEXT = 8_000;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
/**
 * What the retained sources may cost per turn. Every turn re-sends them — the Responses API keeps
 * nothing with `store: false` — so this is a recurring bill, not a one-off upload, and it is set
 * well below what a single extraction was allowed to read. Whatever does not fit stays retained and
 * openable in the workspace; the model is simply told it cannot see it.
 */
const MAX_CONTEXT_FILES = 5;
const MAX_CONTEXT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_CONTEXT_TEXT_CHARS = 60_000;

export const GET = withRoute(
  "/api/deliverables/[id]/chat",
  async (_request: Request, { params }: { params: Promise<{ id: string }> }, log) => {
    try {
      const { id } = await params;
      const state = (await getStateStore().get()) as PortalState | null;
      const deliverable = state?.deliverables.find((item) => item.id === id);
      if (!deliverable) return notFoundResponse("deliverable", id);
      const [messages, coordination] = await Promise.all([
        withDeliverableChatStore((store) => store.list(id)),
        withDeliverableChatStore((store) => store.coordinationState(id))
      ]);
      const prompts = coordinationPrompts({ title: deliverable.title, id: deliverable.id });
      return Response.json({ messages, coordination, prompts });
    } catch (error) {
      log.setError(error);
      return Response.json(
        { error: error instanceof Error ? redact(error.message) : "The conversation could not be loaded." },
        { status: 400 }
      );
    }
  }
);

export const POST = withRoute(
  "/api/deliverables/[id]/chat",
  async (request: Request, { params }: { params: Promise<{ id: string }> }, log) => {
    let body: { text?: string; images?: ChatAttachment[]; allowEdits?: boolean };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: "The chat request is not valid JSON." }, { status: 400 });
    }
    const text = (body.text ?? "").trim();
    const images = body.images ?? [];
    if (!text && !images.length) return Response.json({ error: "Say something or paste an image." }, { status: 400 });
    if (text.length > MAX_TEXT)
      return Response.json(
        { error: `Messages must be ${MAX_TEXT.toLocaleString()} characters or fewer.` },
        { status: 413 }
      );
    if (images.length > MAX_IMAGES)
      return Response.json({ error: `Attach at most ${MAX_IMAGES} images per message.` }, { status: 413 });
    for (const image of images) {
      if (!IMAGE_MIMES.has(image.mimeType) || !image.dataUrl?.startsWith(`data:${image.mimeType};base64,`))
        return Response.json({ error: "Only pasted JPEG, PNG, WEBP or GIF images are supported." }, { status: 400 });
      // Base64 inflates by 4/3, so the byte budget is checked against the encoded length.
      if (image.dataUrl.length > (MAX_IMAGE_BYTES * 4) / 3)
        return Response.json({ error: "Each image must be 8 MB or smaller." }, { status: 413 });
    }
    try {
      const { id } = await params;
      const state = (await getStateStore().get()) as PortalState | null;
      const deliverable = state?.deliverables.find((item) => item.id === id);
      if (!deliverable) return notFoundResponse("deliverable", id);
      const coordination = await withDeliverableChatStore((store) => store.coordinationState(id));
      if (coordination.handedOff)
        return Response.json(
          { error: `This deliverable is being coordinated in ${coordination.tool}. Bring it back first.` },
          { status: 409 }
        );
      const env = runtimeEnv();
      if (!env.OUTBOUND_PROXY_URL || !env.OUTBOUND_PROXY_TOKEN)
        return Response.json({ error: "The assistant is not configured." }, { status: 503 });
      // The retained sources are read here rather than held in PortalState: they are file bytes,
      // and the engine has no use for them.
      const retained = deliverable.sourceIds.length
        ? await withDeliverableProposalStore((store) =>
            store.chatContext(id, {
              maxFiles: MAX_CONTEXT_FILES,
              maxTotalBytes: MAX_CONTEXT_FILE_BYTES,
              maxTextChars: MAX_CONTEXT_TEXT_CHARS
            })
          )
        : { sources: [], omittedFiles: [] };
      const context: DeliverableChatContext = {
        deliverableTitle: deliverable.title,
        projectTitle: state!.projects.find((item) => item.id === deliverable.projectId)?.title,
        phase: phaseOf(deliverable),
        status: deliverable.status,
        details: deliverable.details ?? undefined,
        externalDeadlineAt: deliverable.externalDeadlineAt ?? undefined,
        internalDeadlineAt: deliverable.internalDeadlineAt ?? undefined,
        criteria: deliverable.criteria.map((item) => ({
          title: item.title,
          required: item.required,
          state: item.state,
          ...(item.interpretation ? { interpretation: item.interpretation } : {}),
          ...(item.sourceDocument ? { sourceDocument: item.sourceDocument } : {}),
          ...(item.sourceLocation ? { sourceLocation: item.sourceLocation } : {}),
          ...(item.expectedEvidence ? { expectedEvidence: item.expectedEvidence } : {}),
          ...(item.verificationMethod ? { verificationMethod: item.verificationMethod } : {}),
          ...(item.notes ? { notes: item.notes } : {}),
          stepTitles: item.stepIds
            .map((stepId) => deliverable.steps.find((step) => step.id === stepId)?.title)
            .filter((title): title is string => Boolean(title))
        })),
        steps: deliverable.steps.map((item) => ({
          title: item.title,
          status: item.status,
          expectedMinutes: item.expectedMinutes,
          ...(item.completionCondition ? { completionCondition: item.completionCondition } : {}),
          ...(item.details ? { details: item.details } : {}),
          ...(item.completedAt ? { completedAt: item.completedAt } : {}),
          ...(item.reblockOnComplete ? { reblockOnComplete: item.reblockOnComplete } : {}),
          dependsOnStepTitles: item.dependencyIds
            .map((dependencyId) => deliverable.steps.find((other) => other.id === dependencyId)?.title)
            .filter((title): title is string => Boolean(title))
        })),
        openBlockers: deliverable.blockers
          .filter((item) => ["open", "awaiting_response", "possibly_resolved"].includes(item.state))
          .map((item) => item.description),
        sourceFiles: deliverable.sourceFiles.map((item) => ({ filename: item.filename, mimeType: item.mimeType })),
        retainedSources: retained.sources,
        omittedSourceFiles: retained.omittedFiles
      };
      // The user's turn is stored before the model is called, so a failed call never loses what
      // they wrote; the client retries the assistant turn against the saved history.
      const userMessage = await withDeliverableChatStore((store) => store.append(id, "user", text, images));
      const history = await withDeliverableChatStore((store) => store.list(id));
      // From here the answer streams: `delta` frames as the model talks, then one `done` frame with
      // both stored turns — or an `error` frame, since the HTTP status is already committed as 200.
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (data: unknown) => controller.enqueue(encoder.encode(sseFrame(data)));
          // Whether a workspace tool actually wrote to the deliverable during this turn. If the turn
          // goes on to fail, that write must not survive it — see the catch block below.
          let deliverableTouched = false;
          try {
            // Edits are offered only when the workspace has no unsaved draft: a server-side save
            // would bump the version underneath a draft, and saving that draft afterwards would
            // silently erase what the assistant just added.
            const sessionStillOwnsWorkspace =
              state?.activeSession?.targetType === "deliverable" && state.activeSession.targetId === id;
            const onWorkspaceTool =
              body.allowEdits === true && sessionStillOwnsWorkspace
                ? async (call: WorkspaceToolCall) => {
                    const { summary, state: updated } = await applyWorkspaceTool(id, call, { requireSession: true });
                    deliverableTouched = true;
                    send({ kind: "applied", state: updated });
                    return summary;
                  }
                : undefined;
            const reply = await streamDeliverableChat(
              env,
              context,
              history.map(toChatTurn),
              {
                onDelta: (delta) => send({ kind: "delta", text: delta }),
                ...(onWorkspaceTool ? { onWorkspaceTool } : {})
              },
              state!.settings.deliverableChatModel
            );
            const assistantMessage = await withDeliverableChatStore((store) =>
              store.append(id, "assistant", reply, [])
            );
            send({ kind: "done", messages: [userMessage, assistantMessage] });
          } catch (error) {
            log.setError(error);
            // A tool call earlier in this turn can have already saved a real change — record_blocker,
            // extend_plan and the rest apply and persist as soon as the model calls them, not at the
            // end of the turn — before a later model round dies (a refusal, a dropped stream, the
            // tool-round budget). The assistant reply is never appended below when that happens, so
            // without this the deliverable would run ahead of a transcript that shows no such turn ever
            // completed, and the next turn would reason from state nobody actually agreed to (finding
            // 22). There is no single database transaction spanning both stores here, so this is a
            // compensating write, not a true rollback: it puts the deliverable's stored CONTENT back to
            // exactly what it held before this turn started (the version number still advances).
            if (deliverableTouched) {
              try {
                await revertDeliverableToPreTurnSnapshot(id, deliverable);
              } catch (revertError) {
                log.setError(revertError);
              }
            }
            send({
              kind: "error",
              error: error instanceof Error ? redact(error.message) : "The assistant request failed."
            });
          } finally {
            controller.close();
          }
        }
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-store" }
      });
    } catch (error) {
      log.setError(error);
      return Response.json(
        { error: error instanceof Error ? redact(error.message) : "The assistant request failed." },
        { status: 502 }
      );
    }
  }
);
