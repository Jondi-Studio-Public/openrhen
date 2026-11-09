import {
  REASON_CHECK_IN_ID,
  REASON_REQUEST_ID,
  describeReasonTagsProblem,
  normaliseReasonTag,
  resolveReasons
} from "@openrhen/contracts/drift/reasons";
import {
  REASON_TAG_WINDOW_DAYS,
  resolveReasonTags,
  type CurrentTagging,
  type ResolvedReasonTags
} from "@openrhen/contracts/drift/reason-tags";
import { lockActivityUser } from "@/server/persistence/postgres/activity-lock";
import { readDerivedSettings } from "@/server/persistence/postgres/derived-settings-store";
import {
  insertCorrectedReasonTags,
  readReasonRows,
  readReasonRowsOf,
  readReasonTagRows
} from "@/server/persistence/postgres/drift-reason-store";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import type { PoolSql } from "@/server/persistence/postgres/sql-pool";
import { REASON_TAG_PROMPT_VERSION } from "./reason-tag-prompt";

/**
 * The owner's view of their reasons and the tags on them (`GET /api/drift-reasons`) and their way to change the tags
 * (`PUT /api/drift-reasons/[checkInId]/tags`). A change is a new row of origin `corrected`; the model's rows and the
 * words are never edited. Tags are free text: shape and size are checked, nothing is matched against a list. The words
 * go to the owner's own screen and nowhere else; no message here repeats them or a tag.
 */

export const REASONS_LISTED = 200;
const DAY_MS = 86_400_000;

export interface ReasonTagView {
  checkInId: string;
  /** The owner's words. */
  text: string;
  /** When the words were saved, ISO. */
  savedAt: string;
  tags: string[];
  /** `corrected` is the owner's own answer, `inferred` the local model's, null when there are no tags yet. */
  origin: ResolvedReasonTags["origin"];
  /** The model's tags come from an older prompt or model and will be replaced when it next runs. */
  stale: boolean;
}

export interface ReasonTagsAnswer {
  /** Whether a local model is set, so a screen can say why a reason has no tags. */
  modelConfigured: boolean;
  /** Newest first. */
  reasons: ReasonTagView[];
}

const view = (item: ResolvedReasonTags): ReasonTagView => ({
  checkInId: item.checkInId,
  text: item.text,
  savedAt: item.savedAt.toISOString(),
  tags: item.tags,
  origin: item.origin,
  stale: item.stale
});

const currentOf = (modelId: string | null): CurrentTagging => ({ promptVersion: REASON_TAG_PROMPT_VERSION, modelId });

/** The last `REASON_TAG_WINDOW_DAYS` days of the owner's reasons, newest first, with the tags that stand for each. A reason whose check-in is gone is still listed: the words are the owner's. */
export async function readReasonTags(sql: PoolSql, now: Date = new Date()): Promise<ReasonTagsAnswer> {
  const userId = await ensureUser(sql);
  const settings = await readDerivedSettings(sql);
  const since = new Date(now.getTime() - REASON_TAG_WINDOW_DAYS * DAY_MS);
  const reasons = await readReasonRows(sql, userId, { since, limit: REASONS_LISTED, order: "newest" });
  const standing = [...resolveReasons(reasons).values()];
  const tagRows = await readReasonTagRows(
    sql,
    userId,
    standing.map((reason) => reason.checkInId)
  );
  const resolved = [...resolveReasonTags(tagRows, reasons, currentOf(settings.t2Model)).values()];
  resolved.sort((a, b) => b.savedAt.getTime() - a.savedAt.getTime() || (a.checkInId < b.checkInId ? 1 : -1));
  return { modelConfigured: settings.t2Model !== null, reasons: resolved.map(view) };
}

export type SetReasonTagsResult = { ok: true; reason: ReasonTagView } | { ok: false; status: 400 | 404; error: string };

/**
 * Stores the owner's tags for one reason: a list of free-text phrases (an empty list is an answer: "no tags"), or
 * `reset`, which takes their answer back so the model's tags show again. The request id makes a retried tap one row.
 * Answers the reason as it now reads.
 */
export async function setReasonTags(
  sql: PoolSql,
  input: { checkInId: unknown; tags: unknown; reset: unknown; requestId: unknown },
  now: Date = new Date()
): Promise<SetReasonTagsResult> {
  const { checkInId, requestId } = input;
  if (typeof checkInId !== "string" || !REASON_CHECK_IN_ID.test(checkInId))
    return { ok: false, status: 400, error: "The check-in id in the address is not a check-in id." };
  if (typeof requestId !== "string" || !REASON_REQUEST_ID.test(requestId))
    return {
      ok: false,
      status: 400,
      error: "requestId must be 8 to 64 letters, digits and hyphens, new for each change (a retry reuses it)."
    };
  const reset = input.reset === true;
  if (input.reset !== undefined && typeof input.reset !== "boolean")
    return { ok: false, status: 400, error: "reset must be true or left out." };
  let tags: string[] = [];
  if (reset) {
    if (input.tags !== undefined && !(Array.isArray(input.tags) && input.tags.length === 0))
      return { ok: false, status: 400, error: "A reset carries no tags. Send either tags or reset." };
  } else {
    if (!Array.isArray(input.tags) || input.tags.some((tag) => typeof tag !== "string"))
      return {
        ok: false,
        status: 400,
        error: 'tags must be a list of short phrases, for example {"tags":["a phrase"]}.'
      };
    // Typed phrases are folded the way stored tags are, and a repeat or a blank is dropped rather than refused.
    for (const raw of input.tags as string[]) {
      const tag = normaliseReasonTag(raw.replace(/\s+/gu, " "));
      if (tag !== "" && !tags.includes(tag)) tags.push(tag);
    }
    const problem = describeReasonTagsProblem(tags);
    if (problem) return { ok: false, status: 400, error: problem };
  }
  tags = reset ? [] : tags;
  const userId = await ensureUser(sql);
  const settings = await readDerivedSettings(sql);
  const written = await sql.begin(async (tx) => {
    await lockActivityUser(tx, userId);
    const reasons = await readReasonRowsOf(tx, userId, checkInId);
    if (reasons.length === 0) return "missing" as const;
    const stored = await insertCorrectedReasonTags(tx, userId, { checkInId, tags, reset, requestId }, now);
    if (!stored.ok) return stored;
    const tagRows = await readReasonTagRows(tx, userId, [checkInId]);
    const item = resolveReasonTags(tagRows, reasons, currentOf(settings.t2Model)).get(checkInId);
    return item === undefined ? ("missing" as const) : item;
  });
  if (written === "missing")
    return { ok: false, status: 404, error: "That reason is not here. It may have been deleted; reload the page." };
  if ("ok" in written) return { ok: false, status: 400, error: written.reason };
  return { ok: true, reason: view(written) };
}
