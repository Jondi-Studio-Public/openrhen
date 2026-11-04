import { validateSignature } from "@/server/imports/deliverable-source-file";
import { redact, withRoute } from "@/server/logging";
import { OpenAIImportExtractor } from "@/server/imports/openai-import-extractor";
import type { ImportExtractionInput } from "@/server/imports/import-extractor";
import type { PortalState } from "@/state/portal-state";
import { withImportStore } from "@/server/persistence/postgres/import-store";
import { getStateStore } from "@/server/persistence/state-store";
import { runtimeEnv } from "@/server/runtime-env";

const MAX_BODY_BYTES = 28_000_000;
const MAX_TEXT = 100_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const INPUT_KINDS = new Set<ImportExtractionInput["inputKind"]>([
  "assignment",
  "brain_dump",
  "task_list",
  "project_plan",
  "capacity_commitments"
]);

type ExtractRequest = {
  inputKind?: string;
  timezone?: string;
  text?: string;
  images?: Array<{ filename?: string; mimeType?: string; dataUrl?: string }>;
};

export const POST = withRoute("/api/imports/extract", async (request, _context, log) => {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return Response.json({ error: "AI intake payload is too large." }, { status: 413 });
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES)
    return Response.json({ error: "AI intake payload is too large." }, { status: 413 });
  let body: ExtractRequest;
  try {
    body = JSON.parse(raw) as ExtractRequest;
  } catch {
    return Response.json({ error: "AI intake request is not valid JSON." }, { status: 400 });
  }
  if (!body.inputKind || !INPUT_KINDS.has(body.inputKind as ImportExtractionInput["inputKind"]))
    return Response.json({ error: "Choose a supported input type." }, { status: 400 });
  if (!body.timezone?.trim()) return Response.json({ error: "Timezone is required." }, { status: 400 });
  if ((body.text?.length ?? 0) > MAX_TEXT)
    return Response.json({ error: "Text input must be 100,000 characters or fewer." }, { status: 413 });
  if ((body.images?.length ?? 0) > 5) return Response.json({ error: "Upload at most five images." }, { status: 413 });

  try {
    const images = await Promise.all((body.images ?? []).map(decodeImage));
    if (!body.text?.trim() && !images.length)
      return Response.json({ error: "Paste text or upload at least one image." }, { status: 400 });
    const totalBytes = images.reduce((sum, image) => sum + image.bytes.byteLength, 0);
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES)
      return Response.json({ error: "Combined images must be 20 MB or smaller." }, { status: 413 });
    const env = runtimeEnv();
    if (!env.OUTBOUND_PROXY_URL || !env.OUTBOUND_PROXY_TOKEN)
      return Response.json({ error: "AI extraction is not configured." }, { status: 503 });
    const current = (await getStateStore().get()) as PortalState | null;
    const currentState = current
      ? { areas: current.areas, outcomes: current.outcomes, projects: current.projects, actions: current.actions }
      : { areas: [], outcomes: [], projects: [], actions: [] };
    const input: ImportExtractionInput = {
      inputKind: body.inputKind as ImportExtractionInput["inputKind"],
      timezone: body.timezone,
      ...(body.text?.trim() ? { text: body.text.trim() } : {}),
      ...(images.length ? { images } : {}),
      currentState
    };
    const records = await new OpenAIImportExtractor(env, current?.settings.importExtractorModel).extract(input);
    const sourceFiles = await Promise.all(
      images.map(async (image) => ({
        filename: image.filename,
        mimeType: image.mimeType,
        contentHash: await hash(image.bytes)
      }))
    );
    const sourceType = images.length ? ("ai_image" as const) : ("ai_text" as const);
    const text = body.text?.trim();
    const textContentHash = text ? await hash(new TextEncoder().encode(text)) : undefined;
    const batch = await withImportStore((store) =>
      store.preview({
        sourceType,
        inputKind: body.inputKind as ImportExtractionInput["inputKind"],
        timezone: body.timezone!,
        templateVersion: "1",
        records,
        source: {
          ...(text ? { text, contentHash: textContentHash! } : {}),
          ...(sourceFiles.length ? { files: sourceFiles } : {})
        }
      })
    );
    return Response.json({ batch });
  } catch (error) {
    log.setError(error);
    return Response.json(
      { error: error instanceof Error ? redact(error.message) : "AI extraction failed." },
      { status: 400 }
    );
  }
});

async function decodeImage(image: NonNullable<ExtractRequest["images"]>[number]) {
  if (!image.filename?.trim() || image.filename.length > 255) throw new Error("Every image needs a valid filename.");
  if (!image.mimeType || !MIME_TYPES.has(image.mimeType))
    throw new Error(`${image.filename} must be JPEG, PNG, or WebP.`);
  const prefix = `data:${image.mimeType};base64,`;
  if (!image.dataUrl?.startsWith(prefix)) throw new Error(`${image.filename} has invalid image data.`);
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(image.dataUrl.slice(prefix.length)), (character) => character.charCodeAt(0));
  } catch {
    throw new Error(`${image.filename} has invalid base64 data.`);
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`${image.filename} must be 8 MB or smaller.`);
  await validateSignature(image.filename, image.mimeType, bytes);
  return {
    filename: image.filename.trim(),
    mimeType: image.mimeType as "image/jpeg" | "image/png" | "image/webp",
    bytes
  };
}

async function hash(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
