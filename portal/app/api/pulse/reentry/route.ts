import { withRoute } from "@/server/logging";
import { reentryLook } from "@/server/pulse/reentry-look";

/**
 * The pulse and what re-entry still needs. Exempt from the agent gate,
 * since an agent whose calls are all refused still has to learn what to ask.
 */
export const GET = withRoute("/api/pulse/reentry", (request) => reentryLook(request));
