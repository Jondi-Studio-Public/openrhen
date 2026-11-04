"use client";

import Link from "next/link";
import type { PortalState } from "@/state/portal-state";
import { Card, CardHeader } from "@/components/ui/card";
import { List, ListRow } from "@/components/ui/list-row";
import { dayClock, directiveProjectId, projectTitle } from "@/features/now/now-formatting";
import type { UpcomingDirectives } from "@/features/now/now-model";
import styles from "../now-page.module.css";

/**
 * What the engine has queued after the current directive, in its order and never including it: one
 * row each, its time (or its place in the queue), the title, and its area and minutes underneath.
 *
 * A queued journey is a row like any other, and its `targetId` is the place it goes to rather than a
 * piece of work, so it says where and how long and leaves the rest to the travel panel when its turn
 * comes.
 *
 * A row states its day and time whenever the engine gave it one. Only the queue looking past a sleep
 * directive's wake time carries an instant, and there an item can be days out, so a row with no time
 * is one there is nothing to be ambiguous about. Otherwise the queue is an order, not a schedule: the
 * engine picks again at every step, and the plan's allocations are latest-safe proofs rather than
 * start times, so a clock time here would be invented. Those rows say "Next", then "Then".
 */
export function UpcomingStrip({ directives, state }: { directives: UpcomingDirectives; state: PortalState }) {
  return (
    <Card as="section" className={styles.answers} aria-label="Up next">
      <CardHeader
        title="Up next"
        trailing={
          <Link className={styles.headLink} href="/today">
            Whole day
          </Link>
        }
      />
      <List>
        {directives.map((item, index) => {
          // What a queued leg is for is the row after it — the engine queued them in that order — rather
          // than a second opinion formed here about what the journey achieves.
          const after = item.kind === "travel" ? directives[index + 1] : undefined;
          const project = item.kind === "travel" ? "Travel" : projectTitle(state, directiveProjectId(state, item));
          return (
            <ListRow
              key={`${item.kind}:${item.targetId}`}
              time={item.at ? dayClock(item.at, state.settings.timezone) : index === 0 ? "Next" : "Then"}
              title={`${item.title}${after ? ` · then ${after.title}` : ""}`}
              meta={[project, `${item.recommendedMinutes} min`].filter(Boolean).join(" · ")}
            />
          );
        })}
      </List>
    </Card>
  );
}
