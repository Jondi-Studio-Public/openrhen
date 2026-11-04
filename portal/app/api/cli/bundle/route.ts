import { loadCliBundle } from "@/server/cli-bundle";
import { withRoute } from "@/server/logging";

/**
 * The agent CLI bundle, stamped with this portal's commit. Public by design: the build bakes in only the version,
 * commit and build time (`tools/cli/test/bundle-build.test.ts` pins that), so it holds no secret or env value.
 * `x-bundle-sha256` covers the exact bytes sent.
 */
export const GET = withRoute("/api/cli/bundle", async () => {
  const bundle = await loadCliBundle();
  if (!bundle) return Response.json({ error: "This portal has no CLI bundle." }, { status: 404 });
  return new Response(bundle.text, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "x-bundle-sha256": bundle.sha256,
      "cache-control": "no-store"
    }
  });
});
