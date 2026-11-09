import { z } from "zod";
import { ACTIVITY_SOURCE_NAMES } from "@openrhen/contracts";
import { withRoute } from "@/server/logging";
import { recordRun } from "@/server/persistence/postgres/run-log";
import { databaseUrl } from "@/server/runtime-env";

/** The sources an import run may name: the activity sources, and the Takeout watch history, which has its own store. */
const IMPORT_RUN_SOURCES: readonly string[] = [...ACTIVITY_SOURCE_NAMES, "youtube-watch-history"];

const count = z.number().int().min(0).max(1_000_000_000);
const rfc3339 = z
  .string()
  .refine(
    (value) => /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value)),
    {
      message: "must be an RFC 3339 time with its offset, such as 2026-11-09T01:00:00Z"
    }
  );

const bodySchema = z.object({
  source: z.string(),
  status: z.enum(["synced", "needs_review", "failed"]),
  startedAt: rfc3339,
  finishedAt: rfc3339,
  summary: z.object({
    file: z.string().max(300),
    events: count,
    skipped: count,
    rejected: count,
    truncated: count,
    warnings: z.array(z.string().max(200)).max(20),
    error: z.string().max(500).optional()
  })
});

/** The last path segment, whichever separator the importing machine used: a run row never holds a directory. */
function baseName(file: string): string {
  return file.split(/[\\/]/).pop() ?? file;
}

/**
 * One finished file import, reported by `rhen import-activity` after it ran. Writes an `import:<source>` row to the
 * run log with trigger `manual`, so a file that was read but brought in nothing shows as a run and not as silence.
 * Takes the capture scope (`write:activity-event`); the owner session may always call it.
 */
export const POST = withRoute("/api/activity-imports/runs", async (request) => {
  const body = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success)
    return Response.json(
      {
        error: "The run is not valid.",
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      },
      { status: 400 }
    );
  const run = parsed.data;
  if (!IMPORT_RUN_SOURCES.includes(run.source))
    return Response.json(
      { error: `source "${run.source.slice(0, 60)}" is not known. Use one of: ${IMPORT_RUN_SOURCES.join(", ")}.` },
      { status: 400 }
    );
  if (!databaseUrl()) return Response.json({ error: "The run log requires PostgreSQL." }, { status: 503 });
  const landed = await recordRun({
    provider: `import:${run.source}`,
    trigger: "manual",
    status: run.status,
    startedAt: new Date(run.startedAt),
    finishedAt: new Date(run.finishedAt),
    summary: { ...run.summary, file: baseName(run.summary.file) }
  });
  if (!landed) return Response.json({ error: "The run could not be recorded.", recorded: false }, { status: 503 });
  return Response.json({ recorded: true });
});
