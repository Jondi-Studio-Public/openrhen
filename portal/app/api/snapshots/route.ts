import { issueSnapshotObservationSchema } from "@openrhen/contracts";
import { withRoute } from "@/server/logging";
import { withIssueSnapshotStore } from "@/server/persistence/postgres/issue-snapshot-store";

const MAXIMUM_OBSERVATION_BYTES = 12_000_000;

export const GET = withRoute("/api/snapshots", async (_request, _context, log) => {
  try {
    return Response.json({ snapshots: await withIssueSnapshotStore((store) => store.list()) });
  } catch (error) {
    log.setError(error);
    return Response.json({ error: "Issue snapshots could not be listed." }, { status: 503 });
  }
});

export const POST = withRoute("/api/snapshots", async (request) => {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAXIMUM_OBSERVATION_BYTES)
    return Response.json({ error: "The reported observation is too large to capture." }, { status: 413 });
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAXIMUM_OBSERVATION_BYTES)
    return Response.json({ error: "The reported observation is too large to capture." }, { status: 413 });
  let input: unknown = null;
  try {
    input = JSON.parse(body);
  } catch {
    /* validation below returns a safe error */
  }
  const parsed = issueSnapshotObservationSchema.safeParse(input);
  if (!parsed.success)
    return Response.json(
      { error: "The reported observation failed validation.", issues: parsed.error.issues.slice(0, 20) },
      { status: 400 }
    );
  // A capture failure is a server fault, so it goes to the wrapper: logged with its stack, answered
  // with the generic 500 body.
  const { id, warnings } = await withIssueSnapshotStore((store) => store.capture(parsed.data));
  return Response.json({ id, warnings }, { status: 201 });
});
