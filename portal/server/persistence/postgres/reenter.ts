import {
  incompleteReentryMessage,
  agentBulkResetProblems,
  agentFactsProblems,
  reentryLeavesOnLedger,
  missingReentryFacts,
  planReentrySettlement,
  reentryMissingLines,
  reentryRequirementLines,
  reentryReviewable,
  type PulseReentryView,
  type ReenterCommand,
  type ReentryTier
} from "@openrhen/contracts";
import { requestAgent } from "@/server/agent-actor";
import { isLapsed, readPulseWindow, writeReentrySegment } from "@/server/pulse/pulse-reentry";
import {
  allEntries,
  buildReentryBlock,
  cancelCatchUpNudges,
  settleDeadline,
  settleOccurrence,
  userTimeZone,
  type Applied,
  type EntryVerdict
} from "./catch-up";
import { claimCommandReceipt, commandRequestHash, refuseCommandIdReuse } from "./command-receipt";
import { CommandConflictError, InvalidCommandError } from "./command-errors";
import { nextCurrentSituation, parseCurrentSituation } from "./current-situation";
import { ensureUser } from "./ensure-user";
import { assertCurrentLocationIsSavedPlace } from "./location-context";
import { recordStateChange } from "./planning-evidence";
import type { PoolSql, Sql } from "./sql-pool";
import { WriteSnapshot } from "./write-snapshot";

/**
 * `reenter`: the one command that ends a lapsed pulse. In one
 * transaction it settles the catch-up window through the existing settle code, writes the three facts, writes the
 * segment that puts the pulse back `on` (reason `reentered`, last confirmed now, by the actor) and keeps a row
 * snapshot, so one undo puts the lapsed segment and the unsettled items back. All or nothing: an incomplete answer
 * is refused with every missing fact and unreviewed item named, and nothing is written.
 */

/** An incomplete re-entry: the message names each missing fact and unreviewed item; `body` carries the same for a client. */
export class ReentryIncompleteError extends InvalidCommandError {
  constructor(
    message: string,
    readonly body: {
      code: "reentryIncomplete";
      error: string;
      tier: ReentryTier;
      gapMinutes: number | null;
      missing: string[];
      /** Everything still to settle, as the read gives it, so a refused agent need not read again (every read is held). */
      review: Record<string, unknown>;
      choices: Awaited<ReturnType<typeof readReentryChoices>>;
    }
  ) {
    super(message);
  }
}

/** The sentence after a successful re-entry: what is still open and the exact calls that close it. */
export function reenterNextStep(leftOnLedger: readonly string[]): string {
  const undo =
    " If an answer was wrong, call rhen_undo with this re-entry's id (revertible). Undo works until a check-in, a session or a new lapse has changed the pulse since; the pulse moving to free or asleep by itself does not stop it. After that only the owner can correct it (Review > Agent changes), or fact by fact (the place with rhen_arrive).";
  if (leftOnLedger.length === 0)
    return `Re-entry is done and nothing is left open. Call rhen_status to see the plan.${undo}`;
  const count = leftOnLedger.length;
  return `Re-entry is done. ${count} ${count === 1 ? "entry stays" : "entries stay"} on the catch-up ledger (${leftOnLedger.join(", ")}). Next: call rhen_catch_up to read them, ask the owner what happened to each (do not guess), then settle check-ins and sessions with rhen_catch_up_settle. The stale wake is settled by rhen_wake {at: the ISO time the person woke}; rhen_catch_up_settle with verdict done and the same at does the same.${undo}`;
}

export interface ReenterResult {
  reentered: true;
  at: string;
  tier: ReentryTier;
  gapMinutes: number | null;
  confirmedBy: "person" | "agent";
  /** Recurring occurrences that lapsed as missed without asking. */
  lapsed: number;
  /** Answers the person did not give item by item; they wrote `skipped`, never `done`, and teach no learning. */
  unrecorded: number;
  results: { entryId: string; outcome: string; message?: string }[];
  /** Open sessions, a stale wake and open check-ins: re-entry leaves them for catch-up. */
  leftOnLedger?: string[];
  /** What to do next, in words an agent can follow. */
  next?: string;
  /** The command id to undo with (`rhen undo`, or the owner's revert). */
  revertible: string;
}

/**
 * The pulse as an agent or the portal reads it: its state, when it was last confirmed, and (only while it is
 * `off/lapsed`) what re-entry still needs. Null for a user the recorder has never evaluated.
 */
export async function readPulseReentryView(
  sql: Sql,
  now: Date = new Date()
): Promise<{ view: PulseReentryView; lapsed: boolean } | null> {
  const userId = await ensureUser(sql);
  const pulse = await readPulseWindow(sql, userId);
  if (!pulse) return null;
  // A database that has never had a pulse confirmation has not started its pulse: `off/lapsed` there demands no
  // re-entry and gates no agent. Any history at all (one confirmation, check-in or re-entry) restores the full rule.
  const lapsed = isLapsed(pulse) && pulse.everConfirmed;
  const base = {
    state: pulse.state,
    reason: pulse.reason,
    since: pulse.since.toISOString(),
    lastConfirmedAt: pulse.lastConfirmedAt?.toISOString() ?? null,
    silenceUntil: pulse.silenceUntil?.toISOString() ?? null
  };
  if (!lapsed) {
    const gap = pulse.lastConfirmedAt ? Math.max(0, (now.getTime() - pulse.lastConfirmedAt.getTime()) / 60_000) : null;
    return { view: { ...base, reentry: { due: false, tier: "none", gapMinutes: gap, missing: [] } }, lapsed };
  }
  const entries = await allEntries(sql, userId, now, null);
  const { block } = buildReentryBlock(pulse, entries, now, await userTimeZone(sql, userId));
  return {
    view: {
      ...base,
      reentry: {
        due: true,
        tier: block.tier,
        gapMinutes: block.gapMinutes,
        missing: reentryRequirementLines(block.tier, block.reviewable)
      }
    },
    lapsed
  };
}

/** What the person is told about the window before answering: every unreviewed item by name, for the sheet and the CLI. */
export async function readReentryReview(sql: Sql, now: Date = new Date()) {
  const userId = await ensureUser(sql);
  const pulse = await readPulseWindow(sql, userId);
  if (!pulse || !isLapsed(pulse)) return null;
  const entries = await allEntries(sql, userId, now, null);
  const { block, inWindow } = buildReentryBlock(pulse, entries, now, await userTimeZone(sql, userId));
  return { reentry: block, entries: inWindow };
}

/** The places and contexts a re-entry can name, with their ids: the reads that list them are held while the pulse is lapsed. */
export async function readReentryChoices(sql: Sql) {
  const userId = await ensureUser(sql);
  const rows = await sql<
    { id: string; name: string; kind: string }[]
  >`SELECT id, name, kind FROM condition_definitions WHERE user_id=${userId} AND status='active' ORDER BY name`;
  return {
    places: rows.filter((row) => row.kind === "location").map(({ id, name }) => ({ id, name })),
    contexts: rows.filter((row) => row.kind !== "location").map(({ id, name, kind }) => ({ id, name, kind }))
  };
}

/** The owner's own words for each energy level (settings), or null when none are saved. */
export async function readEnergyMeanings(sql: Sql): Promise<Record<string, string> | null> {
  const userId = await ensureUser(sql);
  const rows = await sql<
    { energy_meanings: unknown }[]
  >`SELECT energy_meanings FROM user_preferences WHERE user_id=${userId}`;
  const raw = rows[0]?.energy_meanings;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, string>) : null;
}

function applyOutcome(applied: Applied, entryId: string) {
  return { entryId, outcome: applied.outcome, ...(applied.message ? { message: applied.message } : {}) };
}

export async function reenter(sql: PoolSql, command: ReenterCommand, now: Date = new Date()): Promise<ReenterResult> {
  const userId = await ensureUser(sql);
  const requestHash = commandRequestHash("reenter", command);
  const replay = async (queryable: Sql): Promise<ReenterResult | null> => {
    const prior = await queryable<
      { response: ReenterResult | null; command_type: string; request_hash: string | null }[]
    >`SELECT response, command_type, request_hash FROM writes WHERE id=${command.commandId} AND user_id=${userId}`;
    if (prior[0]) refuseCommandIdReuse(prior[0], { commandType: "reenter", requestHash });
    return prior[0]?.response ?? null;
  };
  const earlier = await replay(sql);
  if (earlier) return earlier;

  return sql.begin(async (tx) => {
    // The recorder's own lock (`runPulseRecorderTick`), taken first: a tick racing this write waits for it and then
    // sees `on/reentered`, rather than re-lapsing the pulse or inserting a second open segment.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`pulse_recorder:${userId}`}, 0))`;
    if (!(await claimCommandReceipt(tx, { id: command.commandId, userId, commandType: "reenter", requestHash }))) {
      // A retry racing its own first send: the first one's answer is the answer.
      const stored = await replay(tx);
      if (stored) return stored;
      throw new CommandConflictError(
        "That re-entry is already being applied by another request. Read the window: if the pulse is no longer lapsed it landed; if it still is, repeat the identical call with the same command-id.",
        {
          nextCall: {
            tool: "rhen_reenter",
            arguments: {},
            note: "read-only; shows whether the gap is still open"
          }
        }
      );
    }
    const pulse = await readPulseWindow(tx, userId, true);
    if (!pulse || !isLapsed(pulse))
      throw new CommandConflictError(
        "Nothing to re-enter: the pulse is not lapsed. To settle things from a break use rhen_catch_up to list them, then rhen_catch_up_settle.",
        {
          nextCall: {
            tool: "rhen_catch_up",
            arguments: {},
            note: "lists what a break left to settle; settle it with rhen_catch_up_settle"
          }
        }
      );
    const timeZone = await userTimeZone(tx, userId);
    const entries = await allEntries(tx, userId, now, null);
    const { block, inWindow } = buildReentryBlock(pulse, entries, now, timeZone);
    const tier = block.tier;
    const plan = planReentrySettlement(inWindow, tier, command.settlement, timeZone);
    const facts = missingReentryFacts(command);
    if (requestAgent() !== null) {
      // Where, energy and contexts are the owner's alone; a guess is refused (F21). The person's own path is unchanged.
      plan.problems.push(...agentFactsProblems(command));
      plan.problems.push(...agentBulkResetProblems(command.settlement, command.basis));
    }
    if (facts.length > 0 || plan.unreviewed.length > 0 || plan.problems.length > 0) {
      const lines = reentryMissingLines(facts, plan.unreviewed);
      const message = incompleteReentryMessage(lines, plan.problems, tier, block.reviewable);
      throw new ReentryIncompleteError(message, {
        code: "reentryIncomplete",
        error: message,
        tier,
        gapMinutes: block.gapMinutes,
        missing: [...lines, ...plan.problems],
        review: { ...block, entries: inWindow.filter(reentryReviewable) },
        choices: await readReentryChoices(tx)
      });
    }

    const snapshot = WriteSnapshot.forWrite(tx, userId, command.commandId, "reenter");
    const confirmedBy = requestAgent() === null ? ("person" as const) : ("agent" as const);

    // The settlement, through the catch-up code. Any entry that cannot be applied refuses the whole re-entry.
    const results: ReenterResult["results"] = [];
    const beforeOccurrences: unknown[] = [];
    const beforeProjects: unknown[] = [];
    const refused: string[] = [];
    for (const { verdict } of plan.verdicts) {
      const [kind, ...rest] = verdict.entryId.split(":");
      const id = rest.join(":");
      const applied: Applied =
        kind === "occurrence"
          ? await settleOccurrence(tx, userId, id, verdict as EntryVerdict, now, snapshot)
          : kind === "deadline"
            ? await settleDeadline(tx, userId, id, verdict as EntryVerdict, now, snapshot)
            : { outcome: "invalid", message: "Unknown entry id." };
      results.push(applyOutcome(applied, verdict.entryId));
      if (applied.outcome === "conflict" || applied.outcome === "invalid")
        refused.push(`${verdict.entryId}: ${applied.message ?? applied.outcome}`);
      if (applied.outcome === "applied")
        (applied.kind === "occurrence" ? beforeOccurrences : beforeProjects).push(applied.before ?? null);
    }
    if (refused.length > 0) {
      const invalid = results.filter((item) => item.outcome === "invalid");
      if (invalid.length > 0)
        throw new CommandConflictError(
          `Re-entry was not applied and nothing was written. An answer is not allowed or could not be applied (${refused.join("; ")}). Re-reading will not change this: call rhen_reenter with no arguments to see what this gap accepts, drop or correct the entries named here, and send the answers again with a NEW command-id. If the entries named are ones the read told you to answer, report this message to the owner word for word instead of trying other answers.`,
          {
            nextCall: {
              tool: "rhen_reenter",
              arguments: {},
              note: "read-only; shows what this gap accepts"
            }
          }
        );
      throw new CommandConflictError(
        `Re-entry was not applied and nothing was written, because the window changed while you were answering (${refused.join("; ")}). Call rhen_reenter with no arguments to read the window again, then send the answers again with a NEW command-id.`,
        {
          nextCall: {
            tool: "rhen_reenter",
            arguments: {},
            note: "read-only; shows the window as it is now"
          }
        }
      );
    }

    // The three facts. Re-telling them is a fresh assertion of each, as of now.
    const prefs = await tx<
      { current_situation: unknown }[]
    >`SELECT current_situation FROM user_preferences WHERE user_id=${userId} FOR UPDATE`;
    if (!prefs[0])
      throw new InvalidCommandError("Settings are not set up yet, so there is nothing to record the facts on.");
    const previous = parseCurrentSituation(prefs[0].current_situation);
    await assertCurrentLocationIsSavedPlace(tx, userId, { locationId: command.locationId }, previous.locationId);
    const contexts = [...new Set(command.contexts ?? [])];
    const known = await tx<
      { id: string }[]
    >`SELECT id FROM condition_definitions WHERE user_id=${userId} AND kind <> 'location' AND status='active' AND id IN ${tx(contexts.length ? contexts : [""])}`;
    const unknown = contexts.filter((id) => !known.some((row) => row.id === id));
    if (unknown.length > 0)
      throw new InvalidCommandError(
        `Not an active context: ${unknown.join(", ")}. The ids that can be named are listed by \`reenter\` with no answers.`
      );
    const placed = nextCurrentSituation(previous, { locationId: command.locationId });
    // What is available is told afresh: the old momentary overrides are from before the gap and are replaced.
    const overrides = Object.fromEntries(contexts.map((id) => [id, "available" as const]));
    const situation = { ...placed, overrides, locationSetAt: now.toISOString(), energySetAt: now.toISOString() };
    await snapshot.before("user_preferences", [userId]);
    await tx`UPDATE user_preferences SET asserted_conditions=${tx.json(contexts as never)},current_energy=${command.energy ?? null},current_situation=${tx.json(situation as never)},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE user_id=${userId}`;

    // The pulse goes back on. The same snapshot holds the lapsed segment, so one undo restores it.
    await writeReentrySegment(tx, userId, { at: now, confirmedBy, snapshot });
    await cancelCatchUpNudges(tx, userId);
    await snapshot.save();

    const unrecorded = plan.verdicts.filter((entry) => entry.unrecorded).map((entry) => entry.verdict.entryId);
    const leftOnLedger = inWindow.filter(reentryLeavesOnLedger).map((entry) => entry.id);
    const result: ReenterResult = {
      reentered: true,
      at: now.toISOString(),
      tier,
      gapMinutes: block.gapMinutes,
      confirmedBy,
      lapsed: plan.lapsing,
      unrecorded: unrecorded.length,
      results,
      leftOnLedger,
      next: reenterNextStep(leftOnLedger),
      revertible: command.commandId
    };
    await recordStateChange(tx, userId, {
      entityType: "catch_up",
      entityId: command.commandId,
      operation: "reenter",
      commandId: command.commandId,
      before: {
        occurrences: beforeOccurrences,
        projects: beforeProjects,
        pulse: { state: pulse.state, reason: pulse.reason, since: pulse.since.toISOString() },
        locationId: previous.locationId
      },
      evidence: {
        tier,
        gapMinutes: block.gapMinutes,
        lastConfirmedAt: block.lastConfirmedAt,
        confirmedBy,
        applied: results.filter((item) => item.outcome === "applied").length,
        lapsed: plan.lapsing,
        // Bulk answers wrote `skipped` for things nobody confirmed; the reader of this log (and of any pace,
        // duration or capacity learning) must not take them for outcomes.
        unrecordedEntries: unrecorded,
        basis: command.basis,
        ...(command.evidence ? { statedEvidence: command.evidence } : {}),
        ...(command.note ? { note: command.note } : {})
      },
      at: now
    });
    await tx`UPDATE writes SET response=${tx.json(result as never)}, updated_at=now() WHERE id=${command.commandId}`;
    return result;
  });
}
