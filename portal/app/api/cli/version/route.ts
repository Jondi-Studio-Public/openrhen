import { serverCommit } from "@/server/build-commit";
import { loadCliBundle } from "@/server/cli-bundle";
import { withRoute } from "@/server/logging";

/** What `rhen self-update` asks first: the portal's commit and whether it carries a CLI bundle. */
export const GET = withRoute("/api/cli/version", async () => {
  const bundle = await loadCliBundle();
  return Response.json({
    commit: serverCommit(),
    bundle: bundle ? { available: true, sha256: bundle.sha256, bytes: bundle.bytes } : { available: false }
  });
});
