import {
  DISRUPTION_MAX_MINUTES,
  disruptionDoingText,
  incompleteDisruptionMessage,
  missingCommandDisruptionFields,
  type DisruptionField,
  type RecordDisruptionCommand
} from "@openrhen/contracts";
import { requestAgent } from "@/server/agent-actor";
import { isLapsed, readPulseWindow } from "@/server/pulse/pulse-reentry";
import { claimCommandReceipt, commandRequestHash, refuseCommandIdReuse } from "./command-receipt";
import { CommandConflictError, InvalidCommandError } from "./command-errors";
import { ensureUser } from "./ensure-user";
import { assertCurrentLocationIsSavedPlace } from "./location-context";
import { recordStateChange } from "./planning-evidence";
import { readReentryChoices } from "./reenter";
import type { PoolSql, Sql } from "./sql-pool";
import { WriteSnapshot } from "./write-snapshot";

/**
 * `record_disruption` (the pulse on plan design note, sections 1 and 2): the write that keeps a deviation on plan.
 * All or nothing: an incomplete one is refused with each missing field named (422, the way a re-entry is), and nothing
 * is written. A disruption replaces the one in force, and one undo (the write snapshot) puts the earlier one back and
 * removes the new one. The recorder reads the row into the pulse machine; `end` closes it early.
 */

/** An incomplete disruption: the message names each missing field; `body` carries the same, plus the ids a client can name. */
export class DisruptionIncompleteError extends InvalidCommandError {
  constructor(
    message: string,
    readonly body: {
      code: "disruptionIncomplete";
      error: string;
      missing: DisruptionField[];
      choices: Awaited<ReturnType<typeof readReentryChoices>>;
    }
  ) {
    super(message);
  }
}

export interface RecordDisruptionResult {
  recorded: boolean;
  ended: boolean;
  id: string | null;
  doing: string | null;
  until: string | null;
  at: string;
  recordedBy: "person" | "agent";
  /** The command id to undo with (`rhen undo`, or the owner's revert). */
  revertible: string;
}

interface ActiveRow {
  id: string;
}

export async function recordDisruption(
  sql: PoolSql,
  command: RecordDisruptionCommand,
  now: Date = new Date()
): Promise<RecordDisruptionResult> {
  const userId = await ensureUser(sql);
  const requestHash = commandRequestHash("record_disruption", command);
  const replay = async (queryable: Sql): Promise<RecordDisruptionResult | null> => {
    const prior = await queryable<
      { response: RecordDisruptionResult | null; command_type: string; request_hash: string | null }[]
    >`SELECT response, command_type, request_hash FROM writes WHERE id=${command.commandId} AND user_id=${userId}`;
    if (prior[0]) refuseCommandIdReuse(prior[0], { commandType: "record_disruption", requestHash });
    return prior[0]?.response ?? null;
  };
  const earlier = await replay(sql);
  if (earlier) return earlier;

  return sql.begin(async (tx) => {
    // The recorder's own lock (`runPulseRecorderTick`), taken first: the lapsed check below cannot go stale under a
    // tick, and a tick racing this write waits for it and then reads the row it left.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`pulse_recorder:${userId}`}, 0))`;
    if (
      !(await claimCommandReceipt(tx, { id: command.commandId, userId, commandType: "record_disruption", requestHash }))
    ) {
      const stored = await replay(tx);
      if (stored) return stored;
      throw new CommandConflictError(
        "That disruption is already being recorded by another request. Read the state: if it shows the disruption, it landed; if not, repeat the identical call with the same command-id.",
        {
          nextCall: {
            tool: "rhen_disrupt",
            arguments: {},
            note: "read-only without options; shows whether a disruption is in force"
          }
        }
      );
    }
    const recordedBy = requestAgent() === null ? ("person" as const) : ("agent" as const);
    const snapshot = WriteSnapshot.forWrite(tx, userId, command.commandId, "disruption");

    const active = await tx<ActiveRow[]>`
      SELECT id FROM pulse_disruptions WHERE user_id=${userId} AND ended_at IS NULL FOR UPDATE`;

    if (command.end === true) {
      if (active.length === 0)
        throw new CommandConflictError(
          "No disruption is in force, so there is nothing to end. Nothing needs doing; read the state if unsure.",
          {
            nextCall: {
              tool: "rhen_disrupt",
              arguments: {},
              note: "read-only without options; shows whether a disruption is in force"
            }
          }
        );
      await snapshot.before(
        "pulse_disruptions",
        active.map((row) => row.id)
      );
      await tx`UPDATE pulse_disruptions SET ended_at=${now}, updated_at=now() WHERE user_id=${userId} AND ended_at IS NULL`;
      await snapshot.save();
      return finishDisruption(tx, userId, command, {
        recorded: false,
        ended: true,
        id: null,
        doing: null,
        until: null,
        at: now.toISOString(),
        recordedBy,
        revertible: command.commandId
      });
    }

    // A lapsed pulse only heals through re-entry; a disruption would be stored and then ignored.
    const pulse = await readPulseWindow(tx, userId);
    if (isLapsed(pulse))
      throw new CommandConflictError(
        "The pulse has lapsed, and only re-entry puts it back on plan; record the disruption after re-entering. Call rhen_reenter with no arguments to read what it needs.",
        {
          nextCall: {
            tool: "rhen_reenter",
            arguments: {},
            note: "read-only; shows the gap and what re-entry needs"
          }
        }
      );

    const missing = missingCommandDisruptionFields(command);
    if (missing.length > 0) {
      const message = incompleteDisruptionMessage(missing);
      throw new DisruptionIncompleteError(message, {
        code: "disruptionIncomplete",
        error: message,
        missing,
        choices: await readReentryChoices(tx)
      });
    }

    const until = new Date(command.until!);
    if (until.getTime() <= now.getTime())
      throw new InvalidCommandError(
        `until ${command.until} must be in the future; to say the deviation is over, end it with rhen_disrupt {"end":true}.`
      );
    if (until.getTime() - now.getTime() > DISRUPTION_MAX_MINUTES * 60_000)
      throw new InvalidCommandError(
        "`until` is more than 14 days away; a disruption that long means the plan is wrong."
      );
    await assertCurrentLocationIsSavedPlace(tx, userId, { locationId: command.locationId }, null);
    const contexts = [...new Set(command.contexts)];
    const known = await tx<
      { id: string }[]
    >`SELECT id FROM condition_definitions WHERE user_id=${userId} AND kind <> 'location' AND status='active' AND id IN ${tx(contexts)}`;
    const unknown = contexts.filter((id) => !known.some((row) => row.id === id));
    if (unknown.length > 0)
      throw new InvalidCommandError(
        `Not an active context: ${unknown.join(", ")}. The ids that can be named are listed by \`disrupt\` with no answers.`
      );

    await snapshot.before(
      "pulse_disruptions",
      active.map((row) => row.id)
    );
    await tx`UPDATE pulse_disruptions SET ended_at=${now}, updated_at=now() WHERE user_id=${userId} AND ended_at IS NULL`;
    const doing = disruptionDoingText(command.doing)!;
    const target = typeof command.doing === "object" ? command.doing : null;
    const created = await tx<{ id: string }[]>`
      INSERT INTO pulse_disruptions
        (user_id, doing, doing_kind, doing_id, until, location_id, contexts, exclusive, recorded_by, created_at)
      VALUES (${userId}, ${doing}, ${target?.kind ?? null}, ${target?.id ?? null}, ${until}, ${command.locationId!},
              ${tx.json(contexts as never)}, ${command.exclusive!}, ${recordedBy}, ${now})
      RETURNING id`;
    const id = created[0]!.id;
    snapshot.inserted("pulse_disruptions", [id]);
    await snapshot.save();
    return finishDisruption(tx, userId, command, {
      recorded: true,
      ended: false,
      id,
      doing,
      until: until.toISOString(),
      at: now.toISOString(),
      recordedBy,
      revertible: command.commandId
    });
  });
}

async function finishDisruption(
  tx: Sql,
  userId: string,
  cmd: RecordDisruptionCommand,
  result: RecordDisruptionResult
): Promise<RecordDisruptionResult> {
  await recordStateChange(tx, userId, {
    entityType: "pulse_disruption",
    entityId: result.id,
    operation: result.ended ? "end_disruption" : "record_disruption",
    commandId: cmd.commandId,
    evidence: {
      recordedBy: result.recordedBy,
      ...(result.doing ? { doing: result.doing, until: result.until } : {}),
      basis: cmd.basis,
      ...(cmd.evidence ? { statedEvidence: cmd.evidence } : {})
    },
    at: new Date(result.at)
  });
  await tx`UPDATE writes SET response=${tx.json(result as never)}, updated_at=now() WHERE id=${cmd.commandId}`;
  return result;
}
