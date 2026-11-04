import {
  DEFAULT_TIMEZONE,
  STRETCH_NEXT_CALL,
  STRETCH_REASK_NEXT,
  agentStretchProblems,
  localDateOf,
  parseStretchOffer,
  resolveLocale,
  stretchClock,
  stretchNextStep,
  stretchOfferText,
  type StretchCommand,
  type StretchOfferView,
  type StretchResult,
  type StretchState
} from "@openrhen/contracts";
import { changeLogActor, requestAgent } from "@/server/agent-actor";
import { claimCommandReceipt, commandRequestHash, refuseCommandIdReuse } from "./command-receipt";
import { CommandConflictError, InvalidCommandError } from "./command-errors";
import { parseCurrentSituation, pruneStretch } from "./current-situation";
import { ensureUser } from "./ensure-user";
import { recordStateChange, requireCurrentPlanForecast } from "./planning-evidence";
import type { PoolSql, Sql } from "./sql-pool";
import { WriteSnapshot } from "./write-snapshot";

/**
 * `stretch`: the person's answer to a stretch offer (low-energy deadlines design, option B). Accepting waives the
 * declared-energy cut for one action for the offered minutes; declining skips that action, or every stretch, until
 * the next local day. The answer lives in `current_situation.stretch` and nowhere else; the exact offer sentence and
 * the quoted yes go to the change log (`write_rows`), which outlives the seven-day record.
 *
 * Accepting is judged against the newest published plan run, never against a fresh engine call: the run must carry
 * an offer for this very action, and the title and minutes come from it. The publication lock is taken before the
 * settings row lock (the worker's publish takes them in that order), the write merges into the freshly locked
 * `current_situation`, and `until` is the server's clock after the lock plus the offered minutes. A client never
 * supplies either. Undo is a row snapshot of the `stretch` key alone (kind `stretch`, see `write-snapshot.ts`), so
 * a location ping or an unrelated save made since does not block it and is not undone by it.
 */

/** Every refusal ends with the one call that finds out what stands now. */
function stretchRefusal(
  message: string,
  next = "call rhen_status; tell the person about a stretch only if its answer shows stretchOffer."
): CommandConflictError {
  return new CommandConflictError(`${message} Nothing was changed. Next: ${next}`, { nextCall: STRETCH_NEXT_CALL });
}

function hasSameLocalDay(a: Date, b: Date, timeZone: string): boolean {
  return localDateOf(a, timeZone) === localDateOf(b, timeZone);
}

/** The offer a published run carries, or null. */
function offerOf(recommendation: unknown): StretchOfferView | null {
  if (!recommendation || typeof recommendation !== "object" || Array.isArray(recommendation)) return null;
  return parseStretchOffer((recommendation as Record<string, unknown>).stretchOffer);
}

/** Refuses an accept the stored answers or the run rule out. Mirrors the engine's `resolveStretchState`. */
function refuseAccept(input: {
  offer: StretchOfferView | null;
  actionId: string;
  runCalculatedAt: Date;
  energySetAt: Date | undefined;
  stretch: StretchState | undefined;
  at: Date;
  timeZone: string;
  locale: string;
}): void {
  const { offer, actionId, energySetAt, stretch, at, timeZone, locale } = input;
  if (!offer) throw stretchRefusal("There is no stretch offer now (it expired, was declined, or energy changed).");
  if (offer.actionId !== actionId)
    throw stretchRefusal(
      `The stretch on offer now is for "${offer.title}" (${offer.actionId}), not ${actionId}.`,
      STRETCH_REASK_NEXT
    );
  if (energySetAt && input.runCalculatedAt.getTime() < energySetAt.getTime())
    throw stretchRefusal(
      "The plan has not caught up with the energy the person declared since, so its offer may be out of date."
    );
  if (stretch?.declinedAllAt && hasSameLocalDay(new Date(stretch.declinedAllAt), at, timeZone))
    throw stretchRefusal("The person said no stretches tonight; do not offer one again until tomorrow.");
  const declined = (stretch?.declined ?? []).some(
    (entry) =>
      entry.actionId === actionId &&
      hasSameLocalDay(new Date(entry.at), at, timeZone) &&
      (!energySetAt || new Date(entry.at).getTime() >= energySetAt.getTime())
  );
  if (declined) throw stretchRefusal("The person declined this stretch today; do not offer it again until tomorrow.");
  const active = (stretch?.accepted ?? []).find(
    (record) =>
      record.actionId === actionId &&
      at.getTime() < new Date(record.until).getTime() &&
      energySetAt !== undefined &&
      new Date(record.acceptedAt).getTime() >= energySetAt.getTime()
  );
  if (active)
    throw stretchRefusal(
      `A stretch for this action is already running until ${stretchClock(new Date(active.until), timeZone, locale)}.`,
      "start it with rhen_session start, or call rhen_status to see the plan."
    );
}

export async function runStretchCommand(
  sql: PoolSql,
  command: StretchCommand,
  clock?: Date
): Promise<{ result: StretchResult }> {
  const userId = await ensureUser(sql);
  const requestHash = commandRequestHash("stretch", command);
  const replay = async (queryable: Sql): Promise<StretchResult | null> => {
    const prior = await queryable<
      { response: StretchResult | null; command_type: string; request_hash: string | null }[]
    >`SELECT response, command_type, request_hash FROM writes WHERE id=${command.commandId} AND user_id=${userId}`;
    if (prior[0]) refuseCommandIdReuse(prior[0], { commandType: "stretch", requestHash });
    return prior[0]?.response ?? null;
  };
  const earlier = await replay(sql);
  if (earlier) return { result: earlier };

  // An agent answers only on the person's word; nothing is read or written before that is settled.
  if (requestAgent() !== null) {
    const problems = agentStretchProblems(command);
    if (problems.length > 0) throw new InvalidCommandError(problems[0]!);
  }

  return sql.begin(async (tx) => {
    if (!(await claimCommandReceipt(tx, { id: command.commandId, userId, commandType: "stretch", requestHash }))) {
      const stored = await replay(tx);
      if (stored) return { result: stored };
      throw new CommandConflictError(
        "That answer is already being applied by another request. Repeat the identical call with the same command-id.",
        { nextCall: STRETCH_NEXT_CALL }
      );
    }

    // Accept: the newest published run, under the publication lock, BEFORE the settings row lock below.
    const run = command.choice === "accept" ? await requireCurrentPlanForecast(tx, userId, clock ?? new Date()) : null;

    const prefs = await tx<
      { current_situation: unknown }[]
    >`SELECT current_situation FROM user_preferences WHERE user_id=${userId} FOR UPDATE`;
    if (!prefs[0])
      throw new InvalidCommandError("Settings are not set up yet, so there is nothing to record a stretch on.");
    // The clock is read after the locks, so `until` counts from when the answer actually landed.
    const at = clock ?? new Date();
    const user = (
      await tx<
        { timezone: string | null; locale: string | null }[]
      >`SELECT timezone, locale FROM users WHERE id=${userId}`
    )[0];
    const timeZone = user?.timezone ?? DEFAULT_TIMEZONE;
    const locale = resolveLocale(user?.locale);
    const previous = parseCurrentSituation(prefs[0].current_situation);
    const energySetAt = previous.energySetAt ? new Date(previous.energySetAt) : undefined;
    const by = requestAgent() === null ? ("person" as const) : ("agent" as const);

    let offer: StretchOfferView | null = null;
    let next: StretchState | undefined;
    const kept = previous.stretch ?? { accepted: [], declined: [] };
    let result: StretchResult;
    let operation: string;

    if (command.choice === "accept") {
      offer = offerOf((run as { recommendation: unknown }).recommendation);
      refuseAccept({
        offer,
        actionId: command.actionId!,
        runCalculatedAt: new Date((run as { calculatedAt: string }).calculatedAt),
        energySetAt,
        stretch: previous.stretch,
        at,
        timeZone,
        locale
      });
      const picked = offer!;
      const until = new Date(at.getTime() + picked.minutes * 60_000);
      next = pruneStretch(
        {
          ...kept,
          accepted: [
            ...kept.accepted,
            {
              actionId: picked.actionId,
              title: picked.title,
              acceptedAt: at.toISOString(),
              until: until.toISOString(),
              minutes: picked.minutes,
              by
            }
          ]
        },
        at
      );
      operation = "stretch_accept";
      result = {
        choice: "accept",
        outcome: "accepted",
        actionId: picked.actionId,
        title: picked.title,
        minutes: picked.minutes,
        until: until.toISOString(),
        by,
        offerText: stretchOfferText(picked, { timeZone, locale, now: at }),
        next: stretchNextStep("accepted", { title: picked.title, until: until.toISOString(), timeZone, locale }),
        revertible: command.commandId
      };
    } else if (command.choice === "decline") {
      const actionId = command.actionId!;
      next = pruneStretch(
        {
          ...kept,
          declined: [
            ...kept.declined.filter((entry) => entry.actionId !== actionId),
            { actionId, at: at.toISOString() }
          ]
        },
        at
      );
      operation = "stretch_decline";
      result = {
        choice: "decline",
        outcome: "declined",
        actionId,
        by,
        next: stretchNextStep("declined", { timeZone, locale }),
        revertible: command.commandId
      };
    } else {
      next = pruneStretch({ ...kept, declinedAllAt: at.toISOString() }, at);
      operation = "stretch_decline_all";
      result = {
        choice: "decline_all",
        outcome: "declined_all",
        by,
        next: stretchNextStep("declined_all", { timeZone, locale }),
        revertible: command.commandId
      };
    }

    // Undoable whoever answers: the owner's own accept is reversible from Review as well as an agent's.
    const snapshot = WriteSnapshot.forWrite(tx, userId, command.commandId, "stretch");
    await snapshot.before("user_preferences", [userId]);
    // Only the `stretch` key is written, into the row as it stands under the lock, so nothing else in the situation moves.
    if (next === undefined)
      await tx`UPDATE user_preferences SET current_situation=COALESCE(current_situation,'{}'::jsonb) - 'stretch',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE user_id=${userId}`;
    else
      await tx`UPDATE user_preferences SET current_situation=jsonb_set(COALESCE(current_situation,'{}'::jsonb),'{stretch}',${tx.json(next as never)}),version=version+1,updated_at=CURRENT_TIMESTAMP WHERE user_id=${userId}`;
    await snapshot.save();

    await recordStateChange(tx, userId, {
      entityType: "current_situation",
      entityId: command.commandId,
      operation,
      commandId: command.commandId,
      before: { stretch: previous.stretch ?? null },
      evidence: {
        choice: command.choice,
        ...(command.actionId ? { actionId: command.actionId } : {}),
        by,
        actor: changeLogActor(),
        basis: command.basis,
        ...(command.evidence ? { statedEvidence: command.evidence } : {}),
        ...(offer ? { offerText: result.offerText, offer } : {})
      },
      at
    });
    await tx`UPDATE writes SET response=${tx.json(result as never)}, updated_at=now() WHERE id=${command.commandId}`;
    return { result };
  });
}
