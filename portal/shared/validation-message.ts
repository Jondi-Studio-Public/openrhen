type Issue = { path?: unknown; message?: unknown };

const SHOWN = 2;

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
      const path = Array.isArray(issue.path) ? issue.path.map(String).join(".") : "";
      return path ? `${path}: ${issue.message}` : issue.message;
    });
  if (lines.length === 0) return message;
  const more = issues.length > SHOWN ? ` (and ${issues.length - SHOWN} more)` : "";
  return `${message} ${lines.join("; ")}${more}`;
}
