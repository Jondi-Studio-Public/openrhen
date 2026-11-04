"use client";

import type { PortalState } from "@/state/portal-state";
import { Card, CardHeader } from "@/components/ui/card";
import { Count } from "@/components/ui/count";
import { List, ListRow } from "@/components/ui/list-row";
import { formatConditionList } from "@/features/now/now-formatting";
import type { NowCandidate } from "@/features/now/now-model";
import styles from "../now-page.module.css";

/**
 * Work that is ready except that nobody has said whether a required context holds. Naming the
 * missing answer is the whole point: these are not problems, they are one question each.
 */
export function NeedsAnswerList({ items, state }: { items: readonly NowCandidate[]; state: PortalState }) {
  return (
    <Card as="section" className={styles.answers} aria-label="Needs a quick answer">
      <CardHeader title="Needs a quick answer" trailing={<Count value={items.length} />} />
      <List>
        {items.slice(0, 5).map((item) => (
          <ListRow
            key={item.action.id}
            title={item.action.title}
            meta={`Waiting on ${formatConditionList(item.conditionMatch?.unknowns ?? [], state)}`}
          />
        ))}
      </List>
      <p className={styles.cardFoot}>Answer in your situation (the chips at the top) and these come back.</p>
    </Card>
  );
}
