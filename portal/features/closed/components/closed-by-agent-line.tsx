"use client";

import { Banner } from "@/components/ui/banner";
import { ButtonLink } from "@/components/ui/button";
import { readClosedLookedAt } from "../closed-seen";
import { useClosedSummary } from "../use-closed-summary";

export const CLOSED_BY_AGENT_HREF = "/review/closed?tab=cancelled";

/**
 * "2 items closed by an agent in the last 24 hours", on Now and Today, linking to Review > Closed where each can be
 * restored. Renders nothing at zero, while loading, when the read fails, and once this device has opened the Closed
 * page since the latest such close (the page records that moment).
 */
export function ClosedByAgentLine() {
  const summary = useClosedSummary();
  // Read at render, only once the summary has arrived (client side), so the server render and the first client render agree.
  const lookedAt = summary ? readClosedLookedAt() : null;
  if (!summary || summary.agentLast24h <= 0) return null;
  if (lookedAt && summary.latestAt && Date.parse(summary.latestAt) <= Date.parse(lookedAt)) return null;
  const n = summary.agentLast24h;
  return (
    <Banner
      tone="neutral"
      action={
        <ButtonLink href={CLOSED_BY_AGENT_HREF} size="sm" variant="secondary">
          Review
        </ButtonLink>
      }
    >
      {n} {n === 1 ? "item" : "items"} closed by an agent in the last 24 hours.
    </Banner>
  );
}
