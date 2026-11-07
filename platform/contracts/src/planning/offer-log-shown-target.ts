import type { NowActivityCandidateLike, NowActivityProtectedLike, NowActivityResolution } from "./now-activity.js";
import type { OfferLogShown } from "./offer-log-shown.js";

/** The offer-log body a resolution stands for, less the transport fields (`clientId`, `surface`). */
export type ShownTarget = Omit<OfferLogShown, "clientId" | "surface">;

const LABEL_MAX = 300;
const clip = (value: string | undefined | null) => (value ?? "").slice(0, LABEL_MAX);

/**
 * The one mapping from what `resolveNowActivity` decided to the offer-log `shown` target, shared by the portal's Now
 * page and the handheld route so the same state logs the same row on both. Sessions are keyed by action id
 * (`targetId ?? actionId`) and a travel leg by the commitment it leads to, exactly as the `started` rows are.
 * `suppressedBy` is the engine's primary whenever the resolution put something else on top of it; absent when the
 * primary is itself what is shown or there is none.
 */
export function shownTargetFor<C extends NowActivityCandidateLike, P extends NowActivityProtectedLike>(
  activity: NowActivityResolution<C, P>,
  primary: NowActivityCandidateLike | null | undefined
): ShownTarget {
  const suppressedBy: ShownTarget["suppressedBy"] =
    activity.kind !== "recommended" && primary
      ? { targetType: "action", targetId: primary.action.id, label: clip(primary.action.title) }
      : undefined;
  const withSuppressed = (target: ShownTarget): ShownTarget => (suppressedBy ? { ...target, suppressedBy } : target);
  switch (activity.kind) {
    case "session": {
      const { session } = activity;
      return withSuppressed({
        resolutionKind: "session",
        targetType: session.targetType ?? "action",
        targetId: session.targetId ?? session.actionId,
        label: clip(session.targetTitle)
      });
    }
    case "routine_step":
      return withSuppressed({
        resolutionKind: "routine_step",
        targetType: "routine_step",
        targetId: activity.step.id,
        label: clip(activity.step.title)
      });
    case "commitment":
      return withSuppressed({
        resolutionKind: "commitment",
        targetType: "fixed_commitment",
        targetId: activity.commitment.id,
        label: clip(activity.commitment.title)
      });
    case "travel":
      return withSuppressed({
        resolutionKind: "travel",
        // Keyed like the `started` row a travel or return phase writes (the commitment the leg leads to), so the
        // two join; a leg that names no commitment falls back to its destination.
        targetType: activity.directive.then?.kind === "commitment" ? "fixed_commitment" : "travel",
        targetId:
          activity.directive.then?.kind === "commitment"
            ? activity.directive.then.targetId
            : activity.directive.toLocationId,
        label: clip(activity.directive.title)
      });
    case "sleep":
      return withSuppressed({
        resolutionKind: "sleep",
        targetType: "sleep",
        targetId: activity.plan.id,
        label: "Sleep"
      });
    case "recommended":
      return {
        resolutionKind: "recommended",
        targetType: "action",
        targetId: activity.candidate.action.id,
        label: clip(activity.candidate.action.title)
      };
    case "free":
      return { resolutionKind: "free", targetType: "none", targetId: "free", label: "" };
  }
}
