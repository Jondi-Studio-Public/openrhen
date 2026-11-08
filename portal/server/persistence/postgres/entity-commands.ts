import type { OpenQuestion, PlanningEntityCommand } from "@openrhen/contracts";
import {
  DEFAULT_PULSE_THRESHOLDS,
  hardFloorReason,
  ownerOnlySettingsFieldsIn,
  primarySourceIds,
  settingsPlace,
  spanEntitySchema,
  spanRemoveEntitySchema,
  timeBandSchema,
  transportModeSchema,
  removedFieldMessage
} from "@openrhen/contracts";
import {
  actions as actionsTable,
  conditionDefinitions as conditionDefinitionsTable,
  dailyPlans as dailyPlansTable,
  commitments as commitmentsTable,
  planningFocusPeriods as planningFocusPeriodsTable,
  captures as capturesTable,
  routineStepDependencies as routineStepDependenciesTable,
  routineSteps as routineStepsTable,
  sleepPlans as sleepPlansTable,
  sources as sourcesTable,
  userPreferences as userPreferencesTable,
  users as usersTable
} from "@openrhen/database";
import "./private/index";
import { agentCaptureRefusal, agentProposalTypeRefusal, entityExtensions, proposalOwner } from "./entity-extensions";
import { changeLogConfirmedBy, requestAgent } from "@/server/agent-actor";
import { locationCoordinatesProblem } from "@/features/settings/location-coordinates";
import { contactAddressProblem } from "@/features/commitments/contact-message";
import { recordOwnTripOnArrival } from "@/server/travel/own-trip";
import { clampHorizonOverride } from "@/shared/planning-day";
import { localDateString } from "./row-values";
import type { PortalState } from "@/state/portal-state";
import {
  ForbiddenCommandError,
  InvalidCommandError,
  badValue,
  invalidChoice,
  notFound,
  notFoundConflict,
  outOfRange,
  refused,
  versionConflict,
  wrongState
} from "./command-errors";
import {
  fractionNumber,
  nonNegativeInt,
  optionalBoolean,
  optionalDate,
  optionalText,
  positiveInt,
  requiredDate,
  requiredLocalDate,
  requiredText,
  planCodePatternValue,
  requiredLocale,
  requiredTimeZone,
  scoreInt,
  stableUuid,
  stringList,
  isUuid
} from "./command-values";
import { assertCurrentLocationIsSavedPlace, optionalActiveLocationId } from "./location-context";
import { nextCurrentSituation, parseCurrentSituation, reassertLocationOnWake } from "./current-situation";
import { checkPeopleStatements } from "./presence-write";
import { rollDeliverableSessionForward } from "./deliverable-session-rollover";
import { writeDeliverableAggregate } from "./deliverable-write";
import { ensureUser } from "./ensure-user";
import { claimCommandReceipt, commandRequestHash, hasCommandReceipt } from "./command-receipt";
import type { LeftJoined, Row } from "./db-row";
import { applyProposalAnswers, captureQuestions } from "./proposal-questions";
import { hasCycle, validateRoutineEntityGraph } from "./graph-checks";
import { assertNoClosedTransition } from "./close-floor";
import { recordStateChange } from "./planning-evidence";
import { readStateAfterCommit } from "./read-after-commit";
import { skipMootRoutineSteps } from "./routine-step-arrival";
import { syncSleepSession } from "./sleep-session-sync";
import { insertLoggedNight, loggedWakeBefore, refuseOverlappingNight, syncLastWokeAt } from "./sleep-wake";
import { completeStepActionOccurrence } from "./routine-step-window";
import type { PoolSql, Sql } from "./sql-pool";
import { watchContractReviewWrite, watchDeliverableWrite, watchEntityWrite } from "./entity-snapshot";
import { WriteSnapshot } from "./write-snapshot";
import { assertNotHomeLocation, assertNotRequiredByOpenWork } from "./close-rules";

/** The four disruption kinds `commitments`'s disruption_source CHECK constraint allows; only
 * their labels are ever user-editable, never the set itself. */
const DISRUPTION_KIND_KEYS = ["work", "family", "life_admin", "other"] as const;

function validatedDisruptionKindLabels(value: unknown): Record<(typeof DISRUPTION_KIND_KEYS)[number], string> {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const result = {} as Record<(typeof DISRUPTION_KIND_KEYS)[number], string>;
  for (const key of DISRUPTION_KIND_KEYS) result[key] = requiredText(record[key], `The ${key.replace("_", " ")} label`);
  return result;
}

function validatedDisruptionWhenPresets(value: unknown): { id: string; label: string; delayMinutes: number }[] {
  if (!Array.isArray(value) || !value.length)
    throw new InvalidCommandError(
      'disruptionWhenPresets is empty or missing: send at least one preset, each {"id","label","delayMinutes"} (delayMinutes a whole number of minutes, 0 or more).'
    );
  return value.map((item, index) => {
    const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const idRaw = optionalText(row.id);
    return {
      id: idRaw ?? `when-${index}`,
      label: requiredText(row.label, "When preset label"),
      delayMinutes: nonNegativeInt(row.delayMinutes, "When preset delay")
    };
  });
}

function validatedDisruptionDurationPresets(
  value: unknown
): { id: string; label: string; kind: "minutes" | "rest_of_day" | "unknown"; minutes?: number }[] {
  if (!Array.isArray(value) || !value.length)
    throw new InvalidCommandError(
      'disruptionDurationPresets is empty or missing: send at least one preset, each {"id","label","kind"} with kind minutes (add "minutes"), rest_of_day or unknown.',
      { validValues: { kind: ["minutes", "rest_of_day", "unknown"] } }
    );
  return value.map((item, index) => {
    const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const idRaw = optionalText(row.id);
    const id = idRaw ?? `duration-${index}`;
    const label = requiredText(row.label, "Duration preset label");
    const kind = row.kind;
    if (kind !== "minutes" && kind !== "rest_of_day" && kind !== "unknown")
      throw invalidChoice("disruptionDurationPresets[].kind", kind, ["minutes", "rest_of_day", "unknown"], {
        label: "Duration preset kind"
      });
    return kind === "minutes"
      ? { id, label, kind, minutes: positiveInt(row.minutes, "Duration preset minutes") }
      : { id, label, kind };
  });
}

/** The ways a criterion can be checked. */
const VERIFICATION_METHODS: readonly string[] = [
  "llm_inspection",
  "user_confirmation",
  "submission_receipt",
  "external_result",
  "not_verifiable"
];

/**
 * Validates a `transport_mode` write against the fixed set the column's own CHECK constraint allows
 * `null`/`undefined`/`""` clears the field; anything
 * else must name one of the three modes.
 */
function optionalTransportMode(value: unknown): "car" | "bike" | "walk" | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = transportModeSchema.safeParse(value);
  if (!parsed.success)
    throw invalidChoice("transportMode", value, ["car", "bike", "walk"], { label: "Transport mode" });
  return parsed.data;
}

/**
 * The stay-up offer's own literal choice set,
 * not any 0–90 integer. The `sleep_plans` table also checks this (0,30,60,90), but rejecting it here
 * gives a clean `InvalidCommandError` for a value the offer never presented, such as 45, instead of a
 * raw Postgres constraint-violation error reaching the caller.
 */
function stayUpAnswerMinutesLiteral(value: unknown): 0 | 30 | 60 | 90 {
  if (value === 0 || value === 30 || value === 60 || value === 90) return value;
  throw invalidChoice("stayUpAnswerMinutes", value, ["0", "30", "60", "90"], { label: "Stay-up answer (minutes)" });
}

function routineStepTimingFields(source: Record<string, unknown>): {
  waitAfterMinutes: number;
  mustStartByMinutes: number | null;
  preferredBands: string[];
} {
  const waitAfterMinutes =
    source.waitAfterMinutes === undefined ? 0 : nonNegativeInt(source.waitAfterMinutes, "Wait after");
  const mustStartByMinutes =
    source.mustStartByMinutes === undefined || source.mustStartByMinutes === null
      ? null
      : positiveInt(source.mustStartByMinutes, "Must start by");
  const preferredBands = Array.isArray(source.preferredBands)
    ? source.preferredBands.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  return { waitAfterMinutes, mustStartByMinutes, preferredBands };
}

/**
 * Data-flow settings (who sees the plan, which model reads it) are the owner's alone: a request that carries an
 * agent identity may not name them, even to restate the stored value (security A7). Presence is the test, so a
 * client cannot probe by writing back what is stored. A headerless caller counts as the owner, so this stops a
 * caller that names itself an agent, including a proposal the owner confirmed: no proposal may carry these fields
 * (`proposableCommandRefusal`), and one filed before that rule is not applied on the person's click.
 */
function refuseOwnerOnlySettingsForAgent(entity: Record<string, unknown>): void {
  if (requestAgent() === null) return;
  const fields = ownerOnlySettingsFieldsIn(entity);
  if (fields.length > 0)
    throw new ForbiddenCommandError(
      `Only the owner can change ${fields.join(", ")}; an agent cannot. ` +
        `The person changes ${fields.length === 1 ? "it" : "them"} in ${[...new Set(fields.map(settingsPlace))].join(", ")}.`
    );
}

/**
 * A save with the hash its receipt should carry in place of the one computed from the payload. Server code only (the
 * save routes parse their body and drop it): a workspace move saves a deliverable whose stamps (an approval time)
 * differ on every send, so the move names what it asked for, and a repeat of the same move matches its receipt.
 */
export type EntityCommandWithHash = PlanningEntityCommand & { requestHash?: string | undefined };

export async function saveEntity(sql: PoolSql, command: EntityCommandWithHash): Promise<PortalState> {
  // The old calendar-sharing field names are refused, not read as the new ones and not dropped (`removed-field-names.ts`).
  const removedField = removedFieldMessage(command.entity);
  if (removedField !== null) throw new InvalidCommandError(removedField);
  if (command.entityType === "settings") refuseOwnerOnlySettingsForAgent(command.entity);
  const userId = await ensureUser(sql);
  const requestHash = command.requestHash ?? commandRequestHash(command.entityType, command);
  if (await hasCommandReceipt(sql, { id: command.commandId, userId, commandType: command.entityType, requestHash }))
    return await readStateAfterCommit(sql);
  await sql.begin(async (tx) => {
    if (
      !(await claimCommandReceipt(tx, { id: command.commandId, userId, commandType: command.entityType, requestHash }))
    )
      return;
    const entity = command.entity;
    const rawId = typeof entity.id === "string" ? entity.id : command.commandId;
    // An agent's save keeps the rows it touches so it can be undone afterwards (write-snapshot.ts). A confirm keeps
    // its own snapshot below.
    const saveSnap =
      command.entityType === "capture_review" ? null : await WriteSnapshot.open(tx, userId, command.commandId, "save");
    // A confirm keeps a snapshot of its own kind, opened here too so the publication lock precedes its row locks.
    const confirmSnap =
      command.entityType === "capture_review"
        ? await WriteSnapshot.open(tx, userId, command.commandId, "confirm")
        : null;
    await watchEntityWrite(saveSnap, userId, command);
    // An agent's save may not close a row; the refusal names the close call (close-floor.ts).
    await assertNoClosedTransition(
      tx,
      userId,
      command.entityType,
      rawId,
      (command.entity as { status?: unknown }).status
    );
    // The id the record is stored under, for kinds that hash the one sent; the change feed names this one.
    let storedId: string | undefined;
    let proposalEvidence: Record<string, unknown> | undefined;
    // Set when this save made the row (no stored row): the ledger marks it, so an agent's undo of the create can be verified.
    let created = false;
    const verifyVersion = (actual: number | undefined) => {
      created = actual === undefined;
      if (actual !== undefined && actual !== command.expectedVersion)
        throw versionConflict(command.entityType.replace(/_/g, " "), rawId, command.expectedVersion, actual);
      if (actual === undefined && command.expectedVersion !== null) throw notFoundConflict(command.entityType, rawId);
    };
    if (command.entityType === "area") {
      const id = await stableUuid(`area:${userId}`, rawId);
      storedId = id;
      const rows = await tx<
        { version: number }[]
      >`SELECT version FROM areas WHERE id=${id} AND user_id=${userId} FOR UPDATE`;
      verifyVersion(rows[0]?.version);
      const name = requiredText(entity.name, "Area name");
      const status = requiredText(entity.status, "Area status");
      const sortOrder = nonNegativeInt(entity.sortOrder, "Area order");
      const isPrivate = optionalBoolean(entity.private);
      if (rows[0])
        await tx`UPDATE areas SET name=${name}, description=${optionalText(entity.description)}, status=${status}, sort_order=${sortOrder}, private=COALESCE(${isPrivate},private), version=version+1, updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
      else
        await tx`INSERT INTO areas (id,user_id,name,description,status,sort_order,private) VALUES (${id},${userId},${name},${optionalText(entity.description)},${status},${sortOrder},${isPrivate ?? false})`;
    } else if (command.entityType === "outcome") {
      const id = await stableUuid(`outcome:${userId}`, rawId);
      storedId = id;
      const areaId = await stableUuid(`area:${userId}`, requiredText(entity.areaId, "Area"));
      const owned = await tx<{ id: string }[]>`SELECT id FROM areas WHERE id=${areaId} AND user_id=${userId}`;
      if (!owned[0]) throw notFound("area", entity.areaId);
      const rows = await tx<
        { version: number }[]
      >`SELECT o.version FROM outcomes o JOIN areas a ON a.id=o.area_id WHERE o.id=${id} AND a.user_id=${userId} FOR NO KEY UPDATE OF o`;
      verifyVersion(rows[0]?.version);
      const title = requiredText(entity.title, "Outcome title");
      const done = requiredText(entity.definitionOfDone, "Definition of done");
      const value = scoreInt(entity.value, "Outcome value");
      const status = requiredText(entity.status, "Outcome status");
      const deadline = optionalDate(entity.deadlineAt, "deadlineAt");
      const review = optionalText(entity.reviewOn)?.slice(0, 10) ?? null;
      if (rows[0])
        await tx`UPDATE outcomes SET area_id=${areaId},title=${title},definition_of_done=${done},value=${value},status=${status},deadline_at=${deadline},review_on=${review},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
      else
        await tx`INSERT INTO outcomes (id,area_id,title,definition_of_done,value,status,deadline_at,review_on) VALUES (${id},${areaId},${title},${done},${value},${status},${deadline},${review})`;
    } else if (command.entityType === "commitment" && Object.prototype.hasOwnProperty.call(entity, "free")) {
      // "I'm free": a statement about this one occurrence, handled before the ordinary commitment save
      // asks for a title and times. It writes `freed_from` and nothing the family calendar shows (the title,
      // times, place and status are untouched, and no extension hook runs), so it is not an outbound change.
      const id = await stableUuid(`commitment:${userId}`, rawId);
      storedId = id;
      if (typeof entity.free !== "boolean") throw badValue("free", entity.free, "true or false", "true");
      const others = Object.keys(entity).filter((key) => key !== "id" && key !== "free" && key !== "version");
      if (others.length > 0)
        throw refused({
          message:
            `free is a statement on its own and cannot be sent with ${others.join(", ")}. ` +
            "Send only id and free; make any other change in a separate save.",
          nextCall: {
            tool: "rhen_save_commitment",
            arguments: { fields: { id: rawId, free: entity.free } },
            note: "id and free only"
          }
        });
      const rows = await tx<
        {
          version: number;
          status: string;
          title: string;
          starts_at: Date;
          ends_at: Date;
          freed_from: Date | null;
          tracked_end: Date;
          running_over: boolean;
        }[]
      >`SELECT c.version, c.status, c.title, c.starts_at, c.ends_at, c.freed_from,
          GREATEST(c.ends_at, COALESCE((SELECT MAX(se.ended_at) FROM sessions se WHERE se.target_type='fixed_commitment' AND se.target_id=c.id AND se.started_at<c.ends_at AND se.ended_at>c.ends_at), c.ends_at)) AS tracked_end,
          EXISTS (SELECT 1 FROM sessions se WHERE se.target_type='fixed_commitment' AND se.target_id=c.id AND se.status IN ('running','paused') AND se.started_at<c.ends_at) AS running_over
        FROM commitments c WHERE c.id=${id} AND c.user_id=${userId} FOR UPDATE OF c`;
      verifyVersion(rows[0]?.version);
      const row = rows[0];
      if (!row) throw notFound("commitment", rawId);
      const at = new Date();
      if (entity.free === true) {
        if (row.status !== "confirmed")
          throw refused({
            message: `"${row.title}" is ${row.status}, so it is not holding any time to free. Only a confirmed commitment can be freed.`
          });
        if (row.starts_at > at)
          throw refused({
            message:
              `"${row.title}" has not started (it starts ${row.starts_at.toISOString()}), so there is nothing to free yet. ` +
              "If you are not going, cancel it with rhen_cancel instead; free works only from its start to its end.",
            nextCall: {
              tool: "rhen_cancel",
              arguments: { type: "commitment", id: rawId },
              note: "only if it will not happen"
            }
          });
        // The effective end: the scheduled end, or the later of it and tracked overtime; a session still open
        // against it means it is running now.
        if (!row.running_over && row.tracked_end <= at)
          throw refused({
            message:
              `"${row.title}" has already ended (${row.tracked_end.toISOString()}), so there is nothing left of it to free. ` +
              "Call rhen_status for what to do now."
          });
      }
      // Freed again keeps the first instant: the statement was made then.
      await tx`UPDATE commitments SET freed_from=${entity.free ? (row.freed_from ?? at) : null}, version=version+1, updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
    } else if (command.entityType === "commitment") {
      const id = await stableUuid(`commitment:${userId}`, rawId);
      storedId = id;
      const rows = await tx<
        Row<
          typeof commitmentsTable,
          | "version"
          | "presence"
          | "share_to_calendar"
          | "recurrence_rule_id"
          | "schedule_source"
          | "title"
          | "starts_at"
          | "ends_at"
          | "location"
          | "location_id"
          | "setup_before_minutes"
          | "transition_after_minutes"
          | "project_id"
          | "contact_id"
          | "lateness_matters"
          | "transport_mode"
          | "attendance"
          | "preferred_location_id"
        >[]
      >`SELECT version,presence,share_to_calendar,recurrence_rule_id,schedule_source,title,starts_at,ends_at,location,location_id,setup_before_minutes,transition_after_minutes,project_id,contact_id,lateness_matters,transport_mode,attendance,preferred_location_id FROM commitments WHERE id=${id} AND user_id=${userId} FOR UPDATE`;
      verifyVersion(rows[0]?.version);
      const starts = requiredDate(entity.startsAt, "Commitment start");
      const ends = requiredDate(entity.endsAt, "Commitment end");
      if (starts >= ends)
        throw badValue(
          "Commitment end",
          entity.endsAt,
          `it must be after the start (${String(entity.startsAt)}); repeat with a later endsAt`
        );
      // A buffer the save leaves out is not "0": an existing commitment keeps its own, and a new one gets the
      // owner's default buffer (Settings > Planning > Buffers), the same default the portal's own forms start from.
      const unsent = (field: string) => entity[field] === undefined || entity[field] === null;
      const defaults = rows[0]
        ? null
        : (
            await tx<
              { default_setup_buffer_minutes: number; default_transition_buffer_minutes: number }[]
            >`SELECT default_setup_buffer_minutes, default_transition_buffer_minutes FROM user_preferences WHERE user_id=${userId}`
          )[0];
      const setupBefore = unsent("setupBeforeMinutes")
        ? (rows[0]?.setup_before_minutes ?? defaults?.default_setup_buffer_minutes ?? 0)
        : nonNegativeInt(entity.setupBeforeMinutes, "Commitment setupBeforeMinutes");
      const transitionAfter = unsent("transitionAfterMinutes")
        ? (rows[0]?.transition_after_minutes ?? defaults?.default_transition_buffer_minutes ?? 0)
        : nonNegativeInt(entity.transitionAfterMinutes, "Commitment transitionAfterMinutes");
      const values = [
        requiredText(entity.title, "Commitment title"),
        requiredText(entity.status, "Commitment status"),
        setupBefore,
        transitionAfter
      ] as const;
      const projectRaw = optionalText(entity.projectId);
      const projectId = projectRaw ? await stableUuid(`project:${userId}`, projectRaw) : null;
      if (projectId) {
        const owned = await tx<
          { id: string }[]
        >`SELECT p.id FROM projects p JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id WHERE p.id=${projectId} AND a.user_id=${userId}`;
        if (!owned[0]) throw notFound("project", projectRaw);
      }
      const locationId = await optionalActiveLocationId(tx, userId, entity.locationId, "Commitment location");
      // Presence, like the routine source below, is only written when the save names one: a caller
      // that never mentions it — an import, a capture proposal — must not quietly reset a commitment
      // back to blocking. COALESCE keeps the stored value in that case.
      const presence = optionalText(entity.presence);
      if (presence !== null && presence !== "blocking" && presence !== "anchor")
        throw invalidChoice("presence", presence, ["blocking", "anchor"], { label: "Commitment presence" });
      // A recurring occurrence's presence otherwise just tracks its rule (see presence_source and
      // persistDerivedState in plan-forecast-runtime.ts) — every replan re-derives it from there and
      // heals the row. A save that actually changes presence away from what is stored is a deliberate
      // per-occurrence tweak, so it detaches this one row from that healing ('custom') the same
      // one-way way a hand-edited routine step detaches routine_source. Re-saving the same value (the
      // editor round-tripping an untouched field) is not a tweak and must not detach it (this
      // is what let a single occurrence's engagement-level edit be reverted by the
      // very next replan).
      const presenceSource = rows[0] && presence !== null && presence !== rows[0].presence ? "custom" : null;
      // Same inherit/custom split as presence_source above, for the family calendar share
      // flag: a recurring occurrence otherwise tracks its rule's share_to_calendar (healed by
      // plan-forecast-runtime on replan), and a save that actually flips this one occurrence's value
      // away from what is stored detaches it to 'custom' so a replan never silently re-shares (or
      // un-shares) it. Re-saving the same value must not detach it, for the same reason as presence.
      const shareToCalendar = optionalBoolean(entity.shareToCalendar);
      const shareSource =
        rows[0] && shareToCalendar !== null && shareToCalendar !== rows[0].share_to_calendar ? "custom" : null;
      // Same absence-means-no-opinion rule as presence: a caller silent about prompt policy must not
      // reset a commitment that was deliberately set to 'silent' or 'reduced' back to 'normal'.
      const promptPolicy = optionalText(entity.promptPolicy);
      if (promptPolicy !== null && !["silent", "reduced", "normal"].includes(promptPolicy))
        throw invalidChoice("promptPolicy", promptPolicy, ["silent", "reduced", "normal"], {
          label: "Commitment prompt policy"
        });
      // Pulse check-in allowance: minutes added to the lapse thresholds while
      // this commitment is in force. Silence keeps the stored value, null clears it back to the default.
      const hasCheckInExtra = Object.prototype.hasOwnProperty.call(entity, "checkInExtraMinutes");
      let checkInExtraMinutes: number | null = null;
      if (hasCheckInExtra && entity.checkInExtraMinutes !== null) {
        checkInExtraMinutes = nonNegativeInt(entity.checkInExtraMinutes, "Check-in allowance");
        if (checkInExtraMinutes > 480) throw outOfRange("Check-in allowance", checkInExtraMinutes, 0, 480, "minutes");
      }
      // The routine source is only written when the save names one, so an editor that never mentions
      // it cannot reset a commitment that has detached to 'custom' or been switched to 'none'.
      const routineSourceRaw = optionalText(entity.routineSource);
      let routine: { source: string; presetId: string | null } | null = null;
      if (routineSourceRaw !== null) {
        const allowedRoutineSource: readonly string[] = ["inherit", "preset", "custom", "none"];
        if (!allowedRoutineSource.includes(routineSourceRaw))
          throw invalidChoice("routineSource", routineSourceRaw, allowedRoutineSource, { label: "Routine source" });
        const presetRaw = optionalText(entity.routinePresetId);
        const presetId = presetRaw ? await stableUuid(`routine-preset:${userId}`, presetRaw) : null;
        if (routineSourceRaw === "preset" && !presetId)
          throw refused({
            message: `routineSource is "preset" but routinePresetId was not sent. Send routinePresetId with a routine's id, or set routineSource to inherit, custom or none.`,
            validValues: { routineSource: ["inherit", "preset", "custom", "none"] },
            nextCall: {
              tool: "rhen_list",
              arguments: { entity: "routine-presets", limit: 20 },
              note: "use an id from the rows returned"
            }
          });
        if (presetId) {
          const ownedPreset = await tx<
            { id: string }[]
          >`SELECT id FROM routine_presets WHERE id=${presetId} AND user_id=${userId}`;
          if (!ownedPreset[0]) throw notFound("routine", presetRaw);
        }
        routine = { source: routineSourceRaw, presetId: routineSourceRaw === "preset" ? presetId : null };
      }
      // Disruption provenance follows the same rule as presence, and for a sharper reason: the
      // ordinary commitment editor never sends these four fields at all, so writing them
      // unconditionally would demote every disruption to 'planned' the first time somebody nudged
      // its end time. COALESCE reads their absence as "no opinion" rather than as an answer.
      const origin = optionalText(entity.origin);
      if (origin !== null && origin !== "planned" && origin !== "disruption")
        throw invalidChoice("origin", origin, ["planned", "disruption"], { label: "Commitment origin" });
      const disruptionSource = optionalText(entity.disruptionSource);
      if (disruptionSource !== null) {
        // A source only means something as part of a disruption, and the payload has to say so in
        // the same breath: silently accepting one against a planned commitment would let the two
        // columns drift into a state the CHECK constraint exists to prevent.
        if (origin !== "disruption") throw new InvalidCommandError("A disruption source only belongs on a disruption.");
        if (!["work", "family", "life_admin", "other"].includes(disruptionSource))
          throw invalidChoice("disruptionSource", disruptionSource, ["work", "family", "life_admin", "other"], {
            label: "Disruption source"
          });
      }
      const disruptionOpenEnded = optionalBoolean(entity.disruptionOpenEnded);
      const landedAt = optionalDate(entity.landedAt, "landedAt");
      // The occurrence editor's whole overlay — title, times, place, buffers, project and (below)
      // contact — is what iCal-style per-date edits mean: a rule-backed row that actually diverges
      // from what it last stored detaches to 'custom' so the next replan's healing upsert
      // (plan-forecast-runtime.ts, task 004) leaves it alone, the same one-way trip presence_source
      // and share_source already take. Re-saving identical values is not a tweak and must not detach
      // it. **Use the series** sends `scheduleSource: "inherit"` explicitly to reattach; a stored
      // 'custom' row read back and resaved unchanged (an editor round-trip) carries the same value and
      // is a harmless passthrough, not a second way to detach. A one-off row (no recurrence_rule_id)
      // never has this column touched at all.
      const scheduleSourceRaw = optionalText(entity.scheduleSource);
      if (scheduleSourceRaw !== null && scheduleSourceRaw !== "inherit" && scheduleSourceRaw !== "custom")
        throw invalidChoice("scheduleSource", scheduleSourceRaw, ["inherit", "custom"], {
          label: "Commitment schedule source"
        });
      // Same absence-means-no-opinion rule as presence: a caller silent about the contact must not
      // clear one that was deliberately set. An explicit empty string clears it; anything else writes
      // it.
      const contactIdSent = entity.contactId !== undefined && entity.contactId !== null;
      const contactId = contactIdSent ? optionalText(entity.contactId) : (rows[0]?.contact_id ?? null);
      // Lateness and transport mode: the commitment editor's per-occurrence "Lateness matters"/"Travel
      // by" fields. Same absence-means-no-opinion rule:
      // a save silent about either must not reset it, so a save from a page that has never heard of
      // these fields (an import, a capture proposal) leaves them exactly as stored.
      const latenessMatters = optionalBoolean(entity.latenessMatters);
      // The pulse criteria and publish design note ("Private"): OR-inherited from the recurrence
      // rule, so this is a plain flag with no inherit/custom split — a save silent about it leaves the
      // stored value untouched, same as latenessMatters.
      const isPrivate = optionalBoolean(entity.private);
      const transportModeSent = entity.transportMode !== undefined;
      const transportMode = transportModeSent
        ? optionalTransportMode(entity.transportMode)
        : ((rows[0]?.transport_mode as "car" | "bike" | "walk" | null) ?? null);
      // Attendance (`CONTEXT.md`): same absence-means-no-opinion rule as presence. A remote commitment
      // may name a preferred place; an in-person one has `locationId` for that, so the preference is
      // cleared whenever the commitment is in person rather than left to go stale. An empty string
      // clears the preference; a save silent about it keeps what is stored.
      const attendanceRaw = optionalText(entity.attendance);
      if (attendanceRaw !== null && attendanceRaw !== "in_person" && attendanceRaw !== "remote")
        throw invalidChoice("attendance", attendanceRaw, ["in_person", "remote"], { label: "Commitment attendance" });
      const attendance = attendanceRaw ?? rows[0]?.attendance ?? "in_person";
      const preferredLocationSent = entity.preferredLocationId !== undefined && entity.preferredLocationId !== null;
      const preferredLocationId =
        attendance !== "remote"
          ? null
          : preferredLocationSent
            ? await optionalActiveLocationId(tx, userId, entity.preferredLocationId, "Preferred location")
            : (rows[0]?.preferred_location_id ?? null);
      const overlayChanged =
        !!rows[0] &&
        (values[0] !== rows[0].title ||
          starts.getTime() !== rows[0].starts_at.getTime() ||
          ends.getTime() !== rows[0].ends_at.getTime() ||
          optionalText(entity.location) !== rows[0].location ||
          locationId !== rows[0].location_id ||
          values[2] !== rows[0].setup_before_minutes ||
          values[3] !== rows[0].transition_after_minutes ||
          projectId !== rows[0].project_id ||
          (contactIdSent && contactId !== rows[0].contact_id) ||
          (latenessMatters !== null && latenessMatters !== rows[0].lateness_matters) ||
          (transportModeSent && transportMode !== rows[0].transport_mode));
      // `inherit` reattaches only when the payload changes nothing else: **Use the series** sends the
      // stored values unchanged. A caller that spreads a stored row (which carries its current
      // `scheduleSource`) into a save with a real edit must still detach, or the edit would be
      // reverted by the next replan — the same occurrence-edit race by another route.
      const scheduleSource = !rows[0]
        ? "inherit"
        : !rows[0].recurrence_rule_id
          ? rows[0].schedule_source
          : overlayChanged || scheduleSourceRaw === "custom"
            ? "custom"
            : scheduleSourceRaw === "inherit"
              ? "inherit"
              : rows[0].schedule_source;
      if (rows[0])
        await tx`UPDATE commitments SET title=${values[0]},starts_at=${starts},ends_at=${ends},status=${values[1]},location=${optionalText(entity.location)},location_id=${locationId},setup_before_minutes=${values[2]},transition_after_minutes=${values[3]},presence=COALESCE(${presence},presence),presence_source=COALESCE(${presenceSource},presence_source),prompt_policy=COALESCE(${promptPolicy},prompt_policy),origin=COALESCE(${origin},origin),disruption_source=COALESCE(${disruptionSource},disruption_source),disruption_open_ended=COALESCE(${disruptionOpenEnded},disruption_open_ended),landed_at=COALESCE(${landedAt},landed_at),project_id=${projectId},share_to_calendar=COALESCE(${shareToCalendar},share_to_calendar),share_source=COALESCE(${shareSource},share_source),schedule_source=${scheduleSource},contact_id=${contactId},lateness_matters=COALESCE(${latenessMatters},lateness_matters),transport_mode=${transportMode},attendance=${attendance},preferred_location_id=${preferredLocationId},private=COALESCE(${isPrivate},private),check_in_extra_minutes=CASE WHEN ${hasCheckInExtra}::boolean THEN ${checkInExtraMinutes}::integer ELSE check_in_extra_minutes END,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
      else
        await tx`INSERT INTO commitments (id,user_id,title,starts_at,ends_at,status,location,location_id,setup_before_minutes,transition_after_minutes,presence,prompt_policy,origin,disruption_source,disruption_open_ended,landed_at,project_id,routine_source,routine_preset_id,share_to_calendar,contact_id,lateness_matters,transport_mode,attendance,preferred_location_id,private,check_in_extra_minutes) VALUES (${id},${userId},${values[0]},${starts},${ends},${values[1]},${optionalText(entity.location)},${locationId},${values[2]},${values[3]},${presence ?? "blocking"},${promptPolicy ?? "normal"},${origin ?? "planned"},${disruptionSource},${disruptionOpenEnded ?? false},${landedAt},${projectId},${routine?.source ?? "inherit"},${routine?.presetId ?? null},${shareToCalendar ?? false},${contactId},${latenessMatters ?? true},${transportMode},${attendance},${preferredLocationId},${isPrivate ?? false},${checkInExtraMinutes})`;
      if (rows[0] && routine)
        await tx`UPDATE commitments SET routine_source=${routine.source},routine_preset_id=${routine.presetId},updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
      // What an extension told someone about this commitment settles when the owner changes its status.
      if (rows[0])
        for (const extension of entityExtensions())
          await extension.afterCommitmentSaved?.(tx, { id, status: String(values[1]) });
    } else if (command.entityType === "settings") {
      // Settings now saves from several pages, each sending only the fields it owns (Part A of the
      // settings restructure). A page's silence about a field is not an answer for it, so every field
      // reads its prior stored value when the payload omits it, and only a field the payload actually
      // names is re-validated and rewritten. This is a full-row read specifically so that fallback: no
      // COALESCE trick is needed, and cross-field rules (minimum <= desired, catalogue membership)
      // still validate against the merged result rather than against whichever half a page sent.
      const rows = await tx<
        (Row<typeof usersTable, "timezone" | "locale"> &
          Row<
            typeof userPreferencesTable,
            | "version"
            | "planning_horizon_end"
            | "asserted_conditions"
            | "default_usable_fraction"
            | "default_setup_buffer_minutes"
            | "default_transition_buffer_minutes"
            | "submission_buffer_minutes"
            | "submission_buffer_percent"
            | "energy_meanings"
            | "estimate_buckets_minutes"
            | "preferred_bedtime"
            | "preferred_wake_time"
            | "desired_sleep_minutes"
            | "minimum_sleep_minutes"
            | "max_awake_hours"
            | "bedtime_deviation_minutes"
            | "recovery_start_time"
            | "recovery_end_time"
            | "recovery_weekdays"
            | "last_woke_at"
            | "bedtime_routine_preset_id"
            | "wake_routine_preset_id"
            | "home_location_id"
            | "disruption_kind_labels"
            | "disruption_when_presets"
            | "disruption_duration_presets"
            | "disruption_retro_fallback_minutes"
            | "arrival_margin_minutes"
            | "deliverable_chat_model"
            | "import_extractor_model"
            | "calendar_share_enabled"
            | "share_primary_events"
            | "pulse_publish_enabled"
            | "estimate_calibration_enabled"
            | "setup_completed_at"
            | "time_bands"
            | "start_by_warning_minutes"
            | "session_break_minutes"
            | "default_transport_mode"
            | "leave_by_lead_minutes"
            | "pulse_unknown_to_off_minutes"
            | "pulse_further_prompts"
            | "pulse_unknown_hard_off_minutes"
            | "plan_code_pattern"
          >)[]
      >`SELECT p.version,u.timezone,u.locale,p.planning_horizon_end,p.asserted_conditions,
          p.default_usable_fraction,p.default_setup_buffer_minutes,
          p.default_transition_buffer_minutes,p.submission_buffer_minutes,p.submission_buffer_percent,
          p.energy_meanings,p.estimate_buckets_minutes,p.preferred_bedtime,p.preferred_wake_time,
          p.desired_sleep_minutes,p.minimum_sleep_minutes,p.max_awake_hours,p.bedtime_deviation_minutes,p.recovery_start_time,p.recovery_end_time,p.recovery_weekdays,p.last_woke_at,
          p.bedtime_routine_preset_id,p.wake_routine_preset_id,p.home_location_id,p.disruption_kind_labels,p.disruption_when_presets,
          p.disruption_duration_presets,p.disruption_retro_fallback_minutes,p.arrival_margin_minutes,
          p.deliverable_chat_model,p.import_extractor_model,p.calendar_share_enabled,p.share_primary_events,p.pulse_publish_enabled,p.estimate_calibration_enabled,p.setup_completed_at,
          p.time_bands,p.start_by_warning_minutes,p.session_break_minutes,p.default_transport_mode,p.leave_by_lead_minutes,
          p.pulse_unknown_to_off_minutes,p.pulse_further_prompts,p.pulse_unknown_hard_off_minutes,p.plan_code_pattern
        FROM user_preferences p JOIN users u ON u.id=p.user_id WHERE p.user_id=${userId} FOR NO KEY UPDATE OF p`;
      const existing = rows[0];
      verifyVersion(existing?.version);
      const has = (key: string) => Object.prototype.hasOwnProperty.call(entity, key);
      const timezone = has("timezone") ? requiredTimeZone(entity.timezone, "Timezone") : existing!.timezone;
      const locale = has("locale") ? requiredLocale(entity.locale, "Date format") : existing!.locale;
      // Checked here so a bad pattern fails before any write; stored by its own statement below.
      const planCodePattern = has("planCodePattern") ? planCodePatternValue(entity.planCodePattern) : undefined;
      await tx`UPDATE users SET timezone=${timezone},locale=${locale},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=${userId}`;
      const setupCompletedAt =
        has("setupCompletedAt") || has("setupCompleted")
          ? (optionalDate(entity.setupCompletedAt, "setupCompletedAt") ?? (entity.setupCompleted ? new Date() : null))
          : existing!.setup_completed_at;
      const planningHorizonEnd = has("planningHorizonEnd")
        ? requiredText(entity.planningHorizonEnd, "Planning horizon end")
        : existing!.planning_horizon_end;
      const desired = has("desiredSleepMinutes")
        ? positiveInt(entity.desiredSleepMinutes, "Desired sleep")
        : existing!.desired_sleep_minutes;
      const minimum = has("minimumSleepMinutes")
        ? positiveInt(entity.minimumSleepMinutes, "Minimum sleep")
        : existing!.minimum_sleep_minutes;
      if (minimum > desired)
        throw badValue(
          "Minimum sleep",
          minimum,
          `it cannot exceed desired sleep (${desired} minutes); lower minimumSleepMinutes or raise desiredSleepMinutes`
        );
      const maxAwake = has("maxAwakeHours")
        ? positiveInt(entity.maxAwakeHours, "Maximum awake hours")
        : existing!.max_awake_hours;
      if (maxAwake < 8 || maxAwake > 36) throw outOfRange("Maximum awake hours", maxAwake, 8, 36, "hours");
      const bedtimeDeviationMinutes = has("bedtimeDeviationMinutes")
        ? (() => {
            const minutes = nonNegativeInt(entity.bedtimeDeviationMinutes, "Bedtime deviation");
            if (minutes > 720) throw outOfRange("Bedtime deviation", minutes, 0, 720, "minutes");
            return minutes;
          })()
        : existing!.bedtime_deviation_minutes;
      // Protected recovery: both times or neither, quarter-hour, start before end.
      const recoveryClock = (value: unknown, label: string): string | null => {
        if (value === null || value === undefined || value === "") return null;
        if (typeof value !== "string" || !/^([01]\d|2[0-3]):(00|15|30|45)(:00)?$/.test(value))
          throw badValue(label, value, "it must be a quarter-hour time as HH:MM (minutes 00, 15, 30 or 45)", "22:15");
        return value.slice(0, 5);
      };
      const recoveryStartTime = has("recoveryStartTime")
        ? recoveryClock(entity.recoveryStartTime, "Recovery start")
        : (existing!.recovery_start_time?.slice(0, 5) ?? null);
      const recoveryEndTime = has("recoveryEndTime")
        ? recoveryClock(entity.recoveryEndTime, "Recovery end")
        : (existing!.recovery_end_time?.slice(0, 5) ?? null);
      if ((recoveryStartTime === null) !== (recoveryEndTime === null))
        throw new InvalidCommandError("Recovery time needs both a start and an end.");
      if (recoveryStartTime !== null && recoveryEndTime !== null && recoveryStartTime === recoveryEndTime)
        throw new InvalidCommandError(
          "Recovery time needs a different start and end; an end before the start runs overnight."
        );
      const recoveryWeekdays = has("recoveryWeekdays")
        ? (() => {
            const days = entity.recoveryWeekdays;
            if (
              !Array.isArray(days) ||
              days.length === 0 ||
              !days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
            )
              throw badValue(
                "Recovery weekdays",
                days,
                "it must be a non-empty list of day numbers 0 to 6",
                "[1,2,3,4,5]"
              );
            return [...new Set(days as number[])].sort((a, b) => a - b);
          })()
        : (existing!.recovery_weekdays as number[] | null);
      // no catalogue to validate `selected` against any more — the flat context catalogue is
      // retired, so a current context is whatever the caller says it is.
      const selected = has("assertedConditions")
        ? stringList(entity.assertedConditions)
        : stringList(existing!.asserted_conditions);
      let bedtimePresetId: string | null;
      if (has("bedtimeRoutinePresetId")) {
        const bedtimePresetRaw = optionalText(entity.bedtimeRoutinePresetId);
        bedtimePresetId = bedtimePresetRaw ? await stableUuid(`routine-preset:${userId}`, bedtimePresetRaw) : null;
        if (bedtimePresetId) {
          const ownedPreset = await tx<
            { id: string }[]
          >`SELECT id FROM routine_presets WHERE id=${bedtimePresetId} AND user_id=${userId}`;
          if (!ownedPreset[0]) throw notFound("routine", bedtimePresetRaw, "Bedtime routine");
        }
      } else {
        bedtimePresetId = existing!.bedtime_routine_preset_id;
      }
      let wakePresetId: string | null;
      if (has("wakeRoutinePresetId")) {
        const wakePresetRaw = optionalText(entity.wakeRoutinePresetId);
        wakePresetId = wakePresetRaw ? await stableUuid(`routine-preset:${userId}`, wakePresetRaw) : null;
        if (wakePresetId) {
          const ownedPreset = await tx<
            { id: string }[]
          >`SELECT id FROM routine_presets WHERE id=${wakePresetId} AND user_id=${userId}`;
          if (!ownedPreset[0]) throw notFound("routine", wakePresetRaw, "Wake routine");
        }
      } else {
        wakePresetId = existing!.wake_routine_preset_id;
      }
      const homeLocationId = has("homeLocationId")
        ? await optionalActiveLocationId(tx, userId, entity.homeLocationId, "Home location")
        : existing!.home_location_id;
      const lastWokeAt = has("lastWokeAt") ? optionalDate(entity.lastWokeAt, "lastWokeAt") : existing!.last_woke_at;
      // Same guard, and grace, as the sleep log's wake path below: a wake that has not happened yet
      // reads as still asleep, so every night would be planned off it until this field is edited again.
      if (has("lastWokeAt") && lastWokeAt && lastWokeAt.getTime() > Date.now() + 5 * 60_000)
        throw badValue(
          "lastWokeAt",
          entity.lastWokeAt,
          "it cannot be more than 5 minutes in the future; send the time the owner actually woke"
        );
      const preferredBedtime = has("preferredBedtime")
        ? requiredText(entity.preferredBedtime, "Preferred bedtime")
        : existing!.preferred_bedtime;
      const preferredWakeTime = has("preferredWakeTime")
        ? requiredText(entity.preferredWakeTime, "Preferred wake time")
        : existing!.preferred_wake_time;
      const defaultUsableFraction = has("defaultUsableFraction")
        ? fractionNumber(entity.defaultUsableFraction, "Default usable fraction")
        : Number(existing!.default_usable_fraction);
      const defaultSetupBufferMinutes = has("defaultSetupBufferMinutes")
        ? nonNegativeInt(entity.defaultSetupBufferMinutes, "Setup buffer")
        : existing!.default_setup_buffer_minutes;
      const defaultTransitionBufferMinutes = has("defaultTransitionBufferMinutes")
        ? nonNegativeInt(entity.defaultTransitionBufferMinutes, "Transition buffer")
        : existing!.default_transition_buffer_minutes;
      const submissionBufferMinutes = has("submissionBufferMinutes")
        ? nonNegativeInt(entity.submissionBufferMinutes, "Submission buffer")
        : existing!.submission_buffer_minutes;
      const submissionBufferPercent = has("submissionBufferPercent")
        ? fractionNumber(entity.submissionBufferPercent, "Submission percentage")
        : Number(existing!.submission_buffer_percent);
      const energyMeanings = has("energyMeanings") ? entity.energyMeanings : existing!.energy_meanings;
      const estimateBucketsMinutes = has("estimateBucketsMinutes")
        ? entity.estimateBucketsMinutes
        : existing!.estimate_buckets_minutes;
      const disruptionKindLabels = has("disruptionKindLabels")
        ? validatedDisruptionKindLabels(entity.disruptionKindLabels)
        : existing!.disruption_kind_labels;
      const disruptionWhenPresets = has("disruptionWhenPresets")
        ? validatedDisruptionWhenPresets(entity.disruptionWhenPresets)
        : existing!.disruption_when_presets;
      const disruptionDurationPresets = has("disruptionDurationPresets")
        ? validatedDisruptionDurationPresets(entity.disruptionDurationPresets)
        : existing!.disruption_duration_presets;
      const disruptionRetroFallbackMinutes = has("disruptionRetroFallbackMinutes")
        ? nonNegativeInt(entity.disruptionRetroFallbackMinutes, "Retro fallback minutes")
        : existing!.disruption_retro_fallback_minutes;
      if (disruptionRetroFallbackMinutes < 1 || disruptionRetroFallbackMinutes > 1440)
        throw outOfRange("Retro fallback minutes", disruptionRetroFallbackMinutes, 1, 1440, "minutes");
      const arrivalMarginMinutes = has("arrivalMarginMinutes")
        ? nonNegativeInt(entity.arrivalMarginMinutes, "Arrival margin")
        : existing!.arrival_margin_minutes;
      if (arrivalMarginMinutes > 60) throw outOfRange("Arrival margin", arrivalMarginMinutes, 0, 60, "minutes");
      const sessionBreakMinutes = has("sessionBreakMinutes")
        ? (() => {
            const minutes = nonNegativeInt(entity.sessionBreakMinutes, "Session break");
            if (minutes > 120) throw outOfRange("Session break", minutes, 0, 120, "minutes");
            return minutes;
          })()
        : existing!.session_break_minutes;
      const timeBands = has("timeBands")
        ? (() => {
            const bands =
              entity.timeBands && typeof entity.timeBands === "object"
                ? (entity.timeBands as Record<string, unknown>[])
                : [];
            if (!Array.isArray(bands)) throw new InvalidCommandError("Time bands must be an array.");
            const validated = bands.map((item, index) => {
              try {
                return timeBandSchema.parse(item);
              } catch {
                throw new InvalidCommandError(`Time band ${index + 1} is invalid.`);
              }
            });
            const ids = validated.map((b) => b.id);
            if (ids.length !== new Set(ids).size) throw new InvalidCommandError("Time band ids must be unique.");
            return tx.json(validated as never);
          })()
        : tx.json(existing!.time_bands as never);
      const startByWarningMinutes = has("startByWarningMinutes")
        ? (() => {
            const minutes = nonNegativeInt(entity.startByWarningMinutes, "Start-by warning");
            if (minutes > 240) throw outOfRange("Start-by warning", minutes, 0, 240, "minutes");
            return minutes;
          })()
        : existing!.start_by_warning_minutes;
      // Per-tool OpenAI model overrides (Settings · AI). Null means unset, which each consumer reads
      // as "use the built-in fallback" rather than as an answer this table gives.
      const deliverableChatModel = has("deliverableChatModel")
        ? optionalText(entity.deliverableChatModel)
        : existing!.deliverable_chat_model;
      const importExtractorModel = has("importExtractorModel")
        ? optionalText(entity.importExtractorModel)
        : existing!.import_extractor_model;
      const calendarShareEnabled = has("calendarShareEnabled")
        ? Boolean(entity.calendarShareEnabled)
        : existing!.calendar_share_enabled;
      const sharePrimaryEvents = has("sharePrimaryEvents")
        ? Boolean(entity.sharePrimaryEvents)
        : existing!.share_primary_events;
      const pulsePublishEnabled = has("pulsePublishEnabled")
        ? Boolean(entity.pulsePublishEnabled)
        : existing!.pulse_publish_enabled;
      const estimateCalibrationEnabled = has("estimateCalibrationEnabled")
        ? Boolean(entity.estimateCalibrationEnabled)
        : existing!.estimate_calibration_enabled;
      // The mode `resolveMode` falls to when a commitment and its place both name none
      // Same silence-means-no-opinion rule as
      // every other field here; an explicit empty string clears it.
      const defaultTransportMode = has("defaultTransportMode")
        ? optionalTransportMode(entity.defaultTransportMode)
        : existing!.default_transport_mode;
      // The lead reminder's offset before `leaveBy`. 0 is
      // legitimate: only the at-leave-by prompt is sent.
      const leaveByLeadMinutes = has("leaveByLeadMinutes")
        ? nonNegativeInt(entity.leaveByLeadMinutes, "Leave-by lead time")
        : existing!.leave_by_lead_minutes;
      if (leaveByLeadMinutes > 60) throw outOfRange("Leave-by lead time", leaveByLeadMinutes, 0, 60, "minutes");
      // The pulse lapse thresholds. Null (or a field left out
      // of a first save) is the default; an explicit null clears a stored value back to it.
      const pulseThreshold = (
        key: string,
        label: string,
        min: number,
        max: number,
        stored: number | null,
        unit = "minutes"
      ) => {
        if (!has(key)) return stored;
        const value = entity[key];
        if (value === null) return null;
        const whole = nonNegativeInt(value, label);
        if (whole < min || whole > max) throw outOfRange(label, whole, min, max, unit);
        return whole;
      };
      const pulseUnknownToOffMinutes = pulseThreshold(
        "pulseUnknownToOffMinutes",
        "Minutes unknown before a lapse",
        5,
        480,
        existing!.pulse_unknown_to_off_minutes
      );
      const pulseFurtherPrompts = pulseThreshold(
        "pulseFurtherPrompts",
        "Unanswered prompts before a lapse",
        0,
        10,
        existing!.pulse_further_prompts,
        "prompts"
      );
      const pulseUnknownHardOffMinutes = pulseThreshold(
        "pulseUnknownHardOffMinutes",
        "Minutes unknown before a lapse with no further prompt",
        5,
        720,
        existing!.pulse_unknown_hard_off_minutes
      );
      if (
        (pulseUnknownHardOffMinutes ?? DEFAULT_PULSE_THRESHOLDS.unknownHardOffMinutes) <
        (pulseUnknownToOffMinutes ?? DEFAULT_PULSE_THRESHOLDS.unknownToOffMinutes)
      )
        throw new InvalidCommandError(
          "The minutes unknown before a lapse with no further prompt cannot be shorter than the minutes before a lapse after a further prompt."
        );
      await tx`UPDATE user_preferences SET asserted_conditions=${tx.json(selected as never)},planning_horizon_end=${planningHorizonEnd},preferred_bedtime=${preferredBedtime},preferred_wake_time=${preferredWakeTime},desired_sleep_minutes=${desired},minimum_sleep_minutes=${minimum},max_awake_hours=${maxAwake},bedtime_deviation_minutes=${bedtimeDeviationMinutes},recovery_start_time=${recoveryStartTime},recovery_end_time=${recoveryEndTime},recovery_weekdays=${recoveryWeekdays === null ? null : tx.json(recoveryWeekdays as never)},last_woke_at=${lastWokeAt},bedtime_routine_preset_id=${bedtimePresetId},wake_routine_preset_id=${wakePresetId},home_location_id=${homeLocationId},default_usable_fraction=${defaultUsableFraction},default_setup_buffer_minutes=${defaultSetupBufferMinutes},default_transition_buffer_minutes=${defaultTransitionBufferMinutes},submission_buffer_minutes=${submissionBufferMinutes},submission_buffer_percent=${submissionBufferPercent},energy_meanings=${tx.json(energyMeanings as never)},estimate_buckets_minutes=${tx.json(estimateBucketsMinutes as never)},disruption_kind_labels=${tx.json(disruptionKindLabels as never)},disruption_when_presets=${tx.json(disruptionWhenPresets as never)},disruption_duration_presets=${tx.json(disruptionDurationPresets as never)},disruption_retro_fallback_minutes=${disruptionRetroFallbackMinutes},arrival_margin_minutes=${arrivalMarginMinutes},time_bands=${timeBands},start_by_warning_minutes=${startByWarningMinutes},session_break_minutes=${sessionBreakMinutes},deliverable_chat_model=${deliverableChatModel},import_extractor_model=${importExtractorModel},calendar_share_enabled=${calendarShareEnabled},share_primary_events=${sharePrimaryEvents},pulse_publish_enabled=${pulsePublishEnabled},estimate_calibration_enabled=${estimateCalibrationEnabled},default_transport_mode=${defaultTransportMode},leave_by_lead_minutes=${leaveByLeadMinutes},pulse_unknown_to_off_minutes=${pulseUnknownToOffMinutes},pulse_further_prompts=${pulseFurtherPrompts},pulse_unknown_hard_off_minutes=${pulseUnknownHardOffMinutes},current_horizon_end_at=${new Date(Date.now() + 7 * 24 * 60 * 60_000)},setup_completed_at=${setupCompletedAt},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE user_id=${userId}`;
      if (planCodePattern !== undefined)
        await tx`UPDATE user_preferences SET plan_code_pattern=${planCodePattern} WHERE user_id=${userId}`;
      // Ticking the shift default shares the primary source's imported shifts still ahead that follow it (not past or
      // hand-set ones). Unticking takes every imported shift off the family calendar, hand-set included,
      // and marks them 'inherit' so a later tick brings the upcoming ones back.
      if (sharePrimaryEvents && !existing!.share_primary_events)
        await tx`UPDATE commitments f SET share_to_calendar=true,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE f.user_id=${userId} AND f.share_source='inherit' AND NOT f.share_to_calendar AND f.starts_at>now() AND EXISTS (SELECT 1 FROM calendar_event_links l WHERE l.commitment_id=f.id AND l.provider=ANY(${primarySourceIds()}))`;
      else if (!sharePrimaryEvents && existing!.share_primary_events)
        await tx`UPDATE commitments f SET share_to_calendar=false,share_source='inherit',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE f.user_id=${userId} AND (f.share_to_calendar OR f.share_source<>'inherit') AND EXISTS (SELECT 1 FROM calendar_event_links l WHERE l.commitment_id=f.id AND l.provider=ANY(${primarySourceIds()}))`;
      if (entity.setupCompleted) {
        const initialAreas = [
          "Work and income",
          "Study",
          "Career development",
          "Health",
          "Home and administration",
          "Relationships",
          "Recreation and recovery"
        ];
        for (const [sortOrder, name] of initialAreas.entries())
          await tx`INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},${name},'active',${sortOrder}) ON CONFLICT (user_id,name) DO NOTHING`;
      }
    } else if (command.entityType === "condition_definition") {
      // Keyed by its own slug rather than a generated uuid, because every requirement, grant and
      // pathway refers to a context by that slug and none of them are foreign keys.
      const id = requiredText(entity.id, "Context id").trim().toLocaleLowerCase();
      storedId = id;
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))
        throw new InvalidCommandError("A context id may use only lowercase letters, numbers and single hyphens.");
      const rows = await tx<
        { version: number }[]
      >`SELECT version FROM condition_definitions WHERE user_id=${userId} AND id=${id} FOR UPDATE`;
      verifyVersion(rows[0]?.version);
      const name = requiredText(entity.name, "Context name");
      const kind = requiredText(entity.kind, "Context kind");
      const allowedContextKind: readonly string[] = ["location", "capability", "contact", "live"];
      if (!allowedContextKind.includes(kind))
        throw invalidChoice("kind", kind, allowedContextKind, { label: "Context kind" });
      const status = optionalText(entity.status) ?? "active";
      const allowedContextStatus: readonly string[] = ["active", "archived"];
      if (!allowedContextStatus.includes(status))
        throw invalidChoice("status", status, allowedContextStatus, { label: "Context status" });
      if (status === "archived") {
        await assertNotHomeLocation(tx, userId, id, rawId);
        await assertNotRequiredByOpenWork(tx, userId, id, rawId);
      }
      const portability = optionalText(entity.portability) ?? "fixed";
      const allowedContextPortability: readonly string[] = ["fixed", "portable"];
      if (!allowedContextPortability.includes(portability))
        throw invalidChoice("portability", portability, allowedContextPortability, { label: "Context portability" });
      const channels = stringList(entity.channels);
      if (channels.some((channel) => !["in_person", "sync_remote", "async"].includes(channel)))
        throw invalidChoice(
          "channels",
          channels.find((channel) => !["in_person", "sync_remote", "async"].includes(channel)),
          ["in_person", "sync_remote", "async"],
          { label: "Contact channel" }
        );
      const grants = stringList(entity.grants);
      const pathways = Array.isArray(entity.pathways)
        ? (entity.pathways as unknown[]).map((route) => stringList(route)).filter((route) => route.length)
        : [];
      const others = await tx<
        Row<typeof conditionDefinitionsTable, "id" | "kind" | "pathways">[]
      >`SELECT id,kind,pathways FROM condition_definitions WHERE user_id=${userId} AND id<>${id}`;
      const known = new Set([...others.map((row) => row.id), id]);
      for (const reference of [...grants, ...pathways.flat()])
        if (!known.has(reference))
          throw invalidChoice("grants/pathways", reference, [...known].sort(), {
            label: "Context reference",
            nextCall: {
              tool: "rhen_list",
              arguments: { entity: "condition-definitions", limit: 50 },
              note: "the owner's contexts"
            }
          });
      if (grants.length && kind !== "location")
        throw new InvalidCommandError("Only a location can grant other contexts.");
      if (pathways.length && kind !== "capability")
        throw new InvalidCommandError("Only a capability can be built from pathways.");
      // A composite that can reach itself would resolve forever. The matcher survives a cycle, but
      // storing one leaves a definition that can never be satisfied, so it is refused at the door.
      const graph = new Map<string, string[]>(
        others.map((row) => [row.id, (Array.isArray(row.pathways) ? (row.pathways as string[][]) : []).flat()])
      );
      graph.set(id, pathways.flat());
      const visiting = new Set<string>();
      const visited = new Set<string>();
      const reaches = (from: string): boolean => {
        if (visiting.has(from)) return true;
        if (visited.has(from)) return false;
        visiting.add(from);
        if ((graph.get(from) ?? []).some(reaches)) return true;
        visiting.delete(from);
        visited.add(from);
        return false;
      };
      if (reaches(id)) throw new InvalidCommandError("These pathways would make the capability depend on itself.");
      const travelMinutes =
        entity.travelMinutes === null || entity.travelMinutes === undefined
          ? null
          : positiveInt(entity.travelMinutes, "Travel minutes");
      const coordinate = (value: unknown, limit: number, label: string) => {
        if (value === null || value === undefined || value === "") return null;
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || Math.abs(parsed) > limit)
          throw badValue(label, value, `it must be a number between -${limit} and ${limit}`, String(limit / 2));
        return parsed;
      };
      const latitude = coordinate(entity.latitude, 90, "Latitude");
      const longitude = coordinate(entity.longitude, 180, "Longitude");
      if ((latitude === null) !== (longitude === null))
        throw new InvalidCommandError("A location needs both a latitude and a longitude, or neither.");
      // The address only ever describes the stored coordinates. Dropping it with them is what keeps
      // a place from showing a street it is no longer at.
      const address = latitude === null ? null : optionalText(entity.address);
      // Creating, because there is no stored row yet. The API refuses the same thing the editor
      // refuses, so a place can never enter the system without somewhere to actually be.
      const coordinatesProblem = locationCoordinatesProblem({ kind, latitude, longitude }, !rows[0]);
      if (coordinatesProblem) throw new InvalidCommandError(coordinatesProblem);
      const presetRaw = optionalText(entity.defaultRoutinePresetId);
      const presetId = presetRaw ? await stableUuid(`routine-preset:${userId}`, presetRaw) : null;
      if (presetId) {
        const owned = await tx<
          { id: string }[]
        >`SELECT id FROM routine_presets WHERE id=${presetId} AND user_id=${userId}`;
        if (!owned[0]) throw notFound("routine", presetRaw);
      }
      // A birth property: a place is created one-off or not, and no later edit converts it. The
      // update branch deliberately keeps the stored value so re-saving a definition never flips it.
      const oneOff = kind === "location" && entity.oneOff === true;
      // Live only: exactly one of recurrenceRuleId/commitmentId, and it must name a row this
      // user actually owns — otherwise a context could quietly point at (or leak the existence of)
      // someone else's row, or at nothing, and resolve as a hold nothing will ever lift.
      const recurrenceRuleIdRaw = optionalText(entity.recurrenceRuleId);
      const commitmentIdRaw = optionalText(entity.commitmentId);
      if (kind === "live") {
        if ((recurrenceRuleIdRaw ? 1 : 0) + (commitmentIdRaw ? 1 : 0) !== 1)
          throw new InvalidCommandError("A live context needs exactly one of recurrenceRuleId or commitmentId.");
        if (recurrenceRuleIdRaw) {
          const owned = await tx<
            { id: string }[]
          >`SELECT id FROM commitment_recurrence_rules WHERE id=${recurrenceRuleIdRaw} AND user_id=${userId}`;
          if (!owned[0]) throw notFound("recurring commitment", recurrenceRuleIdRaw);
        } else {
          const owned = await tx<
            { id: string }[]
          >`SELECT id FROM commitments WHERE id=${commitmentIdRaw} AND user_id=${userId}`;
          if (!owned[0]) throw notFound("commitment", commitmentIdRaw);
        }
      } else if (recurrenceRuleIdRaw || commitmentIdRaw) {
        throw new InvalidCommandError("recurrenceRuleId/commitmentId only apply to a live context.");
      }
      const recurrenceRuleId = kind === "live" ? (recurrenceRuleIdRaw ?? null) : null;
      const commitmentId = kind === "live" ? (commitmentIdRaw ?? null) : null;
      // Location only: the place's
      // own usual way there, which beats the user's default mode but loses to a commitment's own.
      // Absent means unset for every kind, same as `travelMinutes`.
      const usualTransportMode = kind === "location" ? optionalTransportMode(entity.usualTransportMode) : null;
      // Contact only: where a prefilled text or email goes. Kept as
      // typed so Settings shows what was entered; the link builders normalise it. Refused here as in
      // Settings, so a typo never becomes a text to nobody.
      const addressProblem = kind === "contact" ? contactAddressProblem(entity) : undefined;
      if (addressProblem) throw new InvalidCommandError(addressProblem);
      const phone = kind === "contact" ? optionalText(entity.phone) : null;
      const email = kind === "contact" ? optionalText(entity.email) : null;
      await tx`
          INSERT INTO condition_definitions (user_id,id,name,kind,status,portability,pathways,grants,channels,travel_minutes,latitude,longitude,address,setup_before_minutes,transition_after_minutes,default_routine_preset_id,one_off,recurrence_rule_id,commitment_id,usual_transport_mode,phone,email)
          VALUES (${userId},${id},${name},${kind},${status},${portability},${tx.json(pathways as never)},${tx.json(grants as never)},${tx.json(channels as never)},${travelMinutes},${latitude},${longitude},${address},${Number(entity.setupBeforeMinutes) || 0},${Number(entity.transitionAfterMinutes) || 0},${presetId},${oneOff},${recurrenceRuleId},${commitmentId},${usualTransportMode},${phone},${email})
          ON CONFLICT (user_id,id) DO UPDATE SET name=EXCLUDED.name,kind=EXCLUDED.kind,status=EXCLUDED.status,portability=EXCLUDED.portability,pathways=EXCLUDED.pathways,grants=EXCLUDED.grants,channels=EXCLUDED.channels,travel_minutes=EXCLUDED.travel_minutes,latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,address=EXCLUDED.address,setup_before_minutes=EXCLUDED.setup_before_minutes,transition_after_minutes=EXCLUDED.transition_after_minutes,default_routine_preset_id=EXCLUDED.default_routine_preset_id,one_off=condition_definitions.one_off,recurrence_rule_id=EXCLUDED.recurrence_rule_id,commitment_id=EXCLUDED.commitment_id,usual_transport_mode=EXCLUDED.usual_transport_mode,phone=EXCLUDED.phone,email=EXCLUDED.email,version=condition_definitions.version+1,updated_at=CURRENT_TIMESTAMP
        `;
    } else if (command.entityType === "current_availability") {
      // this used to also select and validate `assertedConditions` against `context_catalog`,
      // which is now gone — a genuine reader/writer dependency the 2026-09-05 review flagged, since it
      // meant a location-only assertion (the one-tap arrival write, `current_situation.locationId`)
      // still routed through this handler and could trip a catalogue check unrelated to the location
      // it was actually asserting. There is nothing left to validate `selected` against.
      const rows = await tx<
        Row<typeof userPreferencesTable, "version" | "current_energy" | "current_situation">[]
      >`SELECT version,current_energy,current_situation FROM user_preferences WHERE user_id=${userId} FOR UPDATE`;
      verifyVersion(rows[0]?.version);
      const selected = stringList(entity.assertedConditions);
      const energy = requiredText(entity.currentEnergy, "Current energy");
      const allowedCurrentEnergy: readonly string[] = ["high", "medium", "low", "recovery"];
      if (!allowedCurrentEnergy.includes(energy))
        throw invalidChoice("currentEnergy", energy, allowedCurrentEnergy, { label: "Current energy" });
      const previousSituation = parseCurrentSituation(rows[0]?.current_situation);
      const previousLocationId = previousSituation.locationId;
      // A deliberate untick-all is not accepted (the travel time model design note "Modes and travel
      // off"): `transportModes` must hold at least one mode, so a save naming the field explicitly
      // empty is refused rather than silently stored — a stored `[]` from before this rule still reads
      // as every mode (`parseCurrentSituation`'s own "never configured" default), it just can no longer
      // be written fresh.
      if (
        entity.currentSituation &&
        typeof entity.currentSituation === "object" &&
        "transportModes" in (entity.currentSituation as Record<string, unknown>) &&
        Array.isArray((entity.currentSituation as Record<string, unknown>).transportModes) &&
        ((entity.currentSituation as Record<string, unknown>).transportModes as unknown[]).length === 0
      )
        throw new InvalidCommandError(
          "currentSituation.transportModes is empty: send at least one of car, bike or walk (or leave the field out to keep every mode).",
          { validValues: { transportModes: ["car", "bike", "walk"] } }
        );
      await assertCurrentLocationIsSavedPlace(tx, userId, entity.currentSituation, previousLocationId);
      await checkPeopleStatements(tx, userId, entity.currentSituation);
      const ownerZone = await tx<{ timezone: string }[]>`SELECT timezone FROM users WHERE id=${userId}`;
      const placed = nextCurrentSituation(parseCurrentSituation(rows[0]?.current_situation), entity.currentSituation, {
        timeZone: ownerZone[0]?.timezone ?? "UTC"
      });
      // When energy was said: now if the value changed or the person
      // asserted it again (`energyAsserted`, from the energy chip), otherwise what was there. A write that
      // only moves the place resends energy unchanged and must not make it look newly said.
      const situation =
        rows[0]?.current_energy !== energy || entity.energyAsserted === true
          ? { ...placed, energySetAt: new Date().toISOString() }
          : placed;
      await tx`UPDATE user_preferences SET asserted_conditions=${tx.json(selected as never)},current_energy=${energy},current_situation=${tx.json(situation as never)},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE user_id=${userId}`;
      // A location assertion that actually moved is the one moment arrival can make preparation moot
      // — see routine-step-arrival.ts. Unrelated saves through this same command
      // (energy, carried capabilities) restate the same locationId and must not re-run this every time.
      if (situation.locationId && situation.locationId !== previousLocationId) {
        const arrivedAt = new Date();
        await skipMootRoutineSteps(tx, userId, situation.locationId, arrivedAt, { previousLocationId }, saveSnap);
        // Own trips (the travel time model design note, "Own trips (T2)"): recorded inside this same
        // transaction, before the one recordStateChange call below, never adding a call of its own.
        if (previousLocationId)
          await recordOwnTripOnArrival(tx, userId, {
            fromLocationId: previousLocationId,
            fromLocationSetAt: previousSituation.locationSetAt,
            toLocationId: situation.locationId,
            transportModes: situation.transportModes,
            arrivedAt,
            underwayFromLocationId: previousSituation.underway?.fromLocationId ?? null,
            underwayDepartedAt: previousSituation.underway?.departedAt ?? null,
            snap: saveSnap
          });
      }
    } else if (command.entityType === "routine_preset") {
      const id = await stableUuid(`routine-preset:${userId}`, rawId);
      storedId = id;
      const rows = await tx<
        { version: number }[]
      >`SELECT version FROM routine_presets WHERE id=${id} AND user_id=${userId} FOR UPDATE`;
      verifyVersion(rows[0]?.version);
      const name = requiredText(entity.name, "Routine preset name");
      const activityName = requiredText(entity.activityName ?? entity.name, "Activity name");
      const status = optionalText(entity.status) ?? "active";
      const allowedRoutinePresetStatus: readonly string[] = ["active", "archived"];
      if (!allowedRoutinePresetStatus.includes(status))
        throw invalidChoice("status", status, allowedRoutinePresetStatus, { label: "Routine preset status" });
      // See the wake routine design note: a preset resolved for a confirmed commitment with this set
      // can skip or truncate the day's wake routine instance rather than run alongside it.
      const replacesWakeRoutine = Boolean(entity.replacesWakeRoutine);
      const rawSteps: Record<string, unknown>[] = Array.isArray(entity.steps)
        ? (entity.steps as Record<string, unknown>[])
        : [];
      const stepPhase = (step: Record<string, unknown>) => (step.phase === "after" ? "after" : "before");
      const steps: Record<string, unknown>[] = rawSteps.map((step, index) => {
        const phase = stepPhase(step);
        if (Array.isArray(step.dependencyIds)) return { ...step, phase };
        const priorSamePhase = rawSteps
          .slice(0, index)
          .reverse()
          .find((candidate) => stepPhase(candidate) === phase);
        return {
          ...step,
          phase,
          dependencyIds: priorSamePhase ? [requiredText(priorSamePhase.id, "Routine step id")] : []
        };
      });
      if (!steps.length)
        throw new InvalidCommandError(
          'A routine needs at least one step: send "steps" as a non-empty list, each {"title", "phase", "minutes"}.'
        );
      validateRoutineEntityGraph(steps);
      const duplicate = await tx<
        { id: string }[]
      >`SELECT id FROM routine_presets WHERE user_id=${userId} AND lower(name)=lower(${name}) AND id<>${id} LIMIT 1`;
      if (duplicate[0])
        throw new InvalidCommandError(`A routine named “${name}” already exists. Open that routine instead.`);
      if (rows[0])
        await tx`UPDATE routine_presets SET name=${name},activity_name=${activityName},status=${status},replaces_wake_routine=${replacesWakeRoutine},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
      else
        await tx`INSERT INTO routine_presets(id,user_id,name,activity_name,status,replaces_wake_routine) VALUES(${id},${userId},${name},${activityName},${status},${replacesWakeRoutine})`;
      // Steps are upserted under their stable ids and only the ones this save drops are deleted:
      // `routine_steps.preset_step_id` is ON DELETE SET NULL, so deleting and re-inserting every step
      // would sever the link on every instantiated routine step across all commitments.
      const stepIds = new Map<string, string>();
      for (const step of steps) {
        const rawStepId = requiredText(step.id, "Routine step id");
        stepIds.set(rawStepId, await stableUuid(`routine-preset-step:${id}`, rawStepId));
      }
      const keptStepIds = [...stepIds.values()];
      await tx`DELETE FROM routine_preset_steps WHERE preset_id=${id} AND id NOT IN ${tx(keptStepIds)}`;
      await tx`DELETE FROM routine_preset_step_dependencies WHERE step_id IN ${tx(keptStepIds)}`;
      // (preset_id, sequence) is unique and not deferrable, so park the kept rows out of the way before
      // a reorder writes their new positions.
      await tx`UPDATE routine_preset_steps SET sequence=-sequence-1 WHERE preset_id=${id}`;
      for (const [sequence, step] of steps.entries()) {
        const stepId = stepIds.get(requiredText(step.id, "Routine step id"))!;
        const timing = requiredText(step.timingRule, "Timing rule");
        const contexts = stringList(step.contexts);
        const linked = await linkedActionWindow(tx, userId, step.actionWindowId);
        const actionWindowId = linked?.id ?? null;
        const cadenceActionId = await linkedCadenceAction(tx, userId, step.cadenceActionId);
        if (actionWindowId && cadenceActionId)
          throw new InvalidCommandError("A routine step cannot link both a recurring occurrence and a cadence action.");
        const duration = linked ? linked.minutes : positiveInt(step.durationMinutes, "Duration");
        const timingFields = routineStepTimingFields(step as Record<string, unknown>);
        await tx`INSERT INTO routine_preset_steps(id,preset_id,title,duration_minutes,sequence,timing_rule,max_lead_minutes,energy,phase,contexts,action_window_id,cadence_action_id,wait_after_minutes,must_start_by_minutes,preferred_bands) VALUES(${stepId},${id},${requiredText(step.title, "Routine step")},${duration},${sequence},${timing},${timing === "flexible" ? positiveInt(step.maxLeadMinutes, "Maximum lead time") : null},${requiredText(step.energy, "Energy")},${stepPhase(step)},${tx.json(contexts as never)},${actionWindowId},${cadenceActionId},${timingFields.waitAfterMinutes},${timingFields.mustStartByMinutes},${tx.json(timingFields.preferredBands as never)}) ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title,duration_minutes=EXCLUDED.duration_minutes,sequence=EXCLUDED.sequence,timing_rule=EXCLUDED.timing_rule,max_lead_minutes=EXCLUDED.max_lead_minutes,energy=EXCLUDED.energy,phase=EXCLUDED.phase,contexts=EXCLUDED.contexts,action_window_id=EXCLUDED.action_window_id,cadence_action_id=EXCLUDED.cadence_action_id,wait_after_minutes=EXCLUDED.wait_after_minutes,must_start_by_minutes=EXCLUDED.must_start_by_minutes,preferred_bands=EXCLUDED.preferred_bands`;
      }
      for (const step of steps) {
        const stepId = stepIds.get(requiredText(step.id, "Routine step id"))!;
        for (const dependencyRaw of stringList(step.dependencyIds)) {
          const dependencyId = stepIds.get(dependencyRaw);
          if (!dependencyId) throw new InvalidCommandError("A routine connection refers to a missing step.");
          await tx`INSERT INTO routine_preset_step_dependencies(step_id,depends_on_step_id) VALUES(${stepId},${dependencyId})`;
        }
      }
    } else if (command.entityType === "deliverable") {
      // Saved as one aggregate. The contract and the plan are approved together, so a partially
      // applied save would misrepresent what the user actually agreed to.
      const id = await stableUuid(`deliverable:${userId}`, rawId);
      storedId = id;
      const projectId = await stableUuid(`project:${userId}`, requiredText(entity.projectId, "Project"));
      const ownedProject = await tx<
        { id: string }[]
      >`SELECT p.id FROM projects p JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id WHERE p.id=${projectId} AND a.user_id=${userId}`;
      if (!ownedProject[0]) throw notFound("project", entity.projectId);
      const rows = await tx<
        { version: number }[]
      >`SELECT d.version FROM deliverables d JOIN projects p ON p.id=d.project_id JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id WHERE d.id=${id} AND a.user_id=${userId} FOR NO KEY UPDATE OF d`;
      verifyVersion(rows[0]?.version);
      await watchDeliverableWrite(saveSnap, id, entity);
      await writeDeliverableAggregate(tx, userId, id, projectId, entity);
      // In the same transaction as the write above, so a step saved done while a session is still
      // tracking it moves that session onto the next step (or ends it) atomically with the save that
      // completed it — not as a second command with its own race window.
      await rollDeliverableSessionForward(tx, id, new Date());
    } else if (command.entityType === "routine_step") {
      const id = await stableUuid(`routine:${userId}`, rawId);
      storedId = id;
      const commitmentId = await stableUuid(`commitment:${userId}`, requiredText(entity.commitmentId, "Commitment"));
      const owned = await tx<
        Row<typeof commitmentsTable, "starts_at" | "routine_source">[]
      >`SELECT starts_at,routine_source FROM commitments WHERE id=${commitmentId} AND user_id=${userId}`;
      if (!owned[0]) throw notFound("commitment", entity.commitmentId);
      const rows = await tx<
        Row<
          typeof routineStepsTable,
          | "version"
          | "commitment_id"
          | "title"
          | "duration_minutes"
          | "sequence"
          | "timing_rule"
          | "max_lead_minutes"
          | "energy"
          | "phase"
          | "contexts"
          | "action_window_id"
          | "cadence_action_id"
          | "scheduled_start_at"
          | "scheduled_end_at"
          | "wait_after_minutes"
          | "must_start_by_minutes"
          | "preferred_bands"
        >[]
      >`SELECT version,commitment_id,title,duration_minutes,sequence,timing_rule,max_lead_minutes,energy,phase,contexts,action_window_id,cadence_action_id,scheduled_start_at,scheduled_end_at,wait_after_minutes,must_start_by_minutes,preferred_bands FROM routine_steps WHERE id=${id} AND user_id=${userId} FOR UPDATE`;
      verifyVersion(rows[0]?.version);
      // A step's schedule is the engine's placer to set (`engine/core/src/scheduling/routine-placement.ts`,
      // mirrored onto the row by the persist's routine sync) — for an inherited or preset commitment it
      // is derived from the commitment's own timeline, not hand-settable. Only reject an actual attempt
      // to move it: `save` always merges the stored record — its last-placed schedule included — back
      // over itself before applying an unrelated `--set`, so a round-tripped, unchanged value must keep
      // saving cleanly. 'custom' commitments are unaffected.
      if (owned[0].routine_source === "inherit" || owned[0].routine_source === "preset") {
        const requestedStart = optionalDate(entity.scheduledStartAt, "scheduledStartAt");
        const requestedEnd = optionalDate(entity.scheduledEndAt, "scheduledEndAt");
        const storedStart = rows[0]?.scheduled_start_at ?? null;
        const storedEnd = rows[0]?.scheduled_end_at ?? null;
        const changed =
          (requestedStart !== null && requestedStart.getTime() !== (storedStart?.getTime() ?? NaN)) ||
          (requestedEnd !== null && requestedEnd.getTime() !== (storedEnd?.getTime() ?? NaN));
        if (changed)
          throw new InvalidCommandError(
            "This step's time is derived from the commitment — edit the preset or detach the routine to custom."
          );
      }
      const priorDependencies = rows[0]
        ? await tx<
            Row<typeof routineStepDependenciesTable, "depends_on_step_id">[]
          >`SELECT depends_on_step_id FROM routine_step_dependencies WHERE step_id=${id}`
        : [];
      const title = requiredText(entity.title, "Routine step");
      const energy = requiredText(entity.energy, "Energy");
      const status = optionalText(entity.status) ?? "pending";
      const timing = requiredText(entity.timingRule, "Timing rule");
      const lead = timing === "flexible" ? positiveInt(entity.maxLeadMinutes, "Maximum lead time") : null;
      const linked = await linkedActionWindow(tx, userId, entity.actionWindowId);
      const actionWindowId = linked?.id ?? null;
      const cadenceActionId = await linkedCadenceAction(tx, userId, entity.cadenceActionId);
      if (actionWindowId && cadenceActionId)
        throw new InvalidCommandError("A routine step cannot link both a recurring occurrence and a cadence action.");
      const duration = linked ? linked.minutes : positiveInt(entity.durationMinutes, "Duration");
      const sequence = nonNegativeInt(entity.sequence, "Sequence");
      const contexts = stringList(entity.contexts);
      const phase = entity.phase === "after" ? "after" : "before";
      const timingFields = routineStepTimingFields(entity as Record<string, unknown>);
      if (rows[0])
        await tx`UPDATE routine_steps SET commitment_id=${commitmentId},title=${title},duration_minutes=${duration},sequence=${sequence},timing_rule=${timing},max_lead_minutes=${lead},energy=${energy},phase=${phase},contexts=${tx.json(contexts as never)},action_window_id=${actionWindowId},cadence_action_id=${cadenceActionId},status=${status},wait_after_minutes=${timingFields.waitAfterMinutes},must_start_by_minutes=${timingFields.mustStartByMinutes},preferred_bands=${tx.json(timingFields.preferredBands as never)},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
      else
        // One routine, one table: `anchor_type`/`anchor_id` are always `'commitment'`/this
        // commitment's own id on this path — hand-editing a step is a commitment-only affordance, the
        // sleep-anchored template is entirely engine/preset-derived and never written here.
        await tx`INSERT INTO routine_steps (id,user_id,commitment_id,anchor_type,anchor_id,title,duration_minutes,sequence,timing_rule,max_lead_minutes,energy,phase,contexts,action_window_id,cadence_action_id,status,wait_after_minutes,must_start_by_minutes,preferred_bands) VALUES (${id},${userId},${commitmentId},'commitment',${commitmentId},${title},${duration},${sequence},${timing},${lead},${energy},${phase},${tx.json(contexts as never)},${actionWindowId},${cadenceActionId},${status},${timingFields.waitAfterMinutes},${timingFields.mustStartByMinutes},${tx.json(timingFields.preferredBands as never)})`;
      await tx`DELETE FROM routine_step_dependencies WHERE step_id=${id}`;
      let dependencies = stringList(entity.dependencyIds);
      if (!Array.isArray(entity.dependencyIds) && sequence > 0) {
        const prior = await tx<
          { id: string }[]
        >`SELECT id FROM routine_steps WHERE commitment_id=${commitmentId} AND phase=${phase} AND sequence<${sequence} ORDER BY sequence DESC LIMIT 1`;
        dependencies = prior[0] ? [prior[0].id] : [];
      }
      const resolvedDependencyIds: string[] = [];
      for (const rawDependency of dependencies) {
        const dependencyId = await stableUuid(`routine:${userId}`, rawDependency);
        const dependency = await tx<
          Row<typeof routineStepsTable, "id" | "phase">[]
        >`SELECT id,phase FROM routine_steps WHERE id=${dependencyId} AND commitment_id=${commitmentId}`;
        if (!dependency[0])
          throw badValue(
            "Routine dependency",
            dependencyId,
            'it must be another step of the same commitment; list them with rhen_list {"entity":"routine-steps","commitment":"<commitment id>"}'
          );
        if (dependencyId === id)
          throw badValue("Routine dependency", dependencyId, "a step cannot depend on itself; name a different step");
        if (dependency[0].phase !== phase)
          throw new InvalidCommandError("A routine step cannot connect across before/after the commitment.");
        resolvedDependencyIds.push(dependencyId);
        await tx`INSERT INTO routine_step_dependencies(step_id,depends_on_step_id) VALUES(${id},${dependencyId}) ON CONFLICT DO NOTHING`;
      }
      // A hand-shaped routine belongs to the user, so a real tweak — adding a step, or changing any
      // field of one — detaches the commitment from its inherited routine by flipping its source to
      // 'custom'. A save that only moves status (marking a step done or cancelled, or reopening it)
      // records progress against the same routine and must not detach.
      const before = rows[0];
      const sameList = (left: readonly string[], right: readonly string[]) => {
        const sortedLeft = [...left].sort();
        const sortedRight = [...right].sort();
        return (
          sortedLeft.length === sortedRight.length && sortedLeft.every((item, index) => item === sortedRight[index])
        );
      };
      const statusOnlyChange =
        before !== undefined &&
        before.commitment_id === commitmentId &&
        before.title === title &&
        before.duration_minutes === duration &&
        before.sequence === sequence &&
        before.timing_rule === timing &&
        before.max_lead_minutes === lead &&
        before.energy === energy &&
        before.phase === phase &&
        before.action_window_id === actionWindowId &&
        before.cadence_action_id === cadenceActionId &&
        before.wait_after_minutes === timingFields.waitAfterMinutes &&
        before.must_start_by_minutes === timingFields.mustStartByMinutes &&
        sameList(
          Array.isArray(before.contexts)
            ? before.contexts.filter((item): item is string => typeof item === "string")
            : [],
          contexts
        ) &&
        sameList(
          Array.isArray(before.preferred_bands)
            ? before.preferred_bands.filter((item): item is string => typeof item === "string")
            : [],
          timingFields.preferredBands
        ) &&
        sameList(
          priorDependencies.map((row) => row.depends_on_step_id),
          resolvedDependencyIds
        );
      if (!statusOnlyChange) {
        await tx`UPDATE commitments SET routine_source='custom',updated_at=CURRENT_TIMESTAMP WHERE id=${commitmentId} AND user_id=${userId} AND routine_source<>'custom'`;
        if (before && before.commitment_id !== commitmentId)
          await tx`UPDATE commitments SET routine_source='custom',updated_at=CURRENT_TIMESTAMP WHERE id=${before.commitment_id} AND user_id=${userId} AND routine_source<>'custom'`;
      }
      // `scheduleRoutineSteps` used to throw this same message when the commitment's step graph (after
      // this save's own dependency writes) could not be topologically ordered; placement moved to the
      // engine, but the cycle refusal is still this save's to make, checked inline against the
      // commitment's current graph.
      const graphSteps = await tx<
        { id: string }[]
      >`SELECT id FROM routine_steps WHERE commitment_id=${commitmentId} AND user_id=${userId}`;
      const graphEdges = await tx<
        Row<typeof routineStepDependenciesTable, "step_id" | "depends_on_step_id">[]
      >`SELECT dependency.step_id,dependency.depends_on_step_id FROM routine_step_dependencies dependency JOIN routine_steps step ON step.id=dependency.step_id WHERE step.commitment_id=${commitmentId} AND step.user_id=${userId}`;
      const graph = new Map(
        graphSteps.map((step) => [
          step.id,
          graphEdges.filter((edge) => edge.step_id === step.id).map((edge) => edge.depends_on_step_id)
        ])
      );
      if (hasCycle(graph)) throw new InvalidCommandError("Routine connections cannot form a cycle.");
      // Ticked off by hand rather than timed: the occurrence it stands in for is done just the same.
      if (optionalText(entity.status) === "completed")
        await completeStepActionOccurrence(tx, userId, id, new Date(), saveSnap);
    } else if (command.entityType === "sleep_plan") {
      const id = await stableUuid(`sleep:${userId}`, rawId);
      storedId = id;
      const rows = await tx<
        { version: number }[]
      >`SELECT version FROM sleep_plans WHERE id=${id} AND user_id=${userId} FOR UPDATE`;
      if (!rows[0]) throw notFound("sleep plan", rawId);
      verifyVersion(rows[0].version);
      const has = (key: string) => Object.prototype.hasOwnProperty.call(entity, key);
      // The sleep placement design note "sleep_plan entity command": four shapes share this one
      // command. Times alone (or times plus a stay-up answer) is the existing override path. A bare
      // `stayUpAnswerMinutes` (always 0 here, checked below) declines the offer without moving the
      // night. A bare `placementChoice` records the deviation choice without moving the night either.
      if (!has("plannedStartAt") && !has("plannedWakeAt")) {
        if (has("placementChoice")) {
          const choice = entity.placementChoice;
          if (choice !== "early" && choice !== "near")
            throw invalidChoice("placementChoice", choice, ["early", "near"], { label: "Placement choice" });
          await tx`UPDATE sleep_plans SET placement_choice=${choice},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
        } else if (has("stayUpAnswerMinutes")) {
          const minutes = entity.stayUpAnswerMinutes;
          if (minutes !== 0)
            throw invalidChoice("stayUpAnswerMinutes", minutes, ["0"], {
              label: "Stay-up answer (declining the offer)"
            });
          await tx`UPDATE sleep_plans SET stay_up_answer_minutes=0,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
        } else {
          throw new InvalidCommandError(
            "A sleep plan update needs at least one of plannedStartAt and plannedWakeAt (both), placementChoice (early or near) or stayUpAnswerMinutes (0); none was sent.",
            { validValues: { placementChoice: ["early", "near"], stayUpAnswerMinutes: ["0"] } }
          );
        }
      } else {
        const starts = requiredDate(entity.plannedStartAt, "Sleep start");
        const wakes = requiredDate(entity.plannedWakeAt, "Wake time");
        const prefs = await tx<
          Row<typeof userPreferencesTable, "minimum_sleep_minutes" | "max_awake_hours" | "last_woke_at">[]
        >`SELECT minimum_sleep_minutes,max_awake_hours,last_woke_at FROM user_preferences WHERE user_id=${userId}`;
        const duration = Math.round((wakes.getTime() - starts.getTime()) / 60000);
        if (duration < (prefs[0]?.minimum_sleep_minutes ?? 360))
          throw badValue(
            "Sleep block",
            `${duration} minutes`,
            `it is shorter than the configured minimum of ${prefs[0]?.minimum_sleep_minutes ?? 360} minutes; send a later plannedWakeAt or an earlier plannedStartAt`
          );
        if (
          prefs[0]?.last_woke_at &&
          starts.getTime() - prefs[0].last_woke_at.getTime() > prefs[0].max_awake_hours * 3600000
        )
          throw new InvalidCommandError("This override exceeds the maximum awake-hours rule.");
        // Accepting the stay-up offer sends the new times (bedtime moved to `plannedStart + N`, wake
        // unchanged) plus the chosen `N`, so both the override and the answer land in one write.
        // Restricted to the offer's own literal choice set here — not only by the DB check on
        // `stay_up_answer_minutes` (0,30,60,90) — so an out-of-set value (45, say) fails as a clean
        // `InvalidCommandError` instead of surfacing as a raw constraint-violation error from Postgres.
        // Matching it against the offer's own surviving choices is still out of scope here
        //
        if (has("stayUpAnswerMinutes")) {
          const minutes = stayUpAnswerMinutesLiteral(entity.stayUpAnswerMinutes);
          await tx`UPDATE sleep_plans SET planned_start_at=${starts},planned_wake_at=${wakes},allowed_minutes=${duration},sleep_deficit_minutes=GREATEST(0,desired_minutes-${duration}),input_version='override',stay_up_answer_minutes=${minutes},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
        } else {
          await tx`UPDATE sleep_plans SET planned_start_at=${starts},planned_wake_at=${wakes},allowed_minutes=${duration},sleep_deficit_minutes=GREATEST(0,desired_minutes-${duration}),input_version='override',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
        }
      }
    } else if (command.entityType === "sleep_log_entry") {
      // Covers both a hand-logged night (input_version='manual', created here) and a correction to a
      // night that was actually tracked live via Start/Stop on Now (input_version NULL/'override',
      // created by activity-commands.ts). Before this, only the manual rows were editable at all, so a
      // mistaken Start/Stop night — the common case — could never be fixed.
      const id = await stableUuid(`sleep-log:${userId}`, rawId);
      storedId = id;
      const rows = await tx<
        Row<typeof sleepPlansTable, "version" | "status" | "input_version">[]
      >`SELECT version,status,input_version FROM sleep_plans WHERE id=${id} AND user_id=${userId} FOR UPDATE`;
      verifyVersion(rows[0]?.version);
      // The last wake the log gave before this write (as text, so the comparison below is exact): a stored
      // last_woke_at that differs from it was recorded directly (Settings, or an agent) and is not the log's.
      const loggedBefore = await loggedWakeBefore(tx, userId);
      let wroteWakeAt: Date | null = null;
      if (entity.remove === true) {
        if (!rows[0]) throw notFound("logged sleep", rawId);
        // "Did not sleep" on Now already handles abandoning a live night; planned/cancelled rows are
        // not evidence of anything that happened and have nothing here to delete.
        if (rows[0].status !== "completed")
          throw wrongState({ kind: "logged sleep", id: rawId, state: rows[0].status, allowed: ["completed"] });
        // Sleep sessions are the one exception to sessions being immutable planning evidence (see
        // portal/app/history/page.tsx) — accepted because a wrong sleep record actively degrades
        // future planning, feeding completedSleepMinutesEndingAt/deriveSleepPlans in
        // engine/core/src/engine.ts.
        await syncSleepSession(tx, userId, id, { remove: true });
        await tx`DELETE FROM sleep_plans WHERE id=${id} AND user_id=${userId}`;
      } else if (rows[0]) {
        const { status, input_version: inputVersion } = rows[0];
        if (status === "planned" || status === "cancelled")
          throw wrongState({
            kind: "logged sleep",
            id: rawId,
            state: status,
            needs: "a sleep that is under way or completed"
          });
        const sleepAt = requiredDate(entity.sleepAt, "Sleep time");
        if (status === "sleeping") {
          if (entity.wakeAt !== undefined)
            throw new InvalidCommandError("Recording a wake is done by finishing the sleep session.");
          // A start after the wake that later finishes this night would store actual_start_at after
          // actual_wake_at, the corrupted shape; one before the last recorded
          // wake would overlap a night that already ended.
          if (sleepAt.getTime() > Date.now() + 5 * 60_000)
            throw new InvalidCommandError("A sleep that is under way cannot start in the future.");
          const [previous] = await tx<
            { wake: Date | null }[]
          >`SELECT MAX(actual_wake_at) AS wake FROM sleep_plans WHERE user_id=${userId} AND status='completed' AND id<>${id}`;
          if (previous?.wake && sleepAt < previous.wake)
            throw new InvalidCommandError("A sleep cannot start before your last recorded wake.");
          await tx`UPDATE sleep_plans SET actual_start_at=${sleepAt},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
          await syncSleepSession(tx, userId, id, { startedAt: sleepAt });
        } else {
          // status === "completed"
          const wakeAt = requiredDate(entity.wakeAt, "Wake time");
          if (wakeAt <= sleepAt)
            throw badValue("Wake time", entity.wakeAt, `it must be after the sleep time (${String(entity.sleepAt)})`);
          // A sleep that has not happened yet would push last_woke_at into the future, and the planner
          // then reads the user as still asleep and re-issues a bedtime that waiting can never clear.
          // The grace absorbs rounding in the minute-resolution picker and small clock skew.
          if (wakeAt.getTime() > Date.now() + 5 * 60_000)
            throw new InvalidCommandError("A sleep cannot be logged with a wake time in the future.");
          await refuseOverlappingNight(tx, userId, id, sleepAt, wakeAt);
          const duration = Math.round((wakeAt.getTime() - sleepAt.getTime()) / 60000);
          if (inputVersion === "manual")
            await tx`UPDATE sleep_plans SET planned_start_at=${sleepAt},planned_wake_at=${wakeAt},allowed_minutes=${duration},sleep_deficit_minutes=GREATEST(0,desired_minutes-${duration}),actual_start_at=${sleepAt},actual_wake_at=${wakeAt},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
          // A tracked plan's planned_start_at/planned_wake_at stay untouched here: they are evidence
          // of what the engine actually scheduled, not of what happened, so only the actual times and
          // their derived minutes move.
          else
            await tx`UPDATE sleep_plans SET allowed_minutes=${duration},sleep_deficit_minutes=GREATEST(0,desired_minutes-${duration}),actual_start_at=${sleepAt},actual_wake_at=${wakeAt},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
          await syncSleepSession(tx, userId, id, { startedAt: sleepAt, endedAt: wakeAt });
          wroteWakeAt = wakeAt;
        }
      } else {
        // Create: a hand-logged night with no live session behind it.
        const sleepAt = requiredDate(entity.sleepAt, "Sleep time");
        const wakeAt = requiredDate(entity.wakeAt, "Wake time");
        if (wakeAt <= sleepAt)
          throw badValue("Wake time", entity.wakeAt, `it must be after the sleep time (${String(entity.sleepAt)})`);
        if (wakeAt.getTime() > Date.now() + 5 * 60_000)
          throw new InvalidCommandError("A sleep cannot be logged with a wake time in the future.");
        await refuseOverlappingNight(tx, userId, id, sleepAt, wakeAt);
        await insertLoggedNight(tx, userId, id, sleepAt, wakeAt);
        wroteWakeAt = wakeAt;
      }
      // A logged or corrected wake is a wake: the last asserted location is re-asserted as of it, but
      // only forward, so back-dating an older sleep never regresses a newer assertion.
      if (wroteWakeAt) await reassertLocationOnWake(tx, userId, wroteWakeAt);
      await syncLastWokeAt(tx, userId, loggedBefore);
    } else if (command.entityType === "span") {
      // A labelled block of days for the History calendar. Calendar-only:
      // nothing here touches planning, so there is no recalculation, only the version check and the write.
      const id = await stableUuid(`span:${userId}`, rawId);
      storedId = id;
      const rows = await tx<
        { version: number }[]
      >`SELECT version FROM spans WHERE id=${id} AND user_id=${userId} FOR UPDATE`;
      verifyVersion(rows[0]?.version);
      if (entity.remove === true) {
        const removal = spanRemoveEntitySchema.safeParse(entity);
        if (!removal.success) throw new InvalidCommandError("A span is removed by id alone.");
        if (!rows[0]) throw notFound("span", rawId);
        await tx`DELETE FROM spans WHERE id=${id} AND user_id=${userId}`;
      } else {
        const parsed = spanEntitySchema.safeParse(entity);
        if (!parsed.success) throw new InvalidCommandError(parsed.error.issues[0]?.message ?? "The span is invalid.");
        const { title, startDate, endDate, window, projectId: rawProjectId } = parsed.data;
        let projectId: string | null = null;
        if (rawProjectId) {
          projectId = await stableUuid(`project:${userId}`, rawProjectId);
          const owned = await tx<
            { id: string }[]
          >`SELECT p.id FROM projects p JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id WHERE p.id=${projectId} AND a.user_id=${userId}`;
          if (!owned[0]) throw notFound("project", rawProjectId, "The linked project");
        }
        const windowJson = window ? tx.json(window as never) : null;
        if (rows[0])
          await tx`UPDATE spans SET title=${title},start_date=${startDate}::date,end_date=${endDate}::date,"window"=${windowJson},project_id=${projectId},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=${id} AND user_id=${userId}`;
        else
          await tx`INSERT INTO spans (id,user_id,title,start_date,end_date,"window",project_id) VALUES (${id},${userId},${title},${startDate}::date,${endDate}::date,${windowJson},${projectId})`;
      }
    } else if (command.entityType === "capture_review") {
      const id = await stableUuid(`capture-proposal:${userId}`, rawId);
      storedId = id;
      const rows = await tx<
        (Row<typeof capturesTable, "version" | "source_id" | "proposal_type" | "questions"> &
          Row<typeof sourcesTable, "source_type">)[]
      >`SELECT p.version,p.source_id,s.source_type,p.proposal_type,p.questions FROM captures p JOIN sources s ON s.id=p.source_id WHERE p.id=${id} AND p.user_id=${userId} AND p.status='pending' FOR UPDATE OF p`;
      if (!rows[0])
        throw wrongState({
          kind: "proposal",
          id: rawId,
          state: "already resolved or gone",
          needs: "a proposal that is still awaiting review",
          nextCall: { tool: "rhen_inbox", arguments: {}, note: "shows what is still awaiting review" }
        });
      // A proposal type an extension owns (an email change, say) confirms through the extension's own branches,
      // which apply the answered open questions; the generic draft below is for every other proposal.
      const owner = proposalOwner(rows[0].proposal_type);
      if (requestAgent() !== null) {
        // Confirming some captures tells another person the decision, which is the hard floor. The route table
        // cannot see a capture's source, so the refusal is here.
        const refusal = agentCaptureRefusal(rows[0].source_type, "confirm");
        if (refusal) throw new ForbiddenCommandError(refusal);
        // The route chose the scope (write:email-review or write:inbox) from what the body says this is, so the
        // body must say what the stored proposal is.
        const mismatch = agentProposalTypeRefusal(
          rows[0].proposal_type,
          optionalText(entity.proposalType) ?? undefined
        );
        if (mismatch)
          throw mismatch.forbidden
            ? new ForbiddenCommandError(mismatch.message)
            : new InvalidCommandError(mismatch.message);
      }
      // An agent's confirm keeps the rows it creates and changes, so it can be undone afterwards (write-snapshot.ts).
      // Mail-derived text still never reaches `write_rows` (`noBefore` below); the snapshot holds row images, as the
      // live tables do. The person's own confirm (null here) is not snapshotted.
      const snap = confirmSnap;
      await snap?.before("captures", [id]);
      verifyVersion(rows[0].version);
      const proposalType = owner ? rows[0].proposal_type : requiredText(entity.proposalType, "Proposal type");
      let draft = entity.draft && typeof entity.draft === "object" ? (entity.draft as Record<string, unknown>) : {};
      // Any other proposal's open questions (the shared shape, design: inbox-rooms): each must be
      // answered, and an answer fills its field in the draft before the draft is validated and applied.
      // Filing it as Someday or Reference plans nothing, so a placement question is moot and does not block.
      let answeredQuestions: OpenQuestion[] = [];
      if (!owner && proposalType !== "someday" && proposalType !== "reference") {
        const answered = applyProposalAnswers(rows[0].questions, entity.answers, draft);
        draft = answered.draft;
        answeredQuestions = answered.questions;
      }
      const targetId = id;
      // "Maybe": a commitment confirmed as tentative. Only a commitment has that state.
      const tentative = entity.commitmentStatus === "tentative";
      if (entity.commitmentStatus !== undefined && entity.commitmentStatus !== "confirmed" && !tentative)
        throw new InvalidCommandError("A commitment can only be confirmed or tentative.");
      if (tentative && proposalType !== "fixed_commitment")
        throw new InvalidCommandError("Only a commitment can be confirmed as tentative.");
      if (owner?.confirmProposal) {
        const stored = await tx<
          (Row<typeof capturesTable, "proposed_fields"> & { proposed_fields: Record<string, unknown> })[]
        >`SELECT proposed_fields FROM captures WHERE id=${id}`;
        const answers: Record<string, string> = {};
        if (entity.answers && typeof entity.answers === "object")
          for (const [key, value] of Object.entries(entity.answers as Record<string, unknown>))
            if (typeof value === "string") answers[key] = value;
        const outcome = await owner.confirmProposal({
          tx,
          userId,
          proposalId: id,
          sourceId: rows[0].source_id,
          sourceType: rows[0].source_type,
          fields: stored[0]?.proposed_fields ?? {},
          answers,
          snap
        });
        proposalEvidence = outcome.evidence;
      }
      if (proposalType === "outcome") {
        const areaId = await stableUuid(`area:${userId}`, requiredText(draft.areaId, "Area"));
        const owned = await tx<{ id: string }[]>`SELECT id FROM areas WHERE id=${areaId} AND user_id=${userId}`;
        if (!owned[0]) throw notFound("area", draft.areaId);
        snap?.inserted("outcomes", [targetId]);
        await tx`INSERT INTO outcomes (id,area_id,title,definition_of_done,value,status,deadline_at) VALUES (${targetId},${areaId},${requiredText(draft.title, "Outcome title")},${requiredText(draft.definitionOfDone, "Definition of done")},${scoreInt(draft.value, "Outcome value")},'active',${optionalDate(draft.externalDeadlineAt, "externalDeadlineAt")})`;
      }
      if (proposalType === "project") {
        const outcomeId = await stableUuid(`outcome:${userId}`, requiredText(draft.outcomeId, "Outcome"));
        const owned = await tx<
          { id: string }[]
        >`SELECT o.id FROM outcomes o JOIN areas a ON a.id=o.area_id WHERE o.id=${outcomeId} AND a.user_id=${userId}`;
        if (!owned[0]) throw notFound("outcome", draft.outcomeId);
        const internal = optionalDate(draft.internalDeadlineAt, "internalDeadlineAt");
        const external = optionalDate(draft.externalDeadlineAt, "externalDeadlineAt");
        if (internal && external && internal > external)
          throw badValue(
            "Internal deadline",
            draft.internalDeadlineAt,
            `it cannot be after the external deadline (${String(draft.externalDeadlineAt)}); send an earlier internalDeadlineAt`
          );
        snap?.inserted("projects", [targetId]);
        await tx`INSERT INTO projects (id,outcome_id,title,status,uncertainty,consequence,internal_deadline_at,external_deadline_at) VALUES (${targetId},${outcomeId},${requiredText(draft.title, "Project title")},'active','some',3,${internal},${external})`;
      }
      if (proposalType === "action") {
        const projectId = await stableUuid(`project:${userId}`, requiredText(draft.projectId, "Project"));
        const owned = await tx<
          { id: string }[]
        >`SELECT p.id FROM projects p JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id WHERE p.id=${projectId} AND a.user_id=${userId}`;
        if (!owned[0]) throw notFound("project", draft.projectId);
        const expected = nonNegativeInt(draft.expectedMinutes, "Expected minutes");
        const pessimistic = nonNegativeInt(draft.pessimisticMinutes, "Pessimistic minutes");
        if (expected < 1 || pessimistic < expected)
          throw new InvalidCommandError("Action effort estimates are invalid.");
        snap?.inserted("actions", [targetId]);
        await tx`INSERT INTO actions (id,project_id,title,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes,splittable,setup_minutes,importance,consequence,deadline_at) VALUES (${targetId},${projectId},${requiredText(draft.title, "Action title")},'active',${Math.max(1, Math.round(expected * 0.75))},${expected},${pessimistic},${expected},${requiredText(draft.energy, "Energy")},${Math.min(15, expected)},${Math.min(60, expected)},true,0,3,3,${optionalDate(draft.externalDeadlineAt, "externalDeadlineAt")})`;
        // no more default flat "home" tag — `action_contexts` is retired, and a fabricated
        // single-context requirement was never a meaningful constraint anyway. The action starts
        // unconstrained, same as any other action created with no requirement pathway.
      }
      if (proposalType === "fixed_commitment") {
        const starts = requiredDate(draft.startsAt, "Commitment start");
        const ends = requiredDate(draft.endsAt, "Commitment end");
        if (starts >= ends) throw new InvalidCommandError("The commitment must end after it starts.");
        const locationId = await optionalActiveLocationId(tx, userId, draft.locationId, "Commitment location");
        snap?.inserted("commitments", [targetId]);
        await tx`INSERT INTO commitments (id,user_id,title,starts_at,ends_at,status,location,location_id,setup_before_minutes,transition_after_minutes) VALUES (${targetId},${userId},${requiredText(draft.title, "Commitment title")},${starts},${ends},${tentative ? "tentative" : "confirmed"},${optionalText(draft.location)},${locationId},0,0)`;
      }
      if (proposalType === "deliverable") {
        const projectId = await stableUuid(`project:${userId}`, requiredText(draft.projectId, "Project"));
        const owned = await tx<
          { id: string }[]
        >`SELECT p.id FROM projects p JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id WHERE p.id=${projectId} AND a.user_id=${userId}`;
        if (!owned[0]) throw notFound("project", draft.projectId);
        const internal = optionalDate(draft.internalDeadlineAt, "internalDeadlineAt");
        const external = optionalDate(draft.externalDeadlineAt, "externalDeadlineAt");
        if (internal && external && internal > external)
          throw badValue(
            "Internal deadline",
            draft.internalDeadlineAt,
            `it cannot be after the external deadline (${String(draft.externalDeadlineAt)}); send an earlier internalDeadlineAt`
          );
        // No steps, criteria or blockers: the aggregate writes the one deliverable row.
        await snap?.before("deliverables", [targetId]);
        await writeDeliverableAggregate(tx, userId, targetId, projectId, {
          title: requiredText(draft.title, "Deliverable title"),
          status: "needs_breakdown",
          externalDeadlineAt: draft.externalDeadlineAt,
          internalDeadlineAt: draft.internalDeadlineAt,
          uncertainty: "some",
          importance: 3,
          consequence: 3,
          details: optionalText(draft.notes)
        });
        // `role` records where the confirmed deliverable's founding source came from — the proposal's
        // own `source_type` (e.g. `manual_capture`), not hardcoded, since a deliverable proposal can be
        // confirmed from any capture source.
        await snap?.before("deliverable_sources", [[targetId, rows[0].source_id]]);
        await tx`INSERT INTO deliverable_sources(deliverable_id,source_id,role) VALUES(${targetId},${rows[0].source_id},${rows[0].source_type}) ON CONFLICT DO NOTHING`;
      }
      if (!owner)
        await tx`UPDATE captures SET status='confirmed',proposal_type=${proposalType},proposed_fields=${tx.json(draft as never)},questions=${tx.json(answeredQuestions as never)},reviewed_at=CURRENT_TIMESTAMP,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
      // A proposal that arrived from another person tells them the decision in the same transaction
      // (design note §8): confirmed is "accepted", confirmed as tentative is "tentative" ("the owner said
      // maybe"), and the created record's id is what the schedule hints later follow. Any other
      // outcome is a fault in this write, not a nice-to-have, so it fails the command rather than
      // leaving their page saying "Sent to the owner" forever.
      {
        const source = await tx<
          Row<typeof sourcesTable, "source_type" | "external_id">[]
        >`SELECT source_type, external_id FROM sources WHERE id = (SELECT source_id FROM captures WHERE id = ${id})`;
        if (source[0])
          for (const extension of entityExtensions())
            await extension.afterCaptureConfirmed?.(tx, {
              sourceType: source[0].source_type,
              externalId: source[0].external_id,
              tentative,
              proposalType,
              targetId
            });
      }
      await snap?.save();
    } else if (command.entityType === "deliverable_contract_review") {
      const proposalId = rawId;
      const proposals = await tx<
        (Row<typeof capturesTable, "version" | "matched_entity_id" | "proposed_fields"> & {
          // `matched_entity_type='deliverable'` below guarantees the id; narrowed from `jsonb`, since a requirement proposal is stored as an object.
          matched_entity_id: string;
          proposed_fields: Record<string, unknown>;
        })[]
      >`
          SELECT version,matched_entity_id,proposed_fields FROM captures
          WHERE id=${proposalId} AND user_id=${userId} AND proposal_type='deliverable_criterion' AND matched_entity_type='deliverable' AND status='pending' FOR UPDATE`;
      if (!proposals[0])
        throw wrongState({
          kind: "requirement proposal",
          id: proposalId,
          state: "already resolved or gone",
          needs: "a proposal that is still awaiting review",
          nextCall: { tool: "rhen_inbox", arguments: {}, note: "shows what is still awaiting review" }
        });
      verifyVersion(proposals[0].version);
      const deliverableId = proposals[0].matched_entity_id;
      const owned = await tx<
        { id: string }[]
      >`SELECT d.id FROM deliverables d JOIN projects p ON p.id=d.project_id JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id WHERE d.id=${deliverableId} AND a.user_id=${userId} FOR NO KEY UPDATE OF d`;
      if (!owned[0]) throw notFound("deliverable", null, "The deliverable this proposal is about");
      await watchContractReviewWrite(saveSnap, proposalId, deliverableId);
      const decision = requiredText(entity.decision, "Review decision");
      if (decision !== "confirm" && decision !== "ignore")
        throw new InvalidCommandError("Review decision must confirm or ignore the proposal.");
      if (decision === "ignore")
        await tx`UPDATE captures SET status='ignored',reviewed_at=CURRENT_TIMESTAMP,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=${proposalId}`;
      else {
        const criterion =
          entity.criterion && typeof entity.criterion === "object"
            ? (entity.criterion as Record<string, unknown>)
            : proposals[0].proposed_fields;
        const key = requiredText(criterion.key, "Criterion key");
        const title = requiredText(criterion.title, "Criterion title");
        const verification = optionalText(criterion.verificationMethod);
        if (verification && !VERIFICATION_METHODS.includes(verification))
          throw invalidChoice("verificationMethod", verification, VERIFICATION_METHODS, {
            label: "Criterion verification method"
          });
        const duplicate = await tx<
          { id: string }[]
        >`SELECT id FROM deliverable_criteria WHERE deliverable_id=${deliverableId} AND key=${key}`;
        if (duplicate[0])
          throw new InvalidCommandError(
            "A completion criterion already uses this key. Edit the proposal key before accepting it."
          );
        const order = await tx<
          { next: number }[]
        >`SELECT COALESCE(MAX(sort_order),-1)+1 AS next FROM deliverable_criteria WHERE deliverable_id=${deliverableId}`;
        await tx`INSERT INTO deliverable_criteria(id,deliverable_id,key,title,required,interpretation,source_document,source_location,expected_evidence,verification_method,state,notes,sort_order) VALUES(${proposalId},${deliverableId},${key},${title},${criterion.required !== false},${optionalText(criterion.interpretation)},${optionalText(criterion.sourceDocument)},${optionalText(criterion.sourceLocation)},${optionalText(criterion.expectedEvidence)},${verification},'unsatisfied',${optionalText(criterion.notes)},${order[0]?.next ?? 0})`;
        await tx`UPDATE captures SET status='confirmed',proposed_fields=${tx.json(criterion as never)},reviewed_at=CURRENT_TIMESTAMP,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=${proposalId}`;
        // The accepted fact changed the contract. Historical version numbers remain, but the current
        // contract and plan require explicit re-approval before the engine may recommend this work.
        await tx`UPDATE deliverables SET contract_approved_at=NULL,plan_approved_at=NULL,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=${deliverableId}`;
      }
    } else if (command.entityType === "planning_focus") {
      const kind = requiredText(entity.kind, "Focus period") as "weekly" | "monthly";
      if (kind !== "weekly" && kind !== "monthly")
        throw invalidChoice("kind", kind, ["weekly", "monthly"], { label: "Focus period" });
      const periodStart = requiredText(entity.periodStart, "Period start").slice(0, 10);
      const periodEnd = requiredText(entity.periodEnd, "Period end").slice(0, 10);
      if (periodEnd < periodStart)
        throw badValue("Period end", periodEnd, `it cannot be before the period start (${periodStart})`);
      const projectIds = stringList(entity.projectIds);
      const owned =
        projectIds.length && projectIds.every(isUuid)
          ? await tx<
              { id: string }[]
            >`SELECT p.id FROM projects p JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id WHERE a.user_id=${userId} AND p.id IN ${tx(projectIds)}`
          : [];
      if (owned.length !== projectIds.length) throw notFound("project", null, "A project in projectIds");
      // `reviewedOn` left out keeps the stored date; null clears it.
      const reviewedOnGiven = Object.prototype.hasOwnProperty.call(entity, "reviewedOn");
      const reviewedOnValue =
        reviewedOnGiven && entity.reviewedOn ? requiredText(entity.reviewedOn, "Reviewed on").slice(0, 10) : null;
      const rows = await tx<
        Row<typeof planningFocusPeriodsTable, "id" | "version" | "reviewed_on">[]
      >`SELECT id, version, reviewed_on FROM planning_focus_periods WHERE user_id=${userId} AND kind=${kind} AND period_start=${periodStart} FOR UPDATE`;
      verifyVersion(rows[0]?.version);
      let periodId: string;
      if (rows[0]) {
        periodId = rows[0].id;
        await tx`UPDATE planning_focus_periods SET period_end=${periodEnd},${reviewedOnGiven ? tx`reviewed_on=${reviewedOnValue},` : tx``}version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=${periodId}`;
      } else {
        const created = await tx<
          { id: string }[]
        >`INSERT INTO planning_focus_periods (user_id,kind,period_start,period_end,reviewed_on) VALUES (${userId},${kind},${periodStart},${periodEnd},${reviewedOnValue}) RETURNING id`;
        periodId = created[0]!.id;
      }
      // The same transaction replaces the period's projects, so a failed save leaves the old set.
      await tx`DELETE FROM planning_focus_projects WHERE focus_period_id=${periodId}`;
      if (projectIds.length)
        await tx`INSERT INTO planning_focus_projects ${tx(projectIds.map((projectId) => ({ focus_period_id: periodId, project_id: projectId })))}`;
    } else if (command.entityType === "capture") {
      const id = await stableUuid(`capture-proposal:${userId}`, rawId);
      storedId = id;
      const rows = await tx<
        Row<typeof capturesTable, "version" | "source_id" | "status" | "proposal_type" | "proposed_fields">[]
      >`SELECT version,source_id,status,proposal_type,proposed_fields FROM captures WHERE id=${id} AND user_id=${userId} FOR UPDATE`;
      verifyVersion(rows[0]?.version);
      const newStatus = requiredText(entity.status, "Proposal status");
      // Dropping a Someday or Reference item is on the hard floor (`inbox-act kept drop`), but on the wire it is the
      // same capture save as ignoring a pending one, so the route cannot tell them apart: the stored row can. An
      // agent may send a kept item back to review, and nothing else. A proposal the owner confirmed is replayed with
      // the agent still set; that is the owner's own drop, so it applies.
      if (
        requestAgent() !== null &&
        changeLogConfirmedBy() !== "owner" &&
        rows[0]?.status === "confirmed" &&
        (rows[0].proposal_type === "someday" || rows[0].proposal_type === "reference") &&
        newStatus !== "pending"
      )
        throw new ForbiddenCommandError(hardFloorReason({ tool: "inbox-act", room: "kept", action: "drop" }) as string);
      // Only a Someday or Reference item goes back to review ("Review again" on the Inbox). Any other
      // confirmed proposal already created its record under the proposal's id, so confirming it again
      // would collide with that record rather than make a second one. A restore has its own refusal below.
      if (
        entity.restore !== true &&
        rows[0]?.status === "confirmed" &&
        newStatus === "pending" &&
        rows[0].proposal_type !== "someday" &&
        rows[0].proposal_type !== "reference"
      )
        throw new InvalidCommandError("Only a Someday or Reference item can go back to review.");
      if (entity.restore === true) {
        // "Restore" on a proposal the Inbox lists as replaced: a superseded row, and nothing else, goes back
        // to pending. A confirmed or ignored one is a decision, and a pending one has nothing to restore.
        // Its stored fields are kept as they are; the client's copy is not trusted to rewrite them.
        if (newStatus !== "pending" || rows[0]?.status !== "superseded")
          throw new InvalidCommandError("Only a replaced proposal can be restored.");
        await tx`UPDATE captures SET status='pending',reviewed_at=NULL,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=${id} AND user_id=${userId} AND status='superseded'`;
      } else if (rows[0]) {
        const source = await tx<
          Row<typeof sourcesTable, "source_type" | "external_id">[]
        >`SELECT source_type, external_id FROM sources WHERE id = ${rows[0].source_id}`;
        // Ignoring a capture tells its sender it was declined (below), which touches another person:
        // the hard floor, as confirming one is in the capture_review path. The person's confirm of an agent's
        // proposal to ignore it replays under the agent's name and is the person's decision.
        if (requestAgent() !== null && changeLogConfirmedBy() !== "owner" && newStatus === "ignored") {
          const refusal = agentCaptureRefusal(source[0]?.source_type, "decline");
          if (refusal) throw new ForbiddenCommandError(refusal);
        }
        await tx`UPDATE captures SET status=${newStatus},proposal_type=${requiredText(entity.proposalType, "Proposal type")},proposed_fields=${tx.json((entity.proposedFields ?? {}) as never)},reviewed_at=${optionalDate(entity.reviewedAt, "reviewedAt")},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
        // Ignoring a proposal that came from someone is the decision they are waiting on: "declined". Confirming
        // is written by the capture_review path above, with the created record's id; an edit that leaves
        // the proposal pending is no decision at all and writes nothing.
        if (newStatus === "ignored") {
          // An extension reads the stored proposal, not the command, so only what its own matcher said can act.
          if (source[0])
            for (const extension of entityExtensions())
              await extension.afterCaptureIgnored?.(tx, {
                userId,
                sourceType: source[0].source_type,
                externalId: source[0].external_id,
                proposedFields: rows[0].proposed_fields,
                wasPending: rows[0].status === "pending",
                snap: saveSnap
              });
        }
      } else {
        const sourceId = await stableUuid(`capture-source:${userId}`, rawId);
        const created = optionalDate(entity.createdAt, "createdAt") ?? new Date();
        await tx`INSERT INTO sources (id,user_id,source_type,external_id,captured_text,occurred_at,created_at) VALUES (${sourceId},${userId},${optionalText(entity.sourceType) ?? "manual_capture"},${rawId},${requiredText(entity.text, "Capture text")},${created},${created})`;
        await tx`INSERT INTO captures (id,user_id,source_id,proposal_type,status,proposed_fields,questions) VALUES (${id},${userId},${sourceId},${optionalText(entity.proposalType) ?? "unclassified"},${newStatus},${tx.json((entity.proposedFields ?? { text: entity.text }) as never)},${tx.json(captureQuestions(entity.questions) as never)})`;
      }
    } else {
      const localDate = requiredLocalDate(entity.localDate, "Local date");
      const rows = await tx<
        Row<typeof dailyPlansTable, "version" | "recovery_skipped" | "horizon_override_at">[]
      >`SELECT version, recovery_skipped, horizon_override_at FROM daily_plans WHERE user_id=${userId} AND local_date=${localDate} FOR UPDATE`;
      // A skip for an overnight window's start date can name a row the client never loaded (the newest
      // row is today's), so it flips only the flag: no version check, and the row's wins stay as they are.
      const skipOnly = entity.recoverySkippedOnly === true && typeof entity.recoverySkipped === "boolean";
      // Skipping the version check is only safe for a save that writes nothing but the flag.
      if (skipOnly) {
        const extra = Object.keys(entity).filter(
          (key) => key !== "localDate" && key !== "recoverySkipped" && key !== "recoverySkippedOnly"
        );
        if (extra.length)
          throw new InvalidCommandError(
            `A recovery skip saves only the skip flag, so it cannot also send ${extra.join(", ")}.`
          );
      } else verifyVersion(rows[0]?.version);
      const desired = stringList(entity.desiredActionIds);
      if (desired.length > 3)
        throw new InvalidCommandError(
          `desiredActionIds names ${desired.length} actions but at most three are allowed: send the three most important.`
        );
      // Each deferred item keeps its reason, and the first mention of an action wins; the list order is stored.
      const deferred: { actionId: string; reason: string }[] = [];
      if (Array.isArray(entity.deferredItems))
        for (const item of entity.deferredItems as unknown[]) {
          const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
          const actionId = typeof record.actionId === "string" ? record.actionId.trim() : "";
          if (!actionId) throw new InvalidCommandError("A deferred item needs an action.");
          if (!deferred.some((existing) => existing.actionId === actionId))
            deferred.push({ actionId, reason: typeof record.reason === "string" ? record.reason : "" });
        }
      // Every named action must be one of this user's, as a focus period's projects must be.
      const named = [...new Set([...desired, ...deferred.map((item) => item.actionId)])];
      const ownedActions =
        named.length && named.every(isUuid)
          ? await tx<
              { id: string }[]
            >`SELECT x.id FROM actions x JOIN projects p ON p.id=x.project_id JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id WHERE a.user_id=${userId} AND x.id IN ${tx(named)}`
          : [];
      if (ownedActions.length !== named.length)
        throw notFound("action", null, "An action named in desiredActionIds or deferredItems");
      // Only a save that names an override writes one. An entity that omits it keeps the row's own, so a
      // recovery toggle or a desired-wins edit can neither clear it nor re-home one the read carried over
      // from another day's row; only the horizon extension (`BoundaryPanel`) supplies it.
      const suppliedOverride =
        entity.horizonOverrideAt === undefined
          ? undefined
          : optionalDate(entity.horizonOverrideAt, "horizonOverrideAt");
      // An override belongs to the planning day it was made in, so it may not run past that day's next
      // wake (`dailyHorizonEnd` ignores one that does): "+3 hours" at 05:00 with a 07:00 wake keeps
      // 07:00, not 08:00. This is the only writer of `horizon_override_at`, so every path is held to it.
      let horizonOverride = suppliedOverride === undefined ? (rows[0]?.horizon_override_at ?? null) : suppliedOverride;
      if (suppliedOverride) {
        const days = await tx<
          (Row<typeof usersTable, "timezone"> &
            LeftJoined<Row<typeof userPreferencesTable, "preferred_wake_time" | "planning_horizon_end">>)[]
        >`SELECT u.timezone, p.preferred_wake_time, p.planning_horizon_end FROM users u LEFT JOIN user_preferences p ON p.user_id=u.id WHERE u.id=${userId}`;
        // The newest override still ahead, which is what the engine's active planning day follows: a
        // night extended past midnight is still that night, so its wake is this morning's.
        const now = new Date();
        const held = await tx<
          (Row<typeof dailyPlansTable, "local_date"> & {
            // `horizon_override_at > ${now}` below guarantees the timestamp.
            horizon_override_at: Date;
          })[]
        >`SELECT local_date, horizon_override_at FROM daily_plans WHERE user_id=${userId} AND horizon_override_at > ${now} ORDER BY local_date DESC LIMIT 1`;
        if (days[0])
          horizonOverride = clampHorizonOverride(
            suppliedOverride,
            now,
            {
              timezone: days[0].timezone,
              preferredWakeTime: days[0].preferred_wake_time,
              planningHorizonEnd: days[0].planning_horizon_end ?? "22:00"
            },
            held[0]
              ? {
                  localDate: localDateString(held[0].local_date),
                  horizonOverrideAt: held[0].horizon_override_at.toISOString()
                }
              : null
          );
      }
      // An entity that omits the flag keeps the stored value, so the horizon-extension save does not clear a skip.
      const recoverySkipped =
        typeof entity.recoverySkipped === "boolean" ? entity.recoverySkipped : (rows[0]?.recovery_skipped ?? false);
      let planId: string;
      if (rows[0]) {
        const updated = await tx<
          { id: string }[]
        >`UPDATE daily_plans SET horizon_override_at=${horizonOverride},recovery_skipped=${recoverySkipped},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE user_id=${userId} AND local_date=${localDate} RETURNING id`;
        planId = updated[0]!.id;
      } else {
        const created = await tx<
          { id: string }[]
        >`INSERT INTO daily_plans (user_id,local_date,horizon_override_at,recovery_skipped) VALUES (${userId},${localDate},${horizonOverride},${recoverySkipped}) RETURNING id`;
        planId = created[0]!.id;
      }
      if (!skipOnly) await tx`DELETE FROM daily_plan_desired_actions WHERE daily_plan_id=${planId}`;
      if (!skipOnly) await tx`DELETE FROM daily_plan_deferred_actions WHERE daily_plan_id=${planId}`;
      if (!skipOnly && desired.length)
        await tx`INSERT INTO daily_plan_desired_actions ${tx(desired.map((actionId, position) => ({ daily_plan_id: planId, action_id: actionId, position })))}`;
      if (!skipOnly && deferred.length)
        await tx`INSERT INTO daily_plan_deferred_actions ${tx(deferred.map((item, position) => ({ daily_plan_id: planId, action_id: item.actionId, reason: item.reason, position })))}`;
      if (suppliedOverride)
        await tx`UPDATE user_preferences SET current_horizon_end_at=${horizonOverride},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE user_id=${userId}`;
    }
    await saveSnap?.save();
    // A span never changes planning, so it records no plan input change.
    if (command.entityType !== "span")
      await recordStateChange(tx, userId, {
        entityType: command.entityType,
        entityId: storedId ?? rawId,
        operation: "save",
        evidence: {
          ...(command.entityType === "current_availability"
            ? {
                currentEnergy: entity.currentEnergy,
                assertedConditions: stringList(entity.assertedConditions)
              }
            : command.entityType === "settings" && Object.prototype.hasOwnProperty.call(entity, "lastWokeAt")
              ? // The wake is a state fact the pulse counts as contact; other settings edits are not.
                { wake: true }
              : (proposalEvidence ?? {})),
          ...(created ? { created: true, createdVersion: 1 } : {})
        },
        // Captures and their reviews can carry mail-derived text, and `write_rows` is not purged, so an
        // agent's write of one never keeps a before-image. The other entity kinds are not yet supplied
        // with one, so they are recorded as `beforeMissing`.
        ...(command.entityType === "capture" || command.entityType === "capture_review" || proposalEvidence
          ? { noBefore: true }
          : {}),
        commandId: command.commandId,
        at: new Date()
      });
  });
  return await readStateAfterCommit(sql);
}

/**
 * The recurrence window a routine step says it stands in for, resolved and proved to be this user's.
 *
 * The linked step is the same work as the occurrence, so it takes the action's own estimate: a second
 * duration typed into the routine would drift from it and quietly plan the same minutes twice over.
 * Shared by both kinds of step — a preset's and a commitment's — because the link means one thing.
 */
async function linkedActionWindow(
  tx: Sql,
  userId: string,
  raw: unknown
): Promise<{ id: string; minutes: number } | null> {
  const value = optionalText(raw);
  if (!value) return null;
  const id = await stableUuid("recurrence-window", value);
  const linked = await tx<
    Row<typeof actionsTable, "expected_minutes">[]
  >`SELECT ac.expected_minutes FROM action_recurrence_windows w JOIN action_recurrence_rules r ON r.id=w.rule_id JOIN actions ac ON ac.id=r.action_id JOIN projects p ON p.id=ac.project_id JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id WHERE w.id=${id} AND a.user_id=${userId}`;
  if (!linked[0]) throw notFound("action", value, "The linked recurring action window");
  return { id, minutes: linked[0].expected_minutes };
}

/**
 * Resolves and validates a step's `cadenceActionId` — the cadence action it stands in for, so
 * completing the step also records that action's cadence completion (`activity-commands.ts`'s
 * `routine_step`/`routine_instance` completion hooks). Mutually exclusive with `actionWindowId`,
 * checked by both save sites right after calling this (a single zod schema cannot express "at most
 * one of these two").
 *
 * this used to check ownership only, not `schedulingMode === 'cadence'`, on the theory that a
 * link to an action that later stops being cadence-scheduled is a legitimate, if inert, state. In
 * practice that let a save create a link the gate could never evaluate in the first place — pointing
 * at an ordinary action from the start — which then included the step every day and recorded nothing
 * on completion, silently. A save now refuses that outright; the sync-time gate
 * (`isPresetStepEligibleToday`, `platform/database/src/planning/routine-inheritance.ts`) still fails
 * *closed* for a link that stops being valid after it was saved (the action later changes mode, or is
 * deleted), since that gate has no save to refuse.
 */
async function linkedCadenceAction(tx: Sql, userId: string, raw: unknown): Promise<string | null> {
  const value = optionalText(raw);
  if (!value) return null;
  const id = await stableUuid(`action:${userId}`, value);
  const linked = await tx<
    Row<typeof actionsTable, "id" | "scheduling_mode">[]
  >`SELECT ac.id,ac.scheduling_mode FROM actions ac JOIN projects p ON p.id=ac.project_id JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id WHERE ac.id=${id} AND a.user_id=${userId}`;
  if (!linked[0]) throw notFound("action", value, "The linked cadence action");
  if (linked[0].scheduling_mode !== "cadence")
    throw new InvalidCommandError("The linked action is not scheduled as cadence.");
  return linked[0].id;
}
