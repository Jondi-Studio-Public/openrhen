"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CLOSED_TABS, type ClosedPage, type ClosedRow as Row, type ClosedTab, type CloseType } from "@openrhen/contracts";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { PlaceTabs } from "@/components/place-tabs";
import { usePortal } from "@/state/portal-provider";
import { fetchClosed } from "@/features/closed/closed-client";
import { markClosedLooked } from "@/features/closed/closed-seen";
import { TYPE_FILTER } from "@/features/closed/closed-words";
import { ClosedRow } from "@/features/closed/components/closed-row";
import { useCloseEntity } from "@/features/closed/use-close-entity";
import styles from "@/features/closed/components/closed-list.module.css";

const TAB_LABEL: Record<ClosedTab, string> = { archived: "Archived", cancelled: "Cancelled" };

function tabFromUrl(): ClosedTab {
  const tab = new URLSearchParams(window.location.search).get("tab");
  return tab === "cancelled" ? "cancelled" : "archived";
}

/**
 * Review > Closed: everything archived or cancelled, with who closed it, when and why, and a Restore on each
 * (archive-removals design, section 6). Opening it marks the closes up to now as seen on this device, which clears
 * the Now and Today badge. The list is read from the server (it is not in the portal state) and read again after any
 * restore, live update or failure, so it never keeps showing a row somebody else already brought back.
 */
export default function ClosedPageRoute() {
  const { state } = usePortal();
  const timeZone = state.settings?.timezone;
  const closer = useCloseEntity();
  const [tab, setTab] = useState<ClosedTab | null>(null);
  const [type, setType] = useState<CloseType | "">("");
  const [page, setPage] = useState<ClosedPage | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [older, setOlder] = useState(false);
  const [rowMessage, setRowMessage] = useState<{ key: string; text: string } | null>(null);
  const firstNew = useRef<HTMLLIElement | null>(null);
  const focusNew = useRef(false);
  const pageStart = useRef(-1);
  const requestId = useRef(0);

  useEffect(() => {
    setTab(tabFromUrl());
    markClosedLooked();
  }, []);

  const load = useCallback(async () => {
    if (!tab) return;
    const id = ++requestId.current;
    try {
      const next = await fetchClosed({ tab, ...(type ? { type } : {}) });
      if (id !== requestId.current) return;
      setPage(next);
      setLoadFailed(false);
    } catch {
      if (id !== requestId.current) return;
      setLoadFailed(true);
    }
  }, [tab, type]);

  // Re-read on a tab or filter change, and whenever the portal state changes (a restore here, a live update).
  useEffect(() => {
    void load();
  }, [load, state]);

  function chooseTab(next: ClosedTab) {
    setPage(null);
    pageStart.current = -1;
    setTab(next);
    setRowMessage(null);
    window.history.replaceState(null, "", `${window.location.pathname}?tab=${next}`);
  }

  async function restore(row: Row, includeChildren: boolean) {
    setRowMessage(null);
    const outcome = await closer.restore(
      { type: row.type, id: row.id, title: row.title, restoreVerb: row.restoreVerb, version: row.version },
      { includeChildren }
    );
    if (!outcome.ok && !("busy" in outcome)) {
      // Whatever the server said, the list is the truth: read it again instead of repeating a sentence about a
      // version the person cannot see.
      setRowMessage({
        key: `${row.type}:${row.id}`,
        text: "That item changed, so the list was refreshed. Check it and try again."
      });
    }
    await load();
  }

  async function showOlder() {
    if (!tab || !page?.nextCursor) return;
    setOlder(true);
    try {
      const next = await fetchClosed({ tab, ...(type ? { type } : {}), before: page.nextCursor });
      focusNew.current = true;
      pageStart.current = page.rows.length;
      setPage({ ...next, rows: [...page.rows, ...next.rows] });
    } catch {
      setLoadFailed(true);
    } finally {
      setOlder(false);
    }
  }

  useEffect(() => {
    if (focusNew.current && firstNew.current) {
      firstNew.current.focus();
      focusNew.current = false;
    }
  }, [page]);

  const counts = page?.counts;
  const total = counts ? counts.archived + counts.cancelled : 0;

  return (
    <main className={`content-page ${styles.page}`}>
      <PageHeader
        title="Closed"
        answer="Everything archived or cancelled. Restore anything that should be open again."
        actions={<Link href="/review">Weekly review</Link>}
      />
      <PlaceTabs />
      {loadFailed && (
        <Banner
          tone="danger"
          action={
            <Button size="sm" variant="secondary" onClick={() => void load()}>
              Try again
            </Button>
          }
        >
          The closed list could not be read.
        </Banner>
      )}
      <div role="tablist" aria-label="Closed items" className={styles.tablist}>
        {CLOSED_TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={`closed-tab-${name}`}
            aria-selected={tab === name}
            aria-controls="closed-panel"
            className={styles.tab}
            onClick={() => chooseTab(name)}
          >
            {TAB_LABEL[name]}
            {counts ? ` (${counts[name]})` : ""}
          </button>
        ))}
      </div>
      <div className={styles.filter}>
        <label htmlFor="closed-type">Show</label>
        <select
          id="closed-type"
          value={type}
          onChange={(event) => {
            setPage(null);
            pageStart.current = -1;
            setType(event.target.value as CloseType | "");
          }}
        >
          <option value="">All types</option>
          {TYPE_FILTER.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <section id="closed-panel" role="tabpanel" aria-labelledby={tab ? `closed-tab-${tab}` : undefined}>
        {!page && !loadFailed ? (
          <p role="status">Loading…</p>
        ) : page && page.rows.length === 0 ? (
          <EmptyState
            title={
              total === 0
                ? "Nothing has been archived or cancelled."
                : type
                  ? "Nothing of that type here."
                  : `Nothing is ${tab === "cancelled" ? "cancelled" : "archived"}.`
            }
            body={total === 0 ? "When you archive or cancel something, it will be listed here." : undefined}
          />
        ) : page ? (
          <>
            <ul className={styles.list}>
              {page.rows.map((row, index) => (
                <ClosedRow
                  key={`${row.type}:${row.id}`}
                  row={row}
                  timeZone={timeZone}
                  busy={closer.busy}
                  message={rowMessage?.key === `${row.type}:${row.id}` ? rowMessage.text : undefined}
                  rowRef={index === pageStart.current ? (element) => (firstNew.current = element) : undefined}
                  onRestore={(target, withChildren) => void restore(target, withChildren)}
                  onOpenBlocker={chooseTab}
                />
              ))}
            </ul>
            {page.nextCursor && (
              <Button variant="secondary" disabled={older} onClick={() => void showOlder()}>
                {older ? "Loading…" : "Show older"}
              </Button>
            )}
          </>
        ) : null}
      </section>
    </main>
  );
}
