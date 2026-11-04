import { notFoundResponse } from "@/server/not-found-response";
import { redact, withRoute } from "@/server/logging";
import { decodeDeliverableSourceFile, type EncodedSourceFile } from "@/server/imports/deliverable-source-file";
import { withDeliverableChatStore } from "@/server/persistence/postgres/deliverable-chat-store";
import { withDeliverableProposalStore } from "@/server/persistence/postgres/deliverable-proposal-store";
import { getStateStore } from "@/server/persistence/state-store";
import type { PortalState } from "@/state/portal-state";

const MAX_BODY_BYTES = 40_000_000;
const MAX_TEXT = 100_000;
const MAX_TOTAL_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 5;
type AttachRequest = { sourceTitle?: string; text?: string; files?: EncodedSourceFile[] };

/**
 * Attaches a brief, rubric or screenshot to a deliverable as conversation material.
 *
 * Retention is all this does: no model runs here and nothing is proposed. The file becomes part of
 * the workspace chat's context, and whatever it requires is agreed a few items at a time through
 * the chat's own tools — which replaced a one-shot extraction that answered with dozens of cards.
 * A note lands in the thread so the person can see the file arrive and start talking about it.
 */
export const POST = withRoute(
  "/api/deliverables/[id]/sources",
  async (request: Request, { params }: { params: Promise<{ id: string }> }, log) => {
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) return Response.json({ error: "Source payload is too large." }, { status: 413 });
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES)
      return Response.json({ error: "Source payload is too large." }, { status: 413 });
    let body: AttachRequest;
    try {
      body = JSON.parse(raw) as AttachRequest;
    } catch {
      return Response.json({ error: "The source request is not valid JSON." }, { status: 400 });
    }
    if (!body.sourceTitle?.trim()) return Response.json({ error: "Name the source document." }, { status: 400 });
    if (body.sourceTitle.trim().length > 255)
      return Response.json({ error: "Source document name must be 255 characters or fewer." }, { status: 400 });
    if ((body.text?.length ?? 0) > MAX_TEXT)
      return Response.json({ error: "Source text must be 100,000 characters or fewer." }, { status: 413 });
    if ((body.files?.length ?? 0) > MAX_FILES)
      return Response.json({ error: `Upload at most ${MAX_FILES} files.` }, { status: 413 });
    try {
      const { id } = await params;
      const current = (await getStateStore().get()) as PortalState | null;
      const deliverable = current?.deliverables.find((item) => item.id === id);
      if (!deliverable) return notFoundResponse("deliverable", id);
      const files = await Promise.all((body.files ?? []).map(decodeDeliverableSourceFile));
      if (!body.text?.trim() && !files.length)
        return Response.json({ error: "Paste source text or upload at least one file." }, { status: 400 });
      if (files.reduce((sum, file) => sum + file.bytes.byteLength, 0) > MAX_TOTAL_FILE_BYTES)
        return Response.json({ error: "Combined files must be 25 MB or smaller." }, { status: 413 });
      const sourceTitle = body.sourceTitle.trim();
      const text = body.text?.trim();
      const contentHash = await hash(
        new TextEncoder().encode(
          JSON.stringify({
            text: text ?? null,
            files: files.map((file) => ({ filename: file.filename, hash: file.contentHash }))
          })
        )
      );
      const state = await withDeliverableProposalStore((store) =>
        store.retain({
          deliverableId: id,
          sourceTitle,
          sourceType: files.length ? "deliverable_upload" : "deliverable_text",
          ...(text ? { capturedText: text } : {}),
          contentHash,
          files
        })
      );
      const message = await withDeliverableChatStore((store) =>
        store.append(
          id,
          "assistant",
          noticeFor(
            sourceTitle,
            files.map((file) => file.filename)
          ),
          []
        )
      );
      return Response.json({ state, message });
    } catch (error) {
      log.setError(error);
      return Response.json(
        { error: error instanceof Error ? redact(error.message) : "The source could not be attached." },
        { status: 400 }
      );
    }
  }
);

function noticeFor(sourceTitle: string, filenames: string[]) {
  const what = filenames.length ? `${sourceTitle} (${filenames.join(", ")})` : sourceTitle;
  return `I can now see “${what}”. Ask me anything about it — for example, to work through the requirements it sets and add the ones you agree with to the breakdown.`;
}

async function hash(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
