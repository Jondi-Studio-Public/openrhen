type Issue = { path?: unknown; message?: unknown };

const SHOWN = 2;
/** Wrapper keys that say where a field sits in the request but mean nothing on a screen. */
const WRAPPERS = new Set(["payload", "command"]);

/** "steps.0.title" becomes "steps, item 1, title": a person counts from one and has no use for an index. */
function readablePath(path: unknown[]): string {
  const segments = path.map(String);
  while (segments.length > 1 && WRAPPERS.has(segments[0]!)) segments.shift();
  return segments.map((segment) => (/^\d+$/.test(segment) ? `item ${Number(segment) + 1}` : segment)).join(", ");
}

/**
 * The text for a refused save. Routes answer a failed schema check with a fixed sentence such as
 * "Project command validation failed." plus the zod `issues`; on its own the sentence never says which
 * field was wrong. This adds the first few issues ("name: Required") so the banner can. Anything that
 * is not an issue list leaves the sentence as it was.
 */
export function withValidationIssues(message: string, issues: unknown): string {
  if (!Array.isArray(issues) || issues.length === 0) return message;
  const lines = (issues as Issue[])
    .filter((issue): issue is Issue & { message: string } => typeof issue?.message === "string")
    .slice(0, SHOWN)
    .map((issue) => {
      const path = Array.isArray(issue.path) ? readablePath(issue.path) : "";
      return path ? `${path}: ${issue.message}` : issue.message;
    });
  if (lines.length === 0) return message;
  const more = issues.length > SHOWN ? ` (and ${issues.length - SHOWN} more)` : "";
  return `${message} ${lines.join("; ")}${more}`;
}
