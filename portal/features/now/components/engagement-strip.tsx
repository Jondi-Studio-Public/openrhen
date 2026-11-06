"use client";

import { createClientId } from "@/shared/client-id";
import type { StoredCommitment } from "@/state/portal-state";
import { clock } from "@/features/now/now-formatting";
import type { NowOpenAnchor, RunActivityCommand } from "@/features/now/now-model";

/**
 * You are at an anchor commitment and the hour is still your own.
 *
 * This sits above the ordinary suggestion, not in place of it: the point of an anchor is that being
 * somewhere and being occupied are different things, so the page keeps offering work and offers this
 * alongside. Saying you are engaged starts a session against the commitment, which puts the ordinary
 * protected-commitment lockout back until you say you are free again.
 */
export function EngagementStrip({
  openAnchor,
  storedOpenAnchor,
  now,
  timezone,
  saving,
  runActivityCommand
}: {
  openAnchor: NowOpenAnchor;
  storedOpenAnchor: StoredCommitment | undefined;
  now: Date;
  timezone: string;
  saving: boolean;
  runActivityCommand: RunActivityCommand;
}) {
  const endsAt = new Date(openAnchor.endsAt);
  // The person said they are free of it: starting a session would put the lockout back over what they just
  // released, so the engagement button is not offered while the statement stands.
  if (storedOpenAnchor?.freedFrom)
    return (
      <section className="engagement-strip">
        <p className="microcopy">
          You’re free of <strong>{openAnchor.title}</strong>; it stays on your plan until {clock(endsAt, timezone)}.
        </p>
      </section>
    );
  return (
    <section className="engagement-strip">
      <p className="microcopy">
        You’re at <strong>{openAnchor.title}</strong> until {clock(endsAt, timezone)}. It holds the time in your plan
        either way — what’s below is for the gaps.
      </p>
      <div className="actions">
        <button
          disabled={saving}
          onClick={() =>
            void runActivityCommand({
              commandId: createClientId(),
              expectedVersion: storedOpenAnchor?.version ?? null,
              type: "start_activity",
              targetType: "fixed_commitment",
              targetId: openAnchor.id,
              phase: openAnchor.phase,
              plannedMinutes: Math.max(1, Math.round((endsAt.getTime() - now.getTime()) / 60_000))
            })
          }
        >
          I’m engaged in {openAnchor.title}
        </button>
      </div>
    </section>
  );
}
