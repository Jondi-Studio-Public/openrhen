/**
 * Turns the zod issue array a validation failure carries (the portal's 400 body, or a payload the CLI
 * checked itself) into one short human line per problem. `--json` still gets the raw array.
 */

interface Issue {
  path: (string | number)[];
  message: string;
  code?: string;
  values?: unknown[];
  format?: string;
  origin?: string;
  maximum?: number | bigint;
  minimum?: number | bigint;
  inclusive?: boolean;
}

const MAX_LINES = 8;

function isIssue(value: unknown): value is Issue {
  if (!value || typeof value !== "object") return false;
  const { path, message } = value as { path?: unknown; message?: unknown };
  return (Array.isArray(path) || typeof path === "string") && typeof message === "string";
}

/** True when `details` is a non-empty array of zod-shaped issues. */
export function isIssueList(details: unknown): details is Issue[] {
  return Array.isArray(details) && details.length > 0 && details.every(isIssue);
}

const kebab = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

/**
 * The flag a camelCase field is set by: its kebab-case name, or that name with leading words dropped
 * and a trailing `-id` removed (`deviationCategory` is `--category`, `deviationTargetId` is `--target`).
 */
function flagFor(field: string, flags: ReadonlySet<string>): string | undefined {
  const words = kebab(field).split("-");
  for (let from = 0; from < words.length; from += 1) {
    const rest = words.slice(from);
    for (const candidate of [rest.join("-"), rest.at(-1) === "id" ? rest.slice(0, -1).join("-") : ""])
      if (candidate !== "" && flags.has(candidate)) return candidate;
  }
  return undefined;
}

/** The name to show for an issue's field: `--flag` when a one-segment path is a flag of this command, otherwise the dotted path. */
function fieldName(path: Issue["path"] | string, flags: ReadonlySet<string>): string {
  const segments = typeof path === "string" ? (path === "" ? [] : path.split(".")) : path;
  if (segments.length === 0) return "The request";
  const flag = segments.length === 1 && typeof segments[0] === "string" ? flagFor(segments[0], flags) : undefined;
  return flag !== undefined ? `--${flag}` : segments.join(".");
}

function describe(issue: Issue, flags: ReadonlySet<string>): string {
  const field = fieldName(issue.path, flags);
  if (issue.code === "invalid_value" && Array.isArray(issue.values) && issue.values.length > 0) {
    const values = issue.values.map(String);
    return values.length === 1 ? `${field} must be ${values[0]}` : `${field} must be one of: ${values.join(", ")}`;
  }
  // The contracts' own date-time text already names the value sent, the format with an example and what to do.
  if (issue.code === "invalid_format" && issue.format === "datetime" && issue.message.includes("ISO 8601"))
    return `${field}: ${issue.message}`;
  if (issue.code === "invalid_format" && issue.format === "datetime")
    return `${field} must be an ISO date and time that includes an offset like +11:00 or Z (for example 2026-10-27T14:54:00+11:00)`;
  if (issue.origin === "number" && issue.code === "too_big" && issue.maximum !== undefined)
    return `${field} must be at most ${issue.maximum}`;
  if (issue.origin === "number" && issue.code === "too_small" && issue.minimum !== undefined)
    return `${field} must be ${issue.inclusive === false ? "greater than" : "at least"} ${issue.minimum}`;
  const message = issue.message.replace(/^Invalid input: /, "");
  return field === "The request" ? message : `${field}: ${message}`;
}

/** One line per issue (identical lines once), capped, or null when `details` is not a list of issues. */
export function describeIssues(details: unknown, flagNames: Iterable<string> = []): string[] | null {
  if (!isIssueList(details)) return null;
  const flags = new Set(flagNames);
  const lines = [...new Set(details.map((issue) => describe(issue, flags)))];
  if (lines.length <= MAX_LINES) return lines;
  return [...lines.slice(0, MAX_LINES), `...and ${lines.length - MAX_LINES} more.`];
}
