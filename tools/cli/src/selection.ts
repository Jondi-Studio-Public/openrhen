import type { PortalState } from "./client.js";
import type { OptionValue, OptionValues } from "./command.js";
import { stringOption } from "./command.js";
import { entityItems, type AnyRecord, type EntityDefinition, type FilterName } from "./entities.js";
import { CliError, EXIT } from "./errors.js";
import { getPath } from "./output.js";
import { resolveReference } from "./resolve.js";
import { parseWhen } from "./when.js";

/**
 * The shared `list` filter options, in the order `list`'s and `bulk`'s help print them. Both
 * commands refuse a filter that does not apply to the chosen entity, naming the ones that do
 * (`validateFilterOptions`), and both select rows from the same `selectRows` — `bulk --dry-run`
 * must show exactly the rows `list` would, or the preview lies about what would change.
 */
export const FILTER_OPTION_NAMES: FilterName[] = [
  "project",
  "area",
  "outcome",
  "action",
  "commitment",
  "preset",
  "status",
  "scheduling-mode",
  "search",
  "since",
  "from",
  "to"
];

/** Whether any built-in filter option (or `--where`) was given, for a command that also accepts other selectors. */
export function hasAnyFilterOption(values: OptionValues): boolean {
  return FILTER_OPTION_NAMES.some((name) => stringOption(values, name) !== undefined) || values.where !== undefined;
}

/** Refuses a filter that the entity does not support, naming the ones that do — same message for `list` and `bulk`. */
export function validateFilterOptions(entity: EntityDefinition, values: OptionValues): void {
  for (const name of FILTER_OPTION_NAMES) {
    if (stringOption(values, name) !== undefined && !entity.filters.includes(name))
      throw new CliError(
        `--${name} does not apply to ${entity.name}; it accepts: ${entity.filters.map((filter) => `--${filter}`).join(", ")}.`,
        EXIT.usage
      );
  }
  const status = stringOption(values, "status");
  if (status !== undefined) validateStatusValues(entity, status);
}

/**
 * Refuses a `--status` word the entity never carries, naming the ones it does: a typo would otherwise
 * select nothing and read as "(no rows)". Same message for `list` and `bulk`.
 */
function validateStatusValues(entity: EntityDefinition, raw: string): void {
  const allowed = entity.statuses;
  if (!allowed) return;
  const wanted = [...commaSet(raw)];
  const unknown = wanted.filter((status) => !allowed.includes(status));
  if (wanted.length === 0)
    throw new CliError(`--status needs at least one status. Use one of: ${allowed.join(", ")}.`, EXIT.usage);
  if (unknown.length > 0)
    throw new CliError(
      `Unknown ${entity.singular} status ${unknown.map((status) => `"${status}"`).join(", ")}. ` +
        `Use one of: ${allowed.join(", ")}.`,
      EXIT.usage
    );
}

function commaSet(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  );
}

/** Matches ISO date and date-time strings — a date-only field like `reviewOn` as well as a full instant. */
const ISO_DATE_LIKE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Orders `itemValue` against the right-hand side of a `<`/`>`/`<=`/`>=` clause: negative when
 * `itemValue` is smaller, positive when larger, zero when equal. A value that looks like an ISO
 * date or date-time is compared as an instant, with the right-hand side read through `parseWhen` so
 * `today`, `+7d`, and relative offsets work the same way `--from`/`--to` already do (e.g.
 * `scheduledEndAt<today`). Otherwise both sides are compared numerically when they parse as numbers,
 * and lexically as a last resort.
 */
function compareToThreshold(itemValue: unknown, rawValue: string, now: Date, timeZone?: string): number {
  if (typeof itemValue === "string" && ISO_DATE_LIKE.test(itemValue)) {
    const left = new Date(itemValue).getTime();
    if (!Number.isNaN(left)) return left - parseWhen(rawValue, now, timeZone).getTime();
  }
  const leftNumber =
    typeof itemValue === "number"
      ? itemValue
      : typeof itemValue === "string" && itemValue.trim() !== ""
        ? Number(itemValue)
        : NaN;
  const rightNumber = Number(rawValue);
  if (!Number.isNaN(leftNumber) && !Number.isNaN(rightNumber)) return leftNumber - rightNumber;
  const leftText = itemValue === undefined || itemValue === null ? "" : String(itemValue);
  return leftText < rawValue ? -1 : leftText > rawValue ? 1 : 0;
}

/**
 * Applies every `--where` clause (`field=value`, `field!=value`, or a comparison `field<value`,
 * `field>value`, `field<=value`, `field>=value`; repeatable, ANDed together) to `rows`. `field` may
 * be a dotted path, read the same way `--sort`/`--fields` read one. `=`/`!=` match a comma-separated
 * set of values after `String()` coercion (`--where status=pending,active`); the comparison
 * operators take a single value, compared with `compareToThreshold` above, e.g.
 * `--where "scheduledEnd<2026-09-04"` or `--where importance>=4`.
 */
export function applyWhereClauses(rows: AnyRecord[], rawWhere: OptionValue, now: Date, timeZone?: string): AnyRecord[] {
  const clauses = Array.isArray(rawWhere) ? rawWhere : rawWhere !== undefined ? [rawWhere] : [];
  let result = rows;
  for (const clause of clauses) {
    const text = String(clause);
    const match = /^([^=!<>]+)(!=|<=|>=|=|<|>)(.*)$/.exec(text);
    if (!match)
      throw new CliError(
        `--where must be field=value, field!=value, field<value, field>value, field<=value, or field>=value, got "${text}".`,
        EXIT.usage
      );
    const [, rawField, operator, rawValue] = match;
    const field = (rawField ?? "").trim();
    const value = rawValue ?? "";
    if (operator === "=" || operator === "!=") {
      const wanted = commaSet(value);
      const negate = operator === "!=";
      result = result.filter((item) => {
        const cell = getPath(item, field);
        const asText = cell === undefined || cell === null ? "" : String(cell);
        const matches = wanted.has(asText);
        return negate ? !matches : matches;
      });
      continue;
    }
    result = result.filter((item) => {
      const cell = getPath(item, field);
      if (cell === undefined || cell === null) return false;
      const cmp = compareToThreshold(cell, value, now, timeZone);
      if (operator === "<") return cmp < 0;
      if (operator === ">") return cmp > 0;
      if (operator === "<=") return cmp <= 0;
      return cmp >= 0; // ">="
    });
  }
  return result;
}

function isAtOrAfter(item: AnyRecord, field: string, threshold: Date): boolean {
  const value = item[field];
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.getTime() >= threshold.getTime();
}

function isBefore(item: AnyRecord, field: string, threshold: Date): boolean {
  const value = item[field];
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.getTime() < threshold.getTime();
}

/** Whether a project belongs to an area directly, or through its outcome. */
function projectMatchesArea(state: PortalState, project: AnyRecord, areaId: string): boolean {
  if (project.area === areaId) return true;
  const outcomeId = project.outcomeId;
  if (typeof outcomeId !== "string") return false;
  const outcome = state.outcomes.find((candidate) => candidate.id === outcomeId);
  return outcome?.areaId === areaId;
}

/** Areas apply directly to outcomes and projects, and through the project for actions and deliverables. */
function itemMatchesArea(state: PortalState, entity: EntityDefinition, item: AnyRecord, areaId: string): boolean {
  if (entity.name === "outcomes") return item.areaId === areaId;
  if (entity.name === "projects") return projectMatchesArea(state, item, areaId);
  const projectId = item.projectId;
  if (typeof projectId !== "string") return false;
  const project = state.projects.find((candidate) => candidate.id === projectId);
  return project ? projectMatchesArea(state, project as unknown as AnyRecord, areaId) : false;
}

/**
 * The rows of `entity` that match every filter option given in `values` — the built-in ones
 * (`--project`, `--area`, ..., `--status`, `--scheduling-mode`), `--where`, `--search`, and
 * `--since`/`--from`/`--to`. Shared by `list` (which then sorts, pages, and projects fields) and
 * `bulk` (which then patches whatever this returns), so the two always agree on what a filter set
 * selects. Callers should run `validateFilterOptions` first so an unsupported filter is refused
 * before this silently ignores it.
 */
export function selectRows(state: PortalState, entity: EntityDefinition, values: OptionValues, now: Date): AnyRecord[] {
  let rows = entityItems(state, entity);

  const project = stringOption(values, "project");
  if (project !== undefined) {
    const match = resolveReference(state, "projects", project);
    rows = rows.filter((item) => item.projectId === match.id);
  }

  const outcome = stringOption(values, "outcome");
  if (outcome !== undefined) {
    const match = resolveReference(state, "outcomes", outcome);
    rows = rows.filter((item) => item.outcomeId === match.id);
  }

  const area = stringOption(values, "area");
  if (area !== undefined) {
    const match = resolveReference(state, "areas", area);
    const areaId = match.id as string;
    rows = rows.filter((item) => itemMatchesArea(state, entity, item, areaId));
  }

  const action = stringOption(values, "action");
  if (action !== undefined) {
    const match = resolveReference(state, "actions", action);
    rows = rows.filter((item) => item.actionId === match.id);
  }

  const commitment = stringOption(values, "commitment");
  if (commitment !== undefined) {
    const match = resolveReference(state, "commitments", commitment);
    rows = rows.filter((item) => item.commitmentId === match.id);
  }

  const preset = stringOption(values, "preset");
  if (preset !== undefined) {
    const match = resolveReference(state, "routine-presets", preset);
    rows = rows.filter((item) => item.routinePresetId === match.id);
  }

  const status = stringOption(values, "status");
  if (status !== undefined) {
    const wanted = commaSet(status);
    rows = rows.filter((item) => typeof item.status === "string" && wanted.has(item.status));
  }

  const schedulingMode = stringOption(values, "scheduling-mode");
  if (schedulingMode !== undefined) {
    const wanted = commaSet(schedulingMode);
    rows = rows.filter((item) => typeof item.schedulingMode === "string" && wanted.has(item.schedulingMode));
  }

  rows = applyWhereClauses(rows, values.where, now, state.settings.timezone);

  const search = stringOption(values, "search");
  if (search !== undefined) rows = rankBySearch(rows, entity.searchFields, search);

  const since = stringOption(values, "since");
  if (since !== undefined) {
    const threshold = parseWhen(since, now, state.settings.timezone);
    const field = entity.createdField ?? entity.timeField;
    rows = field ? rows.filter((item) => isAtOrAfter(item, field, threshold)) : [];
  }

  const from = stringOption(values, "from");
  if (from !== undefined && entity.timeField) {
    const threshold = parseWhen(from, now, state.settings.timezone);
    const field = entity.timeField;
    rows = rows.filter((item) => isAtOrAfter(item, field, threshold));
  }

  const to = stringOption(values, "to");
  if (to !== undefined && entity.timeField) {
    const threshold = parseWhen(to, now, state.settings.timezone);
    const field = entity.timeField;
    rows = rows.filter((item) => isBefore(item, field, threshold));
  }

  return rows;
}

const SEARCH_STOP_WORDS = new Set(["the", "a", "an", "to", "of", "for", "at", "in", "on", "and", "or"]);

function searchWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "" && !SEARCH_STOP_WORDS.has(word));
}

/** A query word matches a field word exactly, or by prefix when the shorter side has 4+ characters. */
function wordMatches(queryWord: string, fieldWord: string): boolean {
  if (queryWord === fieldWord) return true;
  const [shorter, longer] = queryWord.length <= fieldWord.length ? [queryWord, fieldWord] : [fieldWord, queryWord];
  return shorter.length >= 4 && longer.startsWith(shorter);
}

/**
 * `--search`: keep a row when the whole query appears as a substring of a search field (the original
 * rule), or when at least a third of the query's words (stop words dropped) appear in its search fields.
 * Rows come back best match first, so a caller that reads only the top few sees the likeliest ones;
 * ties keep their original order and an explicit `--sort` still overrides the ranking. The first
 * search field is the title, so a hit there outranks a hit in a note.
 */
function rankBySearch(rows: AnyRecord[], searchFields: readonly string[], query: string): AnyRecord[] {
  const phrase = query.toLowerCase();
  const queryWords = [...new Set(searchWords(query))];
  const needed = Math.max(1, Math.ceil(queryWords.length / 3));
  const scored: Array<{ row: AnyRecord; score: number; index: number }> = [];
  rows.forEach((row, index) => {
    let score = 0;
    let phraseHit = false;
    const fieldWords: string[][] = [];
    searchFields.forEach((field, position) => {
      const value = row[field];
      if (typeof value !== "string") {
        fieldWords.push([]);
        return;
      }
      fieldWords.push(searchWords(value));
      if (value.toLowerCase().includes(phrase)) {
        phraseHit = true;
        score += position === 0 ? 100 : 50;
      }
    });
    let matched = 0;
    for (const word of queryWords) {
      const inFields = fieldWords.findIndex((words) => words.some((fieldWord) => wordMatches(word, fieldWord)));
      if (inFields < 0) continue;
      matched += 1;
      score += inFields === 0 ? 4 : 2;
    }
    if (phraseHit || matched >= needed) scored.push({ row, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((entry) => entry.row);
}
