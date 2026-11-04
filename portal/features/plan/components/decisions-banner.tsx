"use client";

import { cx } from "@/components/ui/cx";
import { useState } from "react";
import { Sheet } from "@/components/sheet";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { List, ListRow } from "@/components/ui/list-row";
import { summariseAttention, type PlanningAttentionItem } from "@/features/plan/planning-attention";
import styles from "./decisions-banner.module.css";

function WarnIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M12 3 2.5 20h19L12 3Z" />
      <path d="M12 10v4M12 17h.01" />
    </svg>
  );
}

/**
 * The things stopping the plan from being trustworthy, as one warning line counted by kind ("2
 * projects with no next step, 1 estimate to review"). "Go through them" opens every item in a sheet,
 * each a link to where it is fixed. Absent when there is nothing to decide.
 */
export function DecisionsBanner({ items }: { items: PlanningAttentionItem[] }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  const count = items.length;
  return (
    <>
      <Banner
        tone="warn"
        icon={<WarnIcon />}
        action={
          <Button size="sm" onClick={() => setOpen(true)}>
            Go through {count === 1 ? "it" : "them"}
          </Button>
        }
      >
        <b>
          {count} {count === 1 ? "decision" : "decisions"}
        </b>
        <span className={styles.summary}> · {summariseAttention(items)}</span>
      </Banner>
      <Sheet open={open} onClose={() => setOpen(false)} title="Decisions before planning">
        <List className={cx(styles.list)}>
          {items.map((item) => (
            <ListRow key={`${item.href}|${item.text}`} href={item.href} title={item.text} />
          ))}
        </List>
      </Sheet>
    </>
  );
}
