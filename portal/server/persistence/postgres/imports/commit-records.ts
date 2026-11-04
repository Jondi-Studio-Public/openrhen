import { aliasTitleNorm, type ImportRecord, type PrerequisiteKind } from "@openrhen/contracts";
import { IMPORT_ENTITY_ORDER } from "@/features/imports/import-spec";
import { fieldValue } from "@/features/imports/import-validation";
import { addPrerequisites, assertNoPrerequisiteCycle, assertPrerequisiteTargetsOwned } from "../prerequisites";
import type { Sql } from "../sql-pool";
import { googleSeriesKey, linkGoogleCalendarCommitment, type GoogleCalendarSource } from "./calendar-profiles/calendar";
import { extensionOfLinkSource, type ExtensionLinkSource } from "./import-extensions";
import "./private/index";
// The calendar feed is core, so it registers beside the private seam, not inside it.
import "./calendar-feed-import-extension";
import { maskToApplyFields } from "./source-match-records";
import { linkSourceToRule, recordSourceAlias, unlinkSource, type LinkSourceArgs } from "./source-links";
import {
  assertAndDeleteCommitment,
  copyRoutineSteps,
  endCommitmentRecurrenceRule,
  fieldReader,
  upsertAction,
  upsertArea,
  upsertCommitment,
  upsertCommitmentRecurrenceRule,
  upsertConditionDefinition,
  upsertDeliverable,
  upsertOutcome,
  upsertPlanLink,
  upsertProject
} from "./upserts";

/**
 * Writes the ready records of a batch into the planning tables, parents before children, and maps
 * every written key onto its entity id. Runs inside the commit transaction; a thrown error unwinds
 * everything, which is what makes a commit atomic.
 */
export async function commitRecords(
  sql: Sql,
  userId: string,
  records: ImportRecord[],
  linkSource?: GoogleCalendarSource | ExtensionLinkSource
) {
  const entityIds = new Map<string, string>();
  const existingKeys = await sql<
    { entity_type: string; import_key: string; entity_id: string }[]
  >`SELECT entity_type, import_key, entity_id FROM import_entity_keys WHERE user_id=${userId}`;
  for (const row of existingKeys) entityIds.set(`${row.entity_type}:${row.import_key}`, row.entity_id);
  for (const record of records)
    if (
      record.entityType !== "dependency" &&
      record.entityType !== "deliverable_dependency" &&
      record.entityType !== "entity_prerequisite" &&
      record.entityType !== "condition_definition" &&
      record.entityType !== "plan_link" &&
      !entityIds.has(`${record.entityType}:${record.importKey}`)
    )
      entityIds.set(`${record.entityType}:${record.importKey}`, crypto.randomUUID());
  // A link joins a commitment that already exists: its key maps onto that commitment, not a fresh id.
  for (const record of records)
    if (record.operation === "link" && record.matchedEntityId)
      entityIds.set(`${record.entityType}:${record.importKey}`, record.matchedEntityId);
  const resolve = (type: string, key: string | null | undefined) => (key ? entityIds.get(`${type}:${key}`) : undefined);
  await assertNoDependencyCycle(sql, userId, records, resolve);
  await assertNoDeliverableDependencyCycle(sql, userId, records, resolve);
  for (const type of IMPORT_ENTITY_ORDER) {
    for (const record of records.filter((item) => item.entityType === type)) {
      // condition_definition's id is its own import_key (the slug) — there is no generated uuid to
      // look up, and no import_entity_keys row is needed since the key already is the identity.
      const id =
        type === "dependency" ||
        type === "deliverable_dependency" ||
        type === "entity_prerequisite" ||
        type === "plan_link"
          ? null
          : type === "condition_definition"
            ? record.importKey
            : entityIds.get(`${type}:${record.importKey}`)!;
      if (record.operation === "unlink") {
        // A secondary source dropped an event other sources still hold: only that source's link goes.
        const linkId = record.relationships.sourceUnlinkLinkId;
        if (linkId) await unlinkSource(sql, { userId, linkId });
        await sql`DELETE FROM import_entity_keys WHERE user_id=${userId} AND entity_type=${type} AND import_key=${record.importKey}`;
        continue;
      }
      if (type === "plan_link") {
        // Create only, never a delete: a link already confirmed comes back unchanged, a suggested or expired
        // one is confirmed, and a pair that has since been rejected fails the whole commit like any stale record.
        if (record.operation === "create") await upsertPlanLink(sql, userId, record);
        continue;
      }
      if (record.operation === "delete") {
        if (type === "fixed_commitment") await assertAndDeleteCommitment(sql, id!, record);
        if (type === "fixed_commitment_recurrence") await endCommitmentRecurrenceRule(sql, id!, record);
        continue;
      }
      const value = fieldReader(record);
      if (type === "area") await upsertArea(sql, userId, id!, record, value);
      if (type === "outcome")
        await upsertOutcome(sql, id!, resolve("area", record.relationships.areaKey)!, record, value);
      if (type === "project")
        await upsertProject(sql, id!, resolve("outcome", record.relationships.outcomeKey)!, record, value);
      if (type === "condition_definition") await upsertConditionDefinition(sql, userId, id!, record, value);
      if (type === "deliverable")
        await upsertDeliverable(sql, id!, resolve("project", record.relationships.projectKey)!, record, value);
      if (type === "deliverable_dependency")
        await sql`INSERT INTO deliverable_dependencies (deliverable_id, depends_on_deliverable_id) VALUES (${resolve("deliverable", record.relationships.deliverableKey)!}, ${resolve("deliverable", record.relationships.dependsOnDeliverableKey)!}) ON CONFLICT DO NOTHING`;
      if (type === "entity_prerequisite") {
        const ends = prerequisiteEnds(record, resolve);
        if (!ends) throw new Error("An imported prerequisite names an entity that was not found.");
        await assertPrerequisiteTargetsOwned(sql, userId, [ends.owner, ends.requires]);
        await addPrerequisites(sql, ends.owner, [ends.requires]);
      }
      if (type === "action")
        await upsertAction(sql, userId, id!, resolve("project", record.relationships.projectKey)!, record, value);
      if (type === "dependency")
        await sql`INSERT INTO action_dependencies (action_id, depends_on_action_id) VALUES (${resolve("action", record.relationships.actionKey)!}, ${resolve("action", record.relationships.dependsOnActionKey)!}) ON CONFLICT DO NOTHING`;
      if (type === "fixed_commitment" && record.operation === "link") {
        // A primary source's link makes its values the commitment's (definitive source); its extension applies them
        // (`beforeRecord`). Any other source joins with its own snapshot and leaves the commitment as it is.
        const applyFields = record.relationships.sourceMatchApplyFields;
        // A secondary source whose values differed from the plan's: the picked value of each differing
        // field is applied; the link's snapshot still keeps the remote's own values.
        const pickedFields = record.relationships.sourceMatchDiffFields;
        if (pickedFields && !applyFields) {
          const masked = maskToApplyFields({ ...record, operation: "update" }, pickedFields.split("|"));
          await upsertCommitment(sql, userId, id!, masked, fieldReader(masked));
        }
        if (record.relationships.sourceMatchKind === "possible" && linkSource) {
          const localTitle = record.relationships.sourceMatchTitle;
          const remoteTitle = String(remoteOr(record, value, "title") ?? "");
          if (localTitle && remoteTitle && aliasTitleNorm(localTitle) !== aliasTitleNorm(remoteTitle))
            await recordSourceAlias(sql, { userId, provider: linkSource.provider, remoteTitle, localTitle });
        }
      } else if (type === "fixed_commitment") await upsertCommitment(sql, userId, id!, record, value);
      const extension = extensionOfLinkSource(linkSource);
      const hookContext = {
        sql,
        userId,
        id: id!,
        type,
        record,
        value,
        remoteOr,
        linkSource
      };
      await extension?.beforeRecord?.(hookContext);
      // A remote series matched to a rule already on the plan joins it; the rule itself is not rewritten.
      if (type === "fixed_commitment_recurrence" && record.operation === "link") {
        const target = linkSource ? seriesLinkTarget(record, linkSource) : null;
        if (target) await linkSourceToRule(sql, { userId, ruleId: id!, ...target });
      } else if (type === "fixed_commitment_recurrence")
        await upsertCommitmentRecurrenceRule(sql, userId, id!, record, value);
      await extension?.afterRecord?.(hookContext);
      if (id && type !== "condition_definition")
        await sql`INSERT INTO import_entity_keys (user_id, entity_type, import_key, entity_id) VALUES (${userId}, ${type}, ${record.importKey}, ${id}) ON CONFLICT (user_id, entity_type, import_key) DO UPDATE SET entity_id=EXCLUDED.entity_id, updated_at=CURRENT_TIMESTAMP`;
      if (id && type === "fixed_commitment" && record.operation !== "link" && record.relationships.routineSteps)
        await copyRoutineSteps(sql, userId, id, record.relationships.routineSteps);
      if (
        id &&
        type === "fixed_commitment" &&
        linkSource?.provider === "google_calendar" &&
        record.importKey.startsWith("google_calendar:event:")
      ) {
        const key = record.importKey.slice("google_calendar:event:".length);
        const event = linkSource.events[key];
        if (event)
          await linkGoogleCalendarCommitment(
            sql,
            userId,
            id,
            key,
            event,
            linkSource.calendarNames[event.calendarId] ?? event.calendarId,
            record.operation === "link"
          );
      }
    }
  }
  // Judged once, over the graph as this transaction leaves it: a prerequisite can close a loop through
  // action and deliverable dependencies or through a project's children, which no one table shows.
  if (records.some((item) => item.entityType === "entity_prerequisite")) await assertNoPrerequisiteCycle(sql, userId);
}

/** The two ends of an `entity_prerequisite` record as stored ids, or null when either key is unmapped. */
function prerequisiteEnds(
  record: ImportRecord,
  resolve: (type: string, key: string | null | undefined) => string | undefined
) {
  const entityKind = String(fieldValue(record, "entityKind")) as PrerequisiteKind;
  const requiresKind = String(fieldValue(record, "requiresKind")) as PrerequisiteKind;
  const entityId = resolve(entityKind, String(fieldValue(record, "entityKey")));
  const requiresId = resolve(requiresKind, String(fieldValue(record, "requiresKey")));
  if (!entityId || !requiresId) return null;
  return { owner: { kind: entityKind, id: entityId }, requires: { kind: requiresKind, id: requiresId } };
}

/**
 * Where a series link record points in its source: the frame, the `series:<id>` key and a snapshot of
 * what the series said, read from the batch's own source events (never from the record, which the
 * review can edit). `null` for a provider with no series or a series no longer in the source.
 */
function seriesLinkTarget(
  record: ImportRecord,
  source: GoogleCalendarSource | ExtensionLinkSource
): Omit<LinkSourceArgs, "userId" | "commitmentId"> | null {
  let events: { title: string; startsAt: string; endsAt: string; location: string | null; seriesId: string | null }[] =
    [];
  let frameId = "";
  let profileLabel = "";
  let sourceCalendarId: string | null = null;
  const own = extensionOfLinkSource(source)?.seriesSource?.(record, source);
  if (own) {
    events = own.events;
    frameId = own.frameId;
    profileLabel = own.profileLabel;
    sourceCalendarId = own.sourceCalendarId;
  } else if (source.provider === "google_calendar" && record.importKey.startsWith("google_calendar:series:")) {
    const key = record.importKey.slice("google_calendar:series:".length);
    const matching = Object.values(source.events).filter(
      (event) => event.seriesId !== null && googleSeriesKey(event.calendarId, event.seriesId) === key
    );
    events = matching;
    frameId = matching[0]?.calendarId ?? "";
    profileLabel = frameId ? (source.calendarNames[frameId] ?? frameId) : "";
    sourceCalendarId = frameId || null;
  }
  const sorted = [...events].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const first = sorted[0];
  if (!first?.seriesId) return null;
  const snapshot = {
    title: first.title,
    location: first.location ?? null,
    occurrences: sorted.map((event) => ({ startsAt: event.startsAt, endsAt: event.endsAt }))
  };
  return {
    provider: source.provider,
    frameId,
    externalEventId: `series:${first.seriesId}`,
    profileLabel,
    sourceCalendarId,
    snapshot,
    hash: JSON.stringify(snapshot)
  };
}

/** A joining source's own value for a field that differed from the plan, else the record's value. */
function remoteOr(record: ImportRecord, value: (name: string) => unknown, name: string): unknown {
  const differing = String(record.relationships.sourceMatchDiffFields ?? "").split("|");
  const remote = record.relationships[`sourceMatchRemote:${name}`];
  return differing.includes(name) && remote ? JSON.parse(remote) : value(name);
}

async function assertNoDependencyCycle(
  sql: Sql,
  userId: string,
  records: ImportRecord[],
  resolve: (type: string, key: string | null | undefined) => string | undefined
) {
  const rows = await sql<
    { action_id: string; depends_on_action_id: string }[]
  >`SELECT ad.action_id, ad.depends_on_action_id FROM action_dependencies ad JOIN actions ac ON ac.id=ad.action_id JOIN projects p ON p.id=ac.project_id JOIN outcomes o ON o.id=p.outcome_id JOIN areas ar ON ar.id=o.area_id WHERE ar.user_id=${userId}`;
  const graph = new Map<string, string[]>();
  for (const row of rows) graph.set(row.action_id, [...(graph.get(row.action_id) ?? []), row.depends_on_action_id]);
  for (const record of records.filter((item) => item.entityType === "dependency")) {
    const actionId = resolve("action", record.relationships.actionKey);
    const dependencyId = resolve("action", record.relationships.dependsOnActionKey);
    if (actionId && dependencyId) graph.set(actionId, [...(graph.get(actionId) ?? []), dependencyId]);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if ((graph.get(id) ?? []).some(visit)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  if ([...graph.keys()].some(visit)) throw new Error("Imported dependencies would create a cycle.");
}

async function assertNoDeliverableDependencyCycle(
  sql: Sql,
  userId: string,
  records: ImportRecord[],
  resolve: (type: string, key: string | null | undefined) => string | undefined
) {
  const rows = await sql<
    { deliverable_id: string; depends_on_deliverable_id: string }[]
  >`SELECT dd.deliverable_id, dd.depends_on_deliverable_id FROM deliverable_dependencies dd JOIN deliverables d ON d.id=dd.deliverable_id JOIN projects p ON p.id=d.project_id JOIN outcomes o ON o.id=p.outcome_id JOIN areas ar ON ar.id=o.area_id WHERE ar.user_id=${userId}`;
  const graph = new Map<string, string[]>();
  for (const row of rows)
    graph.set(row.deliverable_id, [...(graph.get(row.deliverable_id) ?? []), row.depends_on_deliverable_id]);
  for (const record of records.filter((item) => item.entityType === "deliverable_dependency")) {
    const deliverableId = resolve("deliverable", record.relationships.deliverableKey);
    const dependencyId = resolve("deliverable", record.relationships.dependsOnDeliverableKey);
    if (deliverableId && dependencyId) graph.set(deliverableId, [...(graph.get(deliverableId) ?? []), dependencyId]);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if ((graph.get(id) ?? []).some(visit)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  if ([...graph.keys()].some(visit)) throw new Error("Imported deliverable dependencies would create a cycle.");
}
