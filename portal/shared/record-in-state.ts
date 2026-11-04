import { SAVE_ENTITY_KINDS, entityFieldNames, type SaveEntityKind } from "@openrhen/contracts";

/** Where `PortalState` keeps each entity kind a save writes; settings is the one singleton. */
const STATE_KEYS: Record<string, string> = {
  area: "areas",
  outcome: "outcomes",
  project: "projects",
  action: "actions",
  commitment: "commitments",
  capture: "captures",
  deliverable: "deliverables",
  routine_step: "routineSteps",
  routine_preset: "routinePresets",
  sleep_plan: "sleepPlans",
  planning_focus: "planningFocus",
  span: "spans",
  sleep_log_entry: "sleepPlans",
  condition_definition: "conditionDefinitions"
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/**
 * The stored record a save of `kind` with this `id` would change, read from portal state (the server's or the
 * browser's copy); undefined when the state does not hold it. The proposal summary and the proposal card both read it,
 * so an update names the record it overwrites, not the name the agent is giving it.
 */
export function recordInState(
  state: unknown,
  kind: string,
  id: unknown,
  sent?: Record<string, unknown>
): Record<string, unknown> | undefined {
  const root = asRecord(state);
  if (!root) return undefined;
  if (kind === "settings") return asRecord(root.settings);
  // Keyed by its day, not its id: the stored plan only when it is for the day the save names.
  if (kind === "daily_plan") {
    const plan = asRecord(root.dailyPlan);
    return plan && plan.localDate === sent?.localDate ? plan : undefined;
  }
  // Saved by its kind and period start, the key the save looks it up by; the id a save carries is unused.
  if (kind === "planning_focus") {
    const rows = Array.isArray(root.planningFocus) ? root.planningFocus.map(asRecord) : [];
    const start = typeof sent?.periodStart === "string" ? sent.periodStart.slice(0, 10) : undefined;
    return rows.find((row) => row?.kind === sent?.kind && row?.periodStart === start);
  }
  // The one availability, kept at the root of portal state.
  if (kind === "current_availability")
    return {
      currentEnergy: root.currentEnergy,
      assertedConditions: root.assertedConditions,
      currentSituation: root.currentSituation
    };
  const rows = root[STATE_KEYS[kind] ?? ""];
  const row = Array.isArray(rows) ? rows.map(asRecord).find((item) => item?.id === id) : undefined;
  if (!row) return undefined;
  // A logged night is a sleep plan; the log save names its times sleepAt and wakeAt (E:1250-1334).
  if (kind === "sleep_log_entry") return { ...row, sleepAt: row.actualStartAt, wakeAt: row.actualWakeAt };
  if (kind === "routine_step" && sent) return { ...row, [PREVIOUS_STEP]: previousStep(rows as unknown[], id, sent) };
  return row;
}

/**
 * On a routine step found with the save it is for: the dependency list that save writes when it leaves
 * `dependencyIds` out, the step just before it in the same commitment and phase (E:1092-1103).
 */
export const PREVIOUS_STEP: unique symbol = Symbol("previousStep");

function previousStep(rows: unknown[], id: unknown, sent: Record<string, unknown>): string[] {
  const sequence = typeof sent.sequence === "number" ? sent.sequence : Number(sent.sequence);
  if (!(sequence > 0)) return [];
  const phase = sent.phase === "after" ? "after" : "before";
  const before = rows
    .map(asRecord)
    .filter(
      (row): row is Record<string, unknown> =>
        !!row &&
        row.id !== id &&
        row.commitmentId === sent.commitmentId &&
        (row.phase ?? "before") === phase &&
        typeof row.sequence === "number" &&
        row.sequence < sequence
    )
    .sort((a, b) => (b.sequence as number) - (a.sequence as number));
  return before[0] && typeof before[0].id === "string" ? [before[0].id] : [];
}

/** Kinds saved by a natural key rather than a version: a save of one is an update whenever one is stored. */
export const KEYED_BY_NATURAL_KEY: ReadonlySet<string> = new Set(["daily_plan", "current_availability"]);

type Omitted = { key: string; becomes: unknown };

/**
 * What an update of each kind does with a saveable field the request leaves out, read from the save paths
 * (`portal/server/persistence/postgres/`, `project-commands.ts` = P, `entity-commands.ts` = E,
 * `deliverable-write.ts` = D). A save mostly restates the whole record, so a field in neither table is written
 * null or empty. This table lists the fields (a) kept as stored; `DEFAULT_WHEN_OMITTED` the fields (c) written as a
 * fixed default. A field required by the command schema or the save path is listed as kept: leaving it out is
 * refused, so it is never cleared. A kind whose update is not a row overwrite is "all" (nothing is cleared).
 */
const KEPT_WHEN_OMITTED: Record<string, readonly string[] | "all"> = {
  // E:214-228. The update writes name, description, status and sort_order; `private` is COALESCEd (E:226).
  // name, status and sortOrder are required. description is cleared.
  area: ["id", "name", "status", "sortOrder", "private"],
  // E:229-248. Every outcome field is written outright; id and the rest but deadlineAt and reviewOn are required.
  outcome: ["id", "areaId", "title", "definitionOfDone", "value", "status"],
  // P:39 (the projects save). `private` is COALESCEd; `prerequisites` is only replaced when present (P:45-51).
  // The deadlines and remainingEffortOverrideMinutes are written outright (null when absent).
  project: ["id", "outcomeId", "title", "status", "uncertainty", "consequence", "private", "prerequisites"],
  // P:212 (the actions save) and the lines above it. Kept: `private` (COALESCE), `prepForCommitmentId` (P:163-170),
  // `notes` (P:206), `completedAt` (COALESCE, P:210), `prerequisites`, `requirementPathways` and `preferences`
  // (only written when present, P:232-247), and `blockingReason`/`note`, which go to the change log, not the
  // action. A recurring action's deadlineAt/latestStartAt are cleared, and so are those of a one-off; only a save
  // that itself sends schedulingMode "cadence" keeps them (P:186-197), which this table cannot see. `recurrence`
  // absent deletes the rule (P:269). Required fields are refused when absent.
  action: [
    "id",
    "projectId",
    "title",
    "status",
    "optimisticMinutes",
    "expectedMinutes",
    "pessimisticMinutes",
    "remainingMinutes",
    "energy",
    "minimumSessionMinutes",
    "maximumSessionMinutes",
    "splittable",
    "setupMinutes",
    "importance",
    "consequence",
    "contexts",
    "dependencyIds",
    "private",
    "prepForCommitmentId",
    "notes",
    "completedAt",
    "prerequisites",
    "requirementPathways",
    "preferences",
    "blockingReason",
    "note"
  ],
  // E:431 (the commitments save). Cleared: location, locationId, projectId (written outright). Kept: presence,
  // promptPolicy, shareToCalendar, latenessMatters, private, origin, disruptionSource, disruptionOpenEnded and
  // landedAt (COALESCE); contactId (E:374), transportMode (E:386), attendance (E:396) and preferredLocationId
  // (E:398), and routineSource and routinePresetId (written only when routineSource is sent, E:435); scheduleSource
  // (E:421, stored unless the edit diverges from a recurring series). Two of them follow a sent companion field
  // instead (`companionCleared`).
  commitment: [
    "id",
    "title",
    "startsAt",
    "endsAt",
    "status",
    "setupBeforeMinutes",
    "transitionAfterMinutes",
    "contactId",
    "presence",
    "promptPolicy",
    "shareToCalendar",
    "latenessMatters",
    "transportMode",
    "attendance",
    "preferredLocationId",
    "private",
    "routineSource",
    "routinePresetId",
    "origin",
    "disruptionSource",
    "disruptionOpenEnded",
    "landedAt",
    "scheduleSource"
  ],
  // E:1677 (the proposals save). Writes status, proposal_type (required), proposed_fields and reviewed_at only;
  // the text, questions, sourceType, createdAt and restore are never touched on an update. proposedFields resets
  // to {} (a default); reviewedAt is cleared.
  capture: ["id", "text", "status", "proposalType", "questions", "restore", "createdAt", "sourceType"],
  // D:82 (the deliverables save) and D:114-141 (children replaced wholesale). Kept: `private` (D:80) and
  // `prerequisites` (D:278). Cleared: details, the deadlines, completionThreshold, the approval timestamps and
  // note, submittedAt, completedAt, dependencyIds, steps, criteria and blockers. projectId and title are required.
  deliverable: ["id", "projectId", "title", "private", "prerequisites"],
  // E:1086 (the routine_steps save). Cleared: maxLeadMinutes (null unless flexible), actionWindowId,
  // cadenceActionId, mustStartByMinutes, contexts and preferredBands; dependencyIds is rewritten as the previous step
  // when sequence > 0, else none (E:1092-1103, `PREVIOUS_STEP`). scheduledStartAt/EndAt are never written by an
  // update, so kept.
  // durationMinutes is required unless an action window gives it. Required: commitmentId, title, sequence, energy,
  // timingRule.
  routine_step: [
    "id",
    "commitmentId",
    "title",
    "sequence",
    "energy",
    "timingRule",
    "durationMinutes",
    "scheduledStartAt",
    "scheduledEndAt"
  ],
  // E:968 (the routine_presets save) then steps replaced (E:971-995). name and steps are required (steps is
  // refused when empty, E:964).
  routine_preset: ["id", "name", "steps"],
  // Not a row overwrite (E:1179-1232): three shapes (new times, a placement choice, a stay-up decline) each write
  // only the columns they name.
  sleep_plan: "all",
  // E:1362 (the spans save). title, startDate and endDate are required; window and projectId are written
  // outright. `remove` is not stored.
  span: ["id", "title", "startDate", "endDate", "remove"],
  // E:732-870 (an upsert): everything is rewritten except `one_off` (E:830), which is a
  // birth property and keeps the stored value. id, name and kind are required.
  condition_definition: ["id", "name", "kind", "oneOff"],
  // E:444-710: every field reads its stored value when the payload omits it.
  settings: "all",
  // E:1589-1622 (the planning_focus_periods save + projects replaced). kind, periodStart and periodEnd are
  // required; projectIds is replaced outright. id is unused.
  planning_focus: ["id", "kind", "periodStart", "periodEnd"],
  // E:1778 (the daily_plans save) and E:1786-1791. horizonOverrideAt and recoverySkipped keep the stored value
  // (E:1734, E:1772); desiredActionIds and deferredItems are deleted and rewritten from the request. localDate is
  // the key; id is unused.
  daily_plan: ["id", "localDate", "horizonOverrideAt", "recoverySkipped"],
  // E:909 (the user_preferences save). assertedConditions is rewritten (empty when absent). currentSituation merges
  // over the stored one (`nextCurrentSituation`); energyAsserted is not stored. currentEnergy is required.
  current_availability: ["currentEnergy", "energyAsserted", "currentSituation"],
  // E:1233-1334: a correction to one logged night (sleepAt, wakeAt) or its removal, not a restated record.
  sleep_log_entry: "all",
  // E:1367-1534: confirms a pending proposal into a new record; it overwrites no stored record.
  capture_review: "all",
  // E:1535-1588: confirms or ignores a pending requirement proposal; it overwrites no stored record.
  deliverable_contract_review: "all"
};

/**
 * Fields an update writes as a fixed default when the request omits them (path (c)), per kind. A value that is a
 * function is worked out from the request (`(sent) => value`).
 */
const DEFAULT_WHEN_OMITTED: Record<string, Record<string, unknown>> = {
  // P:172: an action with no schedulingMode is a one-off.
  action: { schedulingMode: "one_off" },
  // D:43, D:62-68, D:75.
  deliverable: {
    status: "needs_breakdown",
    uncertainty: "some",
    importance: 3,
    consequence: 3,
    contractVersion: 0,
    planVersion: 0,
    sortOrder: 0
  },
  // E:1072, E:1083, `routineStepTimingFields` (E:162-165).
  routine_step: { status: "pending", phase: "before", waitAfterMinutes: 0 },
  // E:937-942: activityName falls back to the name; status is active; replacesWakeRoutine is false.
  routine_preset: {
    activityName: (sent: Record<string, unknown>) => sent.name,
    status: "active",
    replacesWakeRoutine: false
  },
  // E:746, E:759, E:864-865 (`Number(x) || 0`).
  condition_definition: { status: "active", portability: "fixed", setupBeforeMinutes: 0, transitionAfterMinutes: 0 },
  // E:1677: proposed_fields is `entity.proposedFields ?? {}`.
  capture: { proposedFields: {} }
};

/**
 * Fields an update clears because of another field, whether the request leaves them out or restates them (E:327-339,
 * E:393-402): a commitment that is not remote keeps no preferred place, and a routine source other than "preset"
 * keeps no preset. A value the request sends for one is ignored, so the summary and card show it as cleared.
 */
export function companionCleared(
  kind: string,
  stored: Record<string, unknown>,
  sent: Record<string, unknown>
): string[] {
  if (kind !== "commitment") return [];
  const out: string[] = [];
  if ((sent.attendance ?? stored.attendance ?? "in_person") !== "remote") out.push("preferredLocationId");
  if (typeof sent.routineSource === "string" && sent.routineSource !== "" && sent.routineSource !== "preset")
    out.push("routinePresetId");
  return out;
}

const isEmpty = (value: unknown) =>
  value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);

const sameValue = (left: unknown, right: unknown) => left === right || JSON.stringify(left) === JSON.stringify(right);

/**
 * The saveable fields the stored record has a value for that an update of `kind` leaves out, with what the save
 * writes instead: null (`becomes` null) or the kind's fixed default. A default the stored value already equals is
 * not a change and is skipped. Read-only joined or derived fields of a stored record are not saveable
 * (`entityFieldNames`) and never counted. The proposal summary and card list these so "no field changes" is never
 * said of a save that empties or resets one.
 */
export function omittedStoredFields(
  kind: string,
  stored: Record<string, unknown>,
  sent: Record<string, unknown>
): Omitted[] {
  const kept = KEPT_WHEN_OMITTED[kind];
  if (kept === "all" || !(SAVE_ENTITY_KINDS as readonly string[]).includes(kind)) return [];
  const defaults = DEFAULT_WHEN_OMITTED[kind] ?? {};
  const out: Omitted[] = [];
  const cleared = companionCleared(kind, stored, sent);
  for (const key of entityFieldNames(kind as SaveEntityKind)) {
    if (key === "version" || key === "remove" || ((kept ?? []).includes(key) && !cleared.includes(key))) continue;
    // A cadence action's save keeps its stored deadline and latest start (project-commands.ts, saveAction).
    if (kind === "action" && sent.schedulingMode === "cadence" && (key === "deadlineAt" || key === "latestStartAt"))
      continue;
    if (Object.prototype.hasOwnProperty.call(sent, key) && !cleared.includes(key)) continue;
    if (kind === "routine_step" && key === "dependencyIds") {
      // Re-derived, not cleared, when the step is not first; unknown without the other steps to read.
      const derived =
        Number(sent.sequence) > 0 ? ((stored as Record<symbol, unknown>)[PREVIOUS_STEP] ?? "the step before it") : [];
      if (!sameValue(stored[key] ?? [], derived)) out.push({ key, becomes: isEmpty(derived) ? null : derived });
      continue;
    }
    if (isEmpty(stored[key])) continue;
    if (Object.prototype.hasOwnProperty.call(defaults, key)) {
      const given = defaults[key];
      const becomes = typeof given === "function" ? (given as (sent: Record<string, unknown>) => unknown)(sent) : given;
      if (!sameValue(stored[key], becomes)) out.push({ key, becomes });
    } else out.push({ key, becomes: null });
  }
  return out;
}
