"use client";

import { dateTimeFormat, displayLocale } from "@/shared/locale";
import { useState } from "react";
import { Sheet } from "@/components/sheet";
import { Banner } from "@/components/ui/banner";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Count } from "@/components/ui/count";
import { List, ListRow } from "@/components/ui/list-row";
import styles from "../now-page.module.css";

/** One thing waiting after a break, ready to show as it is ("3 things to settle"). */
export interface WelcomeBackItem {
  key: string;
  label: string;
  count: number;
  href: string;
}

function awayLine(awaySince: string | null, timezone: string): string {
  if (!awaySince) return "Welcome back.";
  const day = dateTimeFormat(displayLocale(), {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "long"
  }).format(new Date(awaySince));
  return `Welcome back. You've been away since ${day}.`;
}

/**
 * After a break, one line above the hero ("Welcome back. 3 things to settle, 5 waiting in Inbox.")
 * whose Catch up goes straight to the first of those things (catch-up when there is one) and, when there
 * are several, whose See all opens them as rows in the order to work through them. Dismissing the
 * banner or closing the sheet marks it seen on this device. The rows and when to show them come from
 * `useWelcomeBack()`; this is only the placement on Now.
 */
export function WelcomeBackBanner({
  show,
  awaySince,
  rows,
  markSeen,
  timezone
}: {
  show: boolean;
  awaySince: string | null;
  rows: readonly WelcomeBackItem[];
  markSeen: () => void;
  timezone: string;
}) {
  const [open, setOpen] = useState(false);
  if (!show || rows.length === 0) return null;
  return (
    <>
      <Banner
        tone="info"
        stackActions
        action={
          <span className={styles.rowActions}>
            <ButtonLink size="sm" variant="secondary" href={rows[0]!.href}>
              Catch up
            </ButtonLink>
            {rows.length > 1 && (
              <Button size="sm" variant="ghost" aria-haspopup="dialog" onClick={() => setOpen(true)}>
                See all
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={markSeen}>
              Not now
            </Button>
          </span>
        }
      >
        {awayLine(awaySince, timezone)} {rows.map((row) => row.label).join(", ")}.
      </Banner>
      <Sheet
        open={open}
        onClose={() => {
          setOpen(false);
          markSeen();
        }}
        title="While you were away"
      >
        <div className={styles.sheetBody}>
          <p className={styles.sheetSub}>{awayLine(awaySince, timezone)} Work through these in order.</p>
          <Card className={styles.answers}>
            <List>
              {rows.map((row) => (
                <ListRow key={row.key} title={row.label} trailing={<Count value={row.count} />} href={row.href} />
              ))}
            </List>
          </Card>
        </div>
      </Sheet>
    </>
  );
}
