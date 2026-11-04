"use client";

import { Banner } from "@/components/ui/banner";
import { ButtonLink } from "@/components/ui/button";

/** Where the line opens: the Agent changes list on Plan > Review, scrolled to. */
export const AGENT_CHANGES_HREF = "/review#agent-changes";

/**
 * "3 agent changes since you looked", with a way to the list (agent trust review, lane D item 3). Agents
 * write directly and the person undoes after, so Now has to say when there is something to look at.
 * Renders nothing at 0, and nothing while the welcome-back banner shows its own agent changes row (counted
 * from when the banner was last dismissed, so the two numbers can differ; one line about it is enough).
 * A device that never looked says "N agent changes", since there is no "since" yet.
 */
export function AgentChangesLine({
  count,
  neverLooked,
  coveredByWelcomeBack
}: {
  count: number;
  neverLooked: boolean;
  coveredByWelcomeBack: boolean;
}) {
  if (count <= 0 || coveredByWelcomeBack) return null;
  return (
    <Banner
      tone="neutral"
      action={
        <ButtonLink href={AGENT_CHANGES_HREF} size="sm" variant="secondary">
          Review
        </ButtonLink>
      }
    >
      {count} agent {count === 1 ? "change" : "changes"}
      {neverLooked ? " to look over." : " since you looked."}
    </Banner>
  );
}
