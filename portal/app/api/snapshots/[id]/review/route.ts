import { issueSnapshotReviewSchema } from "@openrhen/contracts";
import { withRoute } from "@/server/logging";
import { withIssueSnapshotStore } from "@/server/persistence/postgres/issue-snapshot-store";

/**
 * Closes a report, or reopens one closed too early.
 *
 * Deliberately separate from the capture route: this is the only write that may touch an existing
 * snapshot, and it may only touch the verdict. The captured evidence stays immutable so a closed
 * report still replays exactly as it was reported.
 */
export const POST = withRoute(
  "/api/snapshots/[id]/review",
  async (request: Request, { params }: { params: Promise<{ id: string }> }, log) => {
    const { id } = await params;
    let input: unknown = null;
    try {
      input = await request.json();
    } catch {
      /* validation below returns a safe error */
    }
    const parsed = issueSnapshotReviewSchema.safeParse(input);
    if (!parsed.success)
      return Response.json(
        { error: "The review failed validation.", issues: parsed.error.issues.slice(0, 20) },
        { status: 400 }
      );
    try {
      const snapshot = await withIssueSnapshotStore((store) => store.review(id, parsed.data));
      return snapshot
        ? Response.json({ snapshot })
        : Response.json({ error: "Issue snapshot not found." }, { status: 404 });
    } catch (error) {
      log.setError(error);
      return Response.json({ error: "The review could not be saved." }, { status: 503 });
    }
  }
);
