import { randomBytes } from "node:crypto";
import {
  WORK_LABEL_MODEL_ID,
  inferredLabelKey,
  resolveWorkLabels,
  type WorkLabelValue
} from "@openrhen/contracts/drift/labels";
import { callModel, processPolicyState, type ModelTransport, type PolicyState } from "@/server/derived/call-policy";
import { buildPolicyDeps } from "@/server/derived/model-runner";
import { lockActivityUser, tryLockActivityUser } from "@/server/persistence/postgres/activity-lock";
import { readDerivedSettings } from "@/server/persistence/postgres/derived-settings-store";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import type { PoolSql } from "@/server/persistence/postgres/sql-pool";
import {
  heldLabelKeys,
  insertWorkLabel,
  readAreaSnapshots,
  readWorkLabelRows
} from "@/server/persistence/postgres/work-label-store";
import {
  WORK_LABEL_PROMPT_VERSION,
  buildWorkLabelPrompt,
  parseWorkLabelReply,
  snapshotHash,
  validateWorkLabelReply,
  type AreaSnapshot
} from "./work-label-prompt";

/**
 * The work-label job: infers, with the owner's local model (tier `t2`), whether an area counts as work, and stores the
 * answer as a `work_label` row of origin `inferred`. One area per run, so the shared local-model queue is held for one
 * call at a time and mail extraction is not starved.
 *
 * Three phases, as the model tick has: (a) under the per-person activity lock, read the areas the model may see and
 * pick one that has no label for its current text, prompt version and model, hashing the exact text that will be sent;
 * (b) with no lock, call the model; (c) under the lock again, store the row only if the area is still there, still
 * public and still the same text (a changed or newly private area's answer is dropped, and the next run starts over).
 * An area the owner has answered is skipped: the owner's answer wins, so the model is not asked.
 *
 * Nothing logs or returns an area's text: the answer carries a status, counts and at most one area id. A run that
 * cannot start says so in a fixed sentence. See docs/architecture/drift.md.
 */

export type WorkLabelTickStatus = "ok" | "idle" | "busy" | "not_configured" | "failed" | "discarded";

export interface WorkLabelTickResult {
  status: WorkLabelTickStatus;
  /** True when another area is waiting for a label, so the worker may come back soon. */
  more: boolean;
  areaId?: string;
  label?: WorkLabelValue;
  outcome?: string;
  summary: string;
}

export interface WorkLabelTickOptions {
  now?: () => Date;
  transport?: ModelTransport;
  sleep?: (ms: number) => Promise<void>;
  policyState?: PolicyState;
  newBoundary?: () => string;
}

export async function runWorkLabelTick(sql: PoolSql, options: WorkLabelTickOptions = {}): Promise<WorkLabelTickResult> {
  const now = options.now ?? (() => new Date());
  const userId = await ensureUser(sql);
  const settings = await readDerivedSettings(sql);
  // Areas a call is in line or running for in this process, so two overlapping runs never ask about the same area.
  const inFlight = (options.policyState ?? processPolicyState).working;
  const modelId = settings.t2Model;
  if (modelId === null || !WORK_LABEL_MODEL_ID.test(modelId))
    return {
      status: "not_configured",
      more: false,
      summary:
        modelId === null
          ? "No local model is set, so no area is labelled automatically. Pick one in Settings > Mail understanding, or tap Yes or No on an area's page. This is normal until then."
          : "The local model's name is longer or different from what a label can record (letters, digits and . _ : / @ + - up to 64 characters). Pick another model in Settings > Mail understanding."
    };

  // (a) Under the lock: choose one area and fix the text to be sent.
  const picked = await sql.begin(async (tx) => {
    if (!(await tryLockActivityUser(tx, userId))) return "busy" as const;
    const snapshots = await readAreaSnapshots(tx, userId);
    const rows = await readWorkLabelRows(tx, userId);
    const current = new Map(
      snapshots.map((snapshot) => [
        snapshot.areaId,
        { inputHash: snapshotHash(snapshot), promptVersion: WORK_LABEL_PROMPT_VERSION }
      ])
    );
    const answered = resolveWorkLabels(rows, current);
    const keyOf = (snapshot: AreaSnapshot) =>
      inferredLabelKey(snapshot.areaId, snapshotHash(snapshot), WORK_LABEL_PROMPT_VERSION, modelId);
    const open = snapshots.filter((snapshot) => answered.get(snapshot.areaId)?.origin !== "corrected");
    const held = await heldLabelKeys(tx, userId, open.map(keyOf));
    const waiting = open.filter((snapshot) => !held.has(keyOf(snapshot)) && !inFlight.has(snapshot.areaId));
    const [next] = waiting;
    // Marked inside the lock, so a second run that gets the lock next cannot pick the same area.
    if (next) inFlight.add(next.areaId);
    return next ? { snapshot: next, more: waiting.length > 1 } : ("idle" as const);
  });
  if (picked === "busy")
    return {
      status: "busy",
      more: false,
      summary: "The activity store is busy with another job; this run did nothing."
    };
  if (picked === "idle")
    return {
      status: "idle",
      more: false,
      summary: "Every area has a label for its current text, or has none to make."
    };

  const { snapshot, more } = picked;
  const hash = snapshotHash(snapshot);
  const prompt = buildWorkLabelPrompt(snapshot, options.newBoundary?.() ?? randomBytes(16).toString("hex"));
  if (prompt === null)
    return {
      status: "failed",
      more,
      areaId: snapshot.areaId,
      outcome: "bad_prompt",
      summary: "The prompt could not be built."
    };

  // (b) With no lock: ask the model.
  let result;
  try {
    const policy = buildPolicyDeps(sql, userId, settings, options);
    result = await callModel(policy, {
      tier: "t2",
      sourceEventKey: `work_label|${snapshot.areaId}`,
      model: modelId,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user }
      ],
      maxTokens: 200,
      format: "json",
      validate: validateWorkLabelReply
    });
  } finally {
    inFlight.delete(snapshot.areaId);
  }
  if (result.kind !== "ok")
    return {
      status: "failed",
      more: false,
      areaId: snapshot.areaId,
      outcome: result.kind === "failed" ? result.outcome : result.reason,
      summary:
        result.kind === "failed"
          ? `The local model did not give a usable label (${result.outcome}). Nothing was kept; the next run tries again. Check that the model is running (Settings > Mail understanding has a test).`
          : "The call was refused before it was sent. Nothing was kept."
    };
  const reply = parseWorkLabelReply(result.text);
  if (!reply.ok)
    return {
      status: "failed",
      more: false,
      areaId: snapshot.areaId,
      outcome: "bad_output",
      summary: "The reply was not usable. Nothing was kept."
    };

  // (c) Under the lock: keep it only if the area is still the same.
  const stored = await sql.begin(async (tx) => {
    await lockActivityUser(tx, userId);
    const again = (await readAreaSnapshots(tx, userId)).find((item) => item.areaId === snapshot.areaId);
    if (!again || snapshotHash(again) !== hash) return "discarded" as const;
    return insertWorkLabel(
      tx,
      userId,
      {
        id: inferredLabelKey(snapshot.areaId, hash, WORK_LABEL_PROMPT_VERSION, modelId),
        source: "drift",
        kind: "work_label",
        start: now().toISOString(),
        attrs: {
          area_id: snapshot.areaId,
          label: reply.label,
          origin: "inferred",
          model: { id: modelId },
          input_hash: hash,
          prompt_version: WORK_LABEL_PROMPT_VERSION,
          ...(reply.evidence === "" ? {} : { evidence: reply.evidence })
        }
      },
      now()
    );
  });
  if (stored === "discarded")
    return {
      status: "discarded",
      more: true,
      areaId: snapshot.areaId,
      summary:
        "The area changed (or became private) while the model was working, so its answer was dropped. The next run starts again."
    };
  if (!stored.ok)
    return {
      status: "failed",
      more: false,
      areaId: snapshot.areaId,
      outcome: "refused",
      summary: "The label row was refused by the activity store's rules. Nothing was kept."
    };
  return {
    status: "ok",
    more,
    areaId: snapshot.areaId,
    label: reply.label,
    summary: `Labelled one area (${reply.label === "work" ? "work" : "not work"}).`
  };
}
