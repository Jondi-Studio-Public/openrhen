import { cancelCheckInWaitingPush, readCurrentBelief } from "@openrhen/database";
import type postgres from "postgres";
import { requestAgent } from "@/server/agent-actor";
import { CHECK_IN_TAGS_MAX, type CheckInCommand, type StoredCheckInTag } from "@openrhen/contracts";
import type { PortalState } from "@/state/portal-state";
import { claimCommandReceipt, commandRequestHash, hasCommandReceipt } from "./command-receipt";
import { alreadyClosed, InvalidCommandError, notFound, versionConflict } from "./command-errors";
import { ensureUser } from "./ensure-user";
import { logOfferOutcome } from "./offer-log-writer";
import { readStateAfterCommit } from "./read-after-commit";
import type { PoolSql, TxSql } from "./sql-pool";
import { WriteSnapshot } from "./write-snapshot";
import { assertOwnerOccurredAt, closedCheckInReport, settleCheckInOccurredAt, reportOccurredAt } from "./occurred-at";
import { insertPendingCapture } from "./stores/inbox";
import { noteOccurredAtReport } from "@/server/occurred-at-report";

type AnswerCheckInCommand = Extract<CheckInCommand, { type: "answer_check_in" }>;
type AnswerCheckInsCommand = Extract<CheckInCommand, { type: "answer_check_ins" }>;
type VoluntaryCheckInCommand = Extract<CheckInCommand, { type: "voluntary_check_in" }>;
type TagCheckInCommand = Extract<CheckInCommand, { type: "tag_check_in" }>;

/**
 * Answers one check-in, or a whole reconciliation trail in one transaction. Record-only: this writes
 * `check_in` alone, with no `write_rows` row and no enqueued recalculation — an answer is ground truth
 * about the past, not new input the next plan should react to (plan invariant 5).
 *
 * Returns the ordinary full portal state, the same shape every other command returns, even though
 * nothing about check-ins lives in it — `check_in` sits outside the portal state model entirely (see
 * `readers/check-in-read.ts`), so a caller that wants to know the answer landed re-reads `/api/check-ins/current`
 * (or `/api/check-ins/trail`) rather than looking for it in this response.
 */
export async function runCheckInCommand(sql: PoolSql, command: CheckInCommand): Promise<PortalState> {
  if (command.type === "answer_check_in") assertOwnerOccurredAt(command);
  const userId = await ensureUser(sql);
  const requestHash = commandRequestHash(command.type, command);
  if (await hasCommandReceipt(sql, { id: command.commandId, userId, commandType: command.type, requestHash })) {
    if (command.type === "answer_check_in" && command.occurredAt !== undefined)
      await replayCheckInReport(sql, userId, command);
    return await readStateAfterCommit(sql);
  }
  await sql.begin(async (tx) => {
    // A request racing its own retry passes the pre-check above in both; the loser waits on the
    // winner's insert and then finds the receipt taken. That is an applied replay, not an error.
    if (!(await claimCommandReceipt(tx, { id: command.commandId, userId, commandType: command.type, requestHash })))
      return;
    // An agent's answer keeps the row as it was, so `POST /api/commands/revert` can put it back (write-snapshot.ts).
    const snap = await WriteSnapshot.open(tx, userId, command.commandId, "check_in");
    if (command.type === "answer_check_in") {
      await answerCheckIn(tx, userId, command, snap);
    } else if (command.type === "voluntary_check_in") {
      await recordVoluntaryCheckIn(tx, userId, command, snap);
    } else if (command.type === "tag_check_in") {
      await tagCheckIn(tx, userId, command, snap);
    } else {
      await answerCheckInsBatch(tx, userId, command, snap);
    }
    await snap?.save();
  });
  return await readStateAfterCommit(sql);
}

/** The external id of the capture that keeps the words of an answer whose check-in had closed. */
const closedAnswerExternalId = (commandId: string) => `closed-check-in-answer:${commandId}`;

/** A retried answer whose first run landed: the sentence comes from the row, or from the capture that kept the words. */
async function replayCheckInReport(sql: PoolSql, userId: string, command: AnswerCheckInCommand): Promise<void> {
  const row = await sql<
    { answered_at: Date | null; occurred_at: Date | null; occurred_note: string | null }[]
  >`SELECT answered_at, occurred_at, occurred_note FROM check_in WHERE id=${command.checkInId} AND user_id=${userId} AND answered_by IS NOT DISTINCT FROM ${requestAgent()}`;
  if (row[0]?.occurred_at && row[0].answered_at) {
    const outcome = {
      claimed: row[0].occurred_at,
      applied: row[0].occurred_note === null,
      at: row[0].answered_at,
      receipt: row[0].answered_at,
      reason: row[0].occurred_note
    };
    await reportOccurredAt(sql, userId, outcome);
    return;
  }
  const kept = await sql<
    { created_at: Date }[]
  >`SELECT created_at FROM sources WHERE user_id=${userId} AND source_type='manual_capture' AND external_id=${closedAnswerExternalId(command.commandId)}`;
  noteOccurredAtReport(
    await closedCheckInReport(
      sql,
      userId,
      new Date(command.occurredAt!),
      kept[0]?.created_at ?? new Date(),
      kept.length > 0
    )
  );
}

/**
 * An owner-device answer reached a check-in that had closed. It is not turned into a voluntary check-in (that would
 * read as contact now and could confirm the current item): his words are kept as an ordinary capture marked with the
 * check-in's own time (`sources.occurred_at`), and the reply says plainly that nothing was delivered. The pulse and
 * the check-in row are untouched.
 */
async function keepClosedAnswer(
  tx: TxSql,
  userId: string,
  command: AnswerCheckInCommand,
  row: { slot_at: Date; directive_title: string | null },
  receipt: Date
): Promise<void> {
  const words = command.deviationNote?.trim() ?? "";
  if (words)
    await insertPendingCapture(tx, {
      userId,
      sourceType: "manual_capture",
      externalId: closedAnswerExternalId(command.commandId),
      title: "Answer to a check-in that had closed",
      text: words,
      occurredAt: row.slot_at,
      createdAt: receipt,
      marks: { checkInId: command.checkInId, checkInAt: row.slot_at.toISOString(), answeredAs: command.status }
    });
  noteOccurredAtReport(await closedCheckInReport(tx, userId, new Date(command.occurredAt!), receipt, words !== ""));
}

async function answerCheckIn(
  tx: TxSql,
  userId: string,
  command: AnswerCheckInCommand,
  snap: WriteSnapshot | null
): Promise<void> {
  const rows = await tx<
    { version: number; status: string; answered_at: Date | null; directive_title: string | null; slot_at: Date }[]
  >`SELECT version,status,answered_at,directive_title,slot_at FROM check_in WHERE id=${command.checkInId} AND user_id=${userId} FOR UPDATE`;
  if (!rows[0]) throw notFound("check-in", command.checkInId);
  // Only a still-open slot can be answered: 'pending' (answered before its timeout) or 'unknown'
  // (the catch-up path, answered after the fact). Anything else has already said its piece.
  //
  // 'unknown' additionally has to be unanswered, because answering "unsure" writes that same status
  // back — with `answered_at` stamped. Judging openness by status alone made an "unsure" answer
  // re-answerable forever, which is the write half of the loop `readCurrentCheckIn` showed the user.
  // Replay of an identical `commandId` never reaches here: the receipt check above returns first, so
  // a retried or duplicated request still succeeds without touching the row a second time.
  const alreadyAnswered = rows[0].answered_at !== null;
  const closed = (rows[0].status !== "pending" && rows[0].status !== "unknown") || alreadyAnswered;
  // The owner's device answers one row at a time while it can be answered. A row that closed meanwhile is not answered
  // late: his words are kept (`keepClosedAnswer`) and the version he saw no longer matters.
  if (closed && command.occurredAt !== undefined)
    return await keepClosedAnswer(tx, userId, command, rows[0], new Date());
  if (command.expectedVersion !== null && command.expectedVersion !== rows[0].version)
    throw versionConflict("check-in", command.checkInId, command.expectedVersion, rows[0].version);
  if (closed)
    throw alreadyClosed(
      "check-in",
      command.checkInId,
      rows[0].status === "unknown" ? "answered as unknown" : "answered",
      { tool: "rhen_status", arguments: {}, note: "shows the check-in that is pending now, if any" }
    );
  const at = new Date();
  // The time he answered: his own, where it fits (`settleCheckInOccurredAt`), else now; the claim is kept either way.
  const claimed = command.occurredAt
    ? await settleCheckInOccurredAt(tx, userId, rows[0].slot_at, command.occurredAt, at)
    : undefined;
  if (claimed) await reportOccurredAt(tx, userId, claimed);
  await snap?.before("check_in", [command.checkInId]);
  await tx`
    UPDATE check_in SET
      status=${command.status},
      answered_at=${claimed?.at ?? at},
      occurred_at=${claimed?.claimed ?? null},
      occurred_note=${claimed?.reason ?? null},
      deviation_category=${command.deviationCategory ?? null},
      deviation_note=${command.deviationNote ?? null},
      deviation_target_id=${command.deviationTargetId ?? null},
      answer_source=${command.answerSource},
      answered_by=${requestAgent()},
      version=version+1,
      updated_at=${at}
    WHERE id=${command.checkInId}
  `;
  // Answered: a push still waiting for it must not arrive late.
  await cancelCheckInWaitingPush(tx as unknown as postgres.Sql, userId, command.checkInId);
  // The offer log's `checked_in` row: what he said he was doing, so "what did he do instead" has an answer.
  await logOfferOutcome(tx, userId, {
    event: "checked_in",
    commandId: command.commandId,
    targetType: "check_in",
    targetId: command.checkInId,
    label: rows[0].directive_title,
    detail: {
      command: command.type,
      status: command.status,
      answerSource: command.answerSource,
      ...(command.deviationCategory ? { deviationCategory: command.deviationCategory } : {}),
      ...(command.deviationTargetId ? { deviationTargetId: command.deviationTargetId } : {})
    }
  });
}

/**
 * Adds or removes open tags on an answered check-in. Touches `tags` and the row's version only: the status, the
 * words, `answered_at` and `answer_source` stay as the owner left them, and nothing here reads as contact to the pulse.
 * A `stated` mark replaces an `inferred` one for the same tag; an `inferred` mark never replaces a `stated` one.
 */
async function tagCheckIn(
  tx: TxSql,
  userId: string,
  command: TagCheckInCommand,
  snap: WriteSnapshot | null
): Promise<void> {
  const rows = await tx<
    { version: number; answered_at: Date | null; tags: StoredCheckInTag[] }[]
  >`SELECT version,answered_at,tags FROM check_in WHERE id=${command.checkInId} AND user_id=${userId} FOR UPDATE`;
  const row = rows[0];
  if (!row) throw notFound("check-in", command.checkInId);
  if (command.expectedVersion !== null && command.expectedVersion !== row.version)
    throw versionConflict("check-in", command.checkInId, command.expectedVersion, row.version);
  if (row.answered_at === null)
    throw new InvalidCommandError("Tags go on the owner's words, so a check-in takes them only once it is answered.", {
      nextCall: { tool: "rhen_status", arguments: {}, note: "shows the check-in that is pending now, if any" }
    });
  const removed = new Set(command.remove ?? []);
  const next = row.tags.filter((entry) => !removed.has(entry.tag));
  for (const added of command.add ?? []) {
    const at = next.findIndex((entry) => entry.tag === added.tag);
    if (at === -1) next.push({ tag: added.tag, mark: added.mark });
    else if (added.mark === "stated") next[at] = { tag: added.tag, mark: "stated" };
  }
  if (next.length > CHECK_IN_TAGS_MAX)
    throw new InvalidCommandError(
      `A check-in holds at most ${CHECK_IN_TAGS_MAX} tags; this would leave ${next.length}. Remove some first.`
    );
  if (JSON.stringify(next) === JSON.stringify(row.tags)) return;
  const at = new Date();
  await snap?.before("check_in", [command.checkInId]);
  await tx`
    UPDATE check_in SET tags=${tx.json(next as never)}, version=version+1, updated_at=${at}
    WHERE id=${command.checkInId}
  `;
}

/**
 * Answers a whole reconciliation trail at once, split at `upTo`: a slot at or before it becomes
 * `on_track`; a slot after it takes the tail's one answer (`deviated` with category/note, or
 * `unknown` with `answered_at` stamped — an actual "not sure", distinct from the timeout that wrote
 * the same status with no `answered_at`). Every written row gets `answer_source='session_reconciliation'`.
 *
 * No trail slot is answered twice (see the design's Invariants): each id is re-checked
 * `status='unknown' AND answered_at IS NULL`, locked `FOR UPDATE`, inside this same transaction —
 * exactly the discipline `answerCheckIn` uses for its one row. An id that fails that check (already
 * answered elsewhere, e.g. a concurrent catch-up reply, or simply missing) is skipped, not an error:
 * a refresh mid-way must not leave the batch half-failed with a thrown exception.
 */
async function answerCheckInsBatch(
  tx: TxSql,
  userId: string,
  command: AnswerCheckInsCommand,
  snap: WriteSnapshot | null
): Promise<void> {
  const upTo = new Date(command.upTo);
  const at = new Date();
  for (const checkInId of command.checkInIds) {
    const rows = await tx<
      { slot_at: Date; status: string; answered_at: Date | null; directive_title: string | null }[]
    >`SELECT slot_at,status,answered_at,directive_title FROM check_in WHERE id=${checkInId} AND user_id=${userId} FOR UPDATE`;
    const row = rows[0];
    if (!row) continue;
    if (row.status !== "unknown" || row.answered_at !== null) continue;
    const isInTrunk = row.slot_at.getTime() <= upTo.getTime();
    const status = isInTrunk ? "on_track" : command.tail.status;
    const deviated = !isInTrunk && command.tail.status === "deviated";
    await snap?.before("check_in", [checkInId]);
    await tx`
      UPDATE check_in SET
        status=${status},
        answered_at=${at},
        deviation_category=${deviated ? (command.tail.deviationCategory ?? null) : null},
        deviation_note=${isInTrunk ? null : (command.tail.deviationNote ?? null)},
        answer_source='session_reconciliation',
        answered_by=${requestAgent()},
        version=version+1,
        updated_at=${at}
      WHERE id=${checkInId}
    `;
    await logOfferOutcome(tx, userId, {
      event: "checked_in",
      commandId: command.commandId,
      targetType: "check_in",
      targetId: checkInId,
      label: row.directive_title,
      detail: {
        command: command.type,
        status,
        answerSource: "session_reconciliation",
        ...(deviated && command.tail.deviationCategory ? { deviationCategory: command.tail.deviationCategory } : {})
      }
    });
  }
}

/**
 * A check-in nobody asked for: with the pulse unknown and no check-in waiting, the owner (or their agent)
 * says what is happening. Inserted already answered, never `pending` (the partial unique index allows one
 * pending row per user), with the directive snapshot the scheduler would have taken at this instant
 * (`readCurrentBelief`, the scheduler's own read). It reads as contact to the pulse like a prompted answer
 * (`prompted_at` stays null, which is how a voluntary row differs), and `inserted` lets `rhen_undo` delete it.
 */
async function recordVoluntaryCheckIn(
  tx: TxSql,
  userId: string,
  command: VoluntaryCheckInCommand,
  snap: WriteSnapshot | null
): Promise<void> {
  // Open means what `readCurrentCheckIn` means: the latest row by slot_at, and only when it is pending or an
  // unanswered unknown. A timed-out unknown row behind a newer answered one is not waiting (the reader and
  // the answer path never see it), so counting it here would refuse with "send the same call again" forever.
  const latest = await tx<{ id: string; status: string; answered_at: Date | null }[]>`
    SELECT id,status,answered_at FROM check_in
    WHERE user_id=${userId} ORDER BY slot_at DESC LIMIT 1 FOR UPDATE`;
  const open =
    latest[0] && (latest[0].status === "pending" || (latest[0].status === "unknown" && latest[0].answered_at === null))
      ? latest[0]
      : undefined;
  if (open)
    throw alreadyClosed("check-in", open.id, "waiting for an answer, so it is answered, not recorded anew", {
      tool: "rhen_check_in",
      arguments: { status: command.status.replace("_", "-") },
      note: "send the same call again: with a check-in waiting it answers that one"
    });
  const belief = await readCurrentBelief(tx as unknown as postgres.Sql, userId);
  if (!belief?.targetId)
    throw new InvalidCommandError(
      "There is no check-in waiting and the plan has nothing current to check in on, so there is nothing to record. " +
        "Read rhen_status; if the owner is doing something, record it with rhen_activity (subcommand start) or rhen_session.",
      { nextCall: { tool: "rhen_status", arguments: {}, note: "shows what the plan believes now and what to record" } }
    );
  const at = new Date();
  const id = crypto.randomUUID();
  await tx`
    INSERT INTO check_in (
      id, user_id, slot_at, directive_kind, directive_target_id, directive_phase, directive_title, status,
      answered_at, deviation_category, deviation_note, deviation_target_id, answer_source, answered_by
    ) VALUES (
      ${id}, ${userId}, ${at}, ${belief.kind}, ${belief.targetId}, ${belief.phase}, ${belief.title}, ${command.status},
      ${at}, ${command.deviationCategory ?? null}, ${command.deviationNote ?? null},
      ${command.deviationTargetId ?? null}, ${command.answerSource}, ${requestAgent()}
    )`;
  snap?.inserted("check_in", [id]);
  await logOfferOutcome(tx, userId, {
    event: "checked_in",
    commandId: command.commandId,
    targetType: "check_in",
    targetId: id,
    label: belief.title,
    detail: {
      command: command.type,
      status: command.status,
      answerSource: command.answerSource,
      ...(command.deviationCategory ? { deviationCategory: command.deviationCategory } : {}),
      ...(command.deviationTargetId ? { deviationTargetId: command.deviationTargetId } : {})
    }
  });
}
