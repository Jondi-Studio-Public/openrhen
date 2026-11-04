"use client";

import type { PortalState } from "@/state/portal-state";
import { formatConditionList, travelSourceLabel } from "@/features/now/now-formatting";
import type { NowCandidate } from "@/features/now/now-model";
import { Card, CardHeader } from "@/components/ui/card";
import { Count } from "@/components/ui/count";
import { List, ListRow } from "@/components/ui/list-row";
import styles from "../now-page.module.css";

/** Why the engine will not direct a journey to this work at this moment, in its own terms. */
function refusal(reason: NonNullable<NowCandidate["tripReason"]>): string {
  return reason === "no_mode" ? "no way to travel there" : "nothing would fit once you arrived";
}

/**
 * Work that does not fit where the person is.
 *
 * The engine has already divided it: a candidate carrying a costed journey is one it would send you
 * on and merely ranked below whatever leads, and one carrying a refusal is one it will not send you
 * on at all. Those are different answers to the reader — "not yet" against "not now" — so they are
 * different lists, and the refusal says which of the two reasons applies rather than leaving it to
 * be guessed. Nothing here recomputes a journey; every minute shown is the engine's.
 */
export function ReachableList({
  worthTheTrip,
  notWorthTheTrip,
  state
}: {
  worthTheTrip: readonly NowCandidate[];
  notWorthTheTrip: readonly NowCandidate[];
  state: PortalState;
}) {
  return (
    <>
      {worthTheTrip.length > 0 && (
        <Card as="section" className={styles.answers} aria-label="Worth the trip">
          <CardHeader title="Worth the trip" trailing={<Count value={worthTheTrip.length} />} />
          <List>
            {worthTheTrip.map((item) => {
              const trip = item.trip!;
              return (
                <ListRow
                  key={item.action.id}
                  title={item.action.title}
                  meta={
                    <>
                      {formatConditionList([trip.toLocationId], state)} · {trip.travelMinutes} min there (
                      {travelSourceLabel(trip.source)})
                      {item.recommendedMinutes ? ` · ${item.recommendedMinutes} min once you are there` : ""}
                      <br />
                      {trip.avoidableMinutes > 0
                        ? `Going later would save ${trip.avoidableMinutes} min of travel.`
                        : "You won't be near there again today."}
                    </>
                  }
                />
              );
            })}
          </List>
        </Card>
      )}
      {notWorthTheTrip.length > 0 && (
        <Card as="section" className={styles.answers} aria-label="Elsewhere">
          <CardHeader
            title={
              notWorthTheTrip.some((item) => item.tripReason) ? "Not worth it right now" : "Possible if you travel"
            }
            trailing={<Count value={notWorthTheTrip.length} />}
          />
          <List>
            {notWorthTheTrip.map((item) => {
              const reach = item.conditionMatch?.reachableVia;
              // With no way of travelling there is no journey to quote, so the place itself is the most
              // that can be said: the one requirement the situation does not meet.
              const missing = item.conditionMatch?.missing ?? [];
              return (
                <ListRow
                  key={item.action.id}
                  title={item.action.title}
                  meta={`${
                    reach
                      ? `${formatConditionList([reach.locationId], state)} · about ${reach.travelMinutes} minutes away`
                      : missing.length
                        ? formatConditionList(missing, state)
                        : "Somewhere else"
                  }${item.tripReason ? ` · ${refusal(item.tripReason)}` : ""}`}
                />
              );
            })}
          </List>
        </Card>
      )}
    </>
  );
}
