import { formatClock, localiseInstant } from "./when.js";

export type OutputMode = "table" | "json" | "jsonl";

const CELL_WIDTH = 48;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

export interface RenderOptions {
  /**
   * When set, ISO instants are shown as short local wall-clock times in tables, and rewritten to
   * carry this zone's own offset (instead of whatever they arrived with) in JSON/JSONL via `emitRows`.
   */
  timeZone?: string | undefined;
}

// C0 controls except tab and newline, DEL, and the C1 range. Dropping ESC alone already defuses every
// CSI/OSC/DCS sequence (what is left prints as plain text), and carriage return can overwrite a line.
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const TERMINAL_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * Text bound for a terminal with every control character removed. Mail subjects, bodies and other people's
 * text reach table output verbatim, and a terminal would otherwise act on an OSC 52 clipboard write or a
 * cursor move hidden in them.
 */
export function stripTerminalControls(text: string): string {
  return text.replace(TERMINAL_CONTROLS, "");
}

/** Reads a dotted path such as `project.title` or `steps.length` out of a record. */
export function getPath(item: unknown, path: string): unknown {
  let current: unknown = item;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function pickFields(row: unknown, fields: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const field of fields) picked[field] = getPath(row, field);
  return picked;
}

function localised(text: string, options: RenderOptions): string {
  return options.timeZone && ISO_INSTANT.test(text) ? formatClock(text, options.timeZone) : text;
}

/** One cell of a table: flat, single-line, and truncated unless it is an identifier. */
export function formatCell(value: unknown, column = "", options: RenderOptions = {}): string {
  let text: string;
  if (value === undefined) text = "";
  else if (value === null) text = "null";
  else if (typeof value === "string") text = localised(value, options);
  else if (typeof value === "number" || typeof value === "boolean") text = String(value);
  else if (Array.isArray(value))
    text = value.every((entry) => typeof entry !== "object" || entry === null)
      ? value.map((entry) => formatCell(entry, "", options)).join(", ")
      : `[${value.length} items]`;
  else text = JSON.stringify(value);
  // Controls go before measuring, so a run of them cannot push the printable text past the cut.
  text = stripTerminalControls(text).replace(/\s+/g, " ").trim();
  const keepsWhole = column === "id" || column.endsWith("Id") || column.endsWith("Ids");
  if (!keepsWhole && text.length > CELL_WIDTH) text = `${text.slice(0, CELL_WIDTH - 1)}…`;
  return text;
}

export function renderTable(rows: readonly unknown[], columns: readonly string[], options: RenderOptions = {}): string {
  if (rows.length === 0) return "(no rows)";
  const cells = rows.map((row) => columns.map((column) => formatCell(getPath(row, column), column, options)));
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...cells.map((line) => line[index]?.length ?? 0))
  );
  const line = (values: readonly string[]) =>
    values
      .map((value, index) => value.padEnd(widths[index] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(columns), line(widths.map((width) => "-".repeat(width))), ...cells.map(line)].join("\n");
}

/** `key: value` lines for one record; nested values are printed as compact JSON. */
export function renderRecord(
  record: Record<string, unknown>,
  options: RenderOptions & { skip?: readonly string[] } = {}
): string {
  const skip = new Set(options.skip ?? []);
  const keys = Object.keys(record).filter((key) => !skip.has(key) && record[key] !== undefined);
  const width = Math.max(0, ...keys.map((key) => key.length));
  return keys
    .map((key) => {
      const value = record[key];
      const text =
        typeof value === "object" && value !== null
          ? JSON.stringify(value)
          : value === null
            ? "null"
            : typeof value === "string"
              ? localised(value, options)
              : String(value);
      return `${key.padEnd(width)}  ${text}`;
    })
    .join("\n");
}

export function toJson(value: unknown, pretty = false): string {
  return pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}

/**
 * Deep-walks a value and rewrites every ISO-instant string to carry `timeZone`'s own offset instead
 * of whatever it arrived with, so JSON output reads in the planning timezone without losing
 * machine-parsability. Used for every command's `--json`/`--jsonl` output except `state` (a raw dump,
 * left untouched on purpose) and `schema`.
 */
export function localiseInstants<T>(value: T, timeZone: string): T {
  if (typeof value === "string") return (ISO_INSTANT.test(value) ? localiseInstant(value, timeZone) : value) as T;
  if (Array.isArray(value)) return value.map((entry) => localiseInstants(entry, timeZone)) as T;
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>))
      result[key] = localiseInstants(entry, timeZone);
    return result as T;
  }
  return value;
}

export interface Emitter {
  mode: OutputMode;
  stdout: (text: string) => void;
}

/** Writes a list of rows in whichever shape the caller asked for. Tables show `columns`; JSON shows everything. */
export function emitRows(
  emitter: Emitter,
  rows: readonly unknown[],
  columns: readonly string[],
  options: RenderOptions & { fields?: readonly string[] | undefined } = {}
): void {
  const projected = options.fields ? rows.map((row) => pickFields(row, options.fields ?? [])) : rows;
  if (emitter.mode === "json" || emitter.mode === "jsonl") {
    const localised = options.timeZone ? localiseInstants(projected, options.timeZone) : projected;
    if (emitter.mode === "json") emitter.stdout(toJson(localised, true));
    else for (const row of localised) emitter.stdout(toJson(row));
  } else emitter.stdout(renderTable(rows, options.fields ?? columns, { timeZone: options.timeZone }));
}
