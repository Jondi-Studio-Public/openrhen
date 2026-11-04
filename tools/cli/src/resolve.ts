import type { PortalState } from "./client.js";
import { entityItems, findEntity, type AnyRecord } from "./entities.js";
import { CliError, EXIT } from "./errors.js";

/** The field that holds a human-readable name, for the entities `list`'s reference filters match by title. */
const DISPLAY_FIELD: Record<string, string> = {
  areas: "name",
  outcomes: "title",
  projects: "title",
  actions: "title",
  commitments: "title",
  conditions: "name",
  "routine-presets": "name"
};

/**
 * Finds one item of a list-entity (named by its plural, e.g. `projects`) by exact id or by an exact,
 * case-insensitive display name (title for most kinds, name for areas). Used by `list`'s reference
 * filters (`--project`, `--area`, ...), which accept either form.
 */
export function resolveReference(state: PortalState, entityName: string, query: string): AnyRecord {
  const entity = findEntity(entityName);
  if (!entity) throw new CliError(`Unknown entity "${entityName}".`, EXIT.usage);
  const items = entityItems(state, entity);
  const byId = items.find((item) => item.id === query);
  if (byId) return byId;
  const field = DISPLAY_FIELD[entity.name] ?? "title";
  const wanted = query.trim().toLowerCase();
  const byTitle = items.find((item) => {
    const value = item[field];
    return typeof value === "string" && value.toLowerCase() === wanted;
  });
  if (byTitle) return byTitle;
  throw new CliError(`No ${entity.singular} with id or ${field} "${query}".`, EXIT.notFound);
}

/**
 * Resolves an id to exactly one item: an exact id match, else a unique case-insensitive id prefix.
 * No match is `notFound`; several matches is a `usage` error listing the candidates, so the caller can
 * type a longer prefix.
 */
export function resolveByIdOrPrefix(items: readonly AnyRecord[], id: string, singular: string): AnyRecord {
  const exact = items.find((item) => item.id === id);
  if (exact) return exact;
  const lowered = id.toLowerCase();
  const matches = items.filter((item) => typeof item.id === "string" && item.id.toLowerCase().startsWith(lowered));
  const [only, ...rest] = matches;
  if (only && rest.length === 0) return only;
  if (matches.length === 0) {
    // Fall back to the display name (title, or name for areas, presets and conditions), so the README's
    // `show project "Thesis"` works the same way a --project filter does.
    const named = items.filter((item) => displayName(item).toLowerCase() === lowered);
    if (named.length === 1) return named[0]!;
    if (named.length > 1) {
      const candidates = named.map((item) => String(item.id)).join(", ");
      throw new CliError(`"${id}" names several ${singular}s: ${candidates}.`, EXIT.usage);
    }
    throw new CliError(`No ${singular} with id or name "${id}".`, EXIT.notFound);
  }
  const candidates = matches.map((item) => `${String(item.id)} (${displayName(item)})`).join(", ");
  throw new CliError(`"${id}" matches several ${singular}s: ${candidates}.`, EXIT.usage);
}

function displayName(item: AnyRecord): string {
  if (typeof item.title === "string") return item.title;
  if (typeof item.name === "string") return item.name;
  return "";
}

/** Looks an item up by id in a raw state array, e.g. finding the project a `projectId` points at. */
export function lookupById(items: unknown, id: string | undefined): AnyRecord | undefined {
  if (!id || !Array.isArray(items)) return undefined;
  return (items as AnyRecord[]).find((item) => item.id === id);
}

/** Reads a raw state array as loosely-typed records, for building relation lists without per-kind casts. */
export function asRecords(items: unknown): AnyRecord[] {
  return Array.isArray(items) ? (items as AnyRecord[]) : [];
}

/** The occurrence with this id and the recurring action (template) it belongs to; undefined when `id` is no occurrence. */
export function occurrenceWithTemplate(
  state: PortalState,
  id: string
): { occurrence: AnyRecord; template: AnyRecord | undefined } | undefined {
  const occurrence = asRecords(state.occurrences).find((item) => item.id === id);
  if (!occurrence) return undefined;
  return { occurrence, template: asRecords(state.actions).find((item) => item.id === occurrence.actionId) };
}

/**
 * What a session start names. `actionId` is what the portal's Start sends as the command's `actionId`: an
 * occurrence id for a recurring series (the server then works the occurrence), the action id otherwise.
 * `template` is the stored action whose version goes in `expectedVersion` (for an occurrence, the series'
 * own record, as in the portal's `startCurrent`/`startAlternative`).
 */
export interface StartTarget {
  actionId: string;
  template: AnyRecord;
  occurrence?: AnyRecord;
}

/**
 * Resolves `--action` for a session start the way the portal's Start does. An occurrence id maps to its
 * template. A title or id that names a recurring template picks the one occurrence it can mean (the
 * current directive's, else the only one whose window is open at `at`) and otherwise says which to pass,
 * because the server refuses a session on the series itself: finishing one would end the whole series.
 */
export function resolveStartTarget(state: PortalState, query: string, at: Date): StartTarget {
  const named = occurrenceWithTemplate(state, query);
  if (named) {
    if (!named.template)
      throw new CliError(`Occurrence "${query}" belongs to an action that is not in the portal state.`, EXIT.notFound);
    return { actionId: query, template: named.template, occurrence: named.occurrence };
  }
  const template = resolveReference(state, "actions", query);
  const templateId = template.id as string;
  if (template.schedulingMode !== "recurring") return { actionId: templateId, template };

  const pending = asRecords(state.occurrences).filter(
    (item) => item.actionId === templateId && item.status === "pending"
  );
  const directive = state.planning?.result?.currentDirective;
  const inWindow = (item: AnyRecord) =>
    Date.parse(String(item.windowStartsAt)) <= at.getTime() && at.getTime() < Date.parse(String(item.windowEndsAt));
  const open = pending.filter(inWindow);
  const directed = directive?.kind === "action" ? open.find((item) => item.id === directive.targetId) : undefined;
  const chosen = directed ?? (open.length === 1 ? open[0] : undefined);
  if (chosen) return { actionId: chosen.id as string, template, occurrence: chosen };

  const title = String(template.title ?? templateId);
  const listing = pending
    .map((item) => `${String(item.id)} (${String(item.windowName ?? "window")} ${String(item.localDate ?? "")})`.trim())
    .join(", ");
  throw new CliError(
    pending.length === 0
      ? `"${title}" is a recurring action with no pending occurrence to start a session on.`
      : `"${title}" is a recurring action, so a session starts on one of its occurrences: pass --action <occurrence id>. Pending: ${listing}.`,
    pending.length === 0 ? EXIT.notFound : EXIT.usage
  );
}
