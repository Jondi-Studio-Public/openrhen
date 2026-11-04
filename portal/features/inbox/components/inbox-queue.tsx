"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { List, ListRow } from "@/components/ui/list-row";
import { PageHeader } from "@/components/ui/page-header";
import { RecentlyHandled } from "@/components/recently-handled";
import { ImportHistoryList } from "@/features/imports/components/import-history-list";
import { ImportStatusBanners } from "@/features/imports/components/import-status-banners";
import { handledAgentRows, useAgentProposals } from "@/features/agent-proposals/agent-proposals-store";
import { LINK_KIND_LABELS, bulkConfirmGroups } from "@/features/plan-map/plan-map-model";
import { newestFirst, type HandledRow } from "@/shared/recently-handled";
import { useNow } from "@/shared/clock";
import { useInbox } from "../inbox-provider";
import { entriesFor, oldestLabel, staleEntries, type QueueEntry } from "../queue";
import { filterHref, inboxBadge, visibleRooms, type InboxFilter } from "../rooms";
import { useRecentlyHandled, useRecentlyReplaced } from "../use-recently-handled";
import { AddSheet } from "./add-sheet";
import { QueueDetail } from "./queue-detail";
import { ReplacedList } from "./replaced-list";
import styles from "./inbox-queue.module.css";

/** What the head of the page says: how many things wait, and the promise that nothing moves without you. */
export function inboxAnswer(waiting: number, oldest: string | null = null): string {
  if (waiting === 0) return "Nothing to decide. Nothing changes your plan until you say so.";
  const age = oldest ? `, ${oldest}` : "";
  return `${waiting} ${waiting === 1 ? "thing" : "things"} to decide${age}. Nothing changes your plan until you say so.`;
}

const EMPTY: Record<InboxFilter, { title: string; body: string }> = {
  all: {
    title: "Nothing to decide",
    body: "Emails, notes from people and things you capture wait here until you decide."
  },
  emails: { title: "No email changes", body: "Changes worked out from your email wait here, one per thread." },
  people: {
    title: "Nothing from people",
    body: "Notes and requests from the people who can add to your diary land here."
  },
  captured: {
    title: "Nothing captured",
    body: "Thoughts you capture and writes agents propose wait here to be sorted."
  },
  calendar: { title: "No calendar events to review", body: "New events and conflicts from your calendars wait here." },
  map: { title: "No links or findings", body: "Suggested links between plan items and plan findings wait here." },
  kept: {
    title: "Nothing kept for later",
    body: "Things you file as someday or reference stay here until you want them."
  }
};

/** The records a decision on this entry names, as the Inbox's decisions track them. */
function entryIds(entry: QueueEntry): string[] {
  switch (entry.kind) {
    case "email":
      return entry.items.map((item) => item.id);
    case "capture":
    case "kept":
      return [entry.item.id];
    case "link":
      return [entry.link.id];
    case "finding":
      return [entry.finding.id];
    default:
      // Agent proposals, notes from other people and batches hold their own busy state on their buttons.
      return [];
  }
}

/** A key press the queue answers to, unless the person is typing or holding a modifier. */
function queueKey(event: KeyboardEvent): "next" | "previous" | "yes" | "no" | null {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return null;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest("input, textarea, select, [contenteditable='true'], [role='dialog'], dialog")) return null;
  switch (event.key.toLowerCase()) {
    case "j":
      return "next";
    case "k":
      return "previous";
    case "y":
      return "yes";
    case "n":
      return "no";
    default:
      return null;
  }
}

function Progress({ index, total }: { index: number; total: number }) {
  // Segments read at a glance up to a dozen; past that one bar says how far through you are.
  if (total > 12)
    return (
      <span className={styles.bar} aria-hidden="true">
        <i style={{ width: `${((index + 1) / total) * 100}%` }} />
      </span>
    );
  return (
    <span className={styles.segments} aria-hidden="true" style={{ gridTemplateColumns: `repeat(${total}, 1fr)` }}>
      {Array.from({ length: total }, (_, at) => (
        <i key={at} data-state={at < index ? "done" : at === index ? "now" : "next"} />
      ))}
    </span>
  );
}

interface DockedAction {
  label: string;
  disabled: boolean;
  /** The reason the original gives for being disabled, which stays visible in the card. */
  describedBy: string | null;
  /** "quiet" when the original is deliberately not the primary action (a risky agent change). */
  weight: string | null;
}

/** The detail's main and ignore buttons as they stand now, read from the same marks Y and N use. */
function readActions(root: HTMLElement | null): { yes: DockedAction | null; no: DockedAction | null } {
  const read = (key: "yes" | "no") => {
    const button = root?.querySelector<HTMLButtonElement>(`[data-inbox-action="${key}"]`);
    return button
      ? {
          label: button.textContent?.trim() || key,
          disabled: button.disabled,
          describedBy: button.getAttribute("aria-describedby"),
          weight: button.getAttribute("data-inbox-weight")
        }
      : null;
  };
  return { yes: read("yes"), no: read("no") };
}

/**
 * A phone's decision bar, docked above the tab bar so the choice is always under the thumb, however
 * long the card. It holds no logic of its own: its buttons press the detail's own main and ignore
 * buttons (the ones Y and N press), which the phone hides in the card, and it follows their labels and
 * whether they are enabled as the detail changes.
 */
function DockedActions({ detail, deciding }: { detail: RefObject<HTMLElement | null>; deciding: boolean }) {
  const [actions, setActions] = useState(() => readActions(null));
  // One press per frame: two clicks in the same tick would otherwise both reach the original
  // before its decision has disabled it.
  const pressing = useRef(false);
  useEffect(() => {
    const root = detail.current;
    if (!root) return;
    const update = () =>
      setActions((current) => {
        const next = readActions(root);
        return JSON.stringify(next) === JSON.stringify(current) ? current : next;
      });
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    return () => observer.disconnect();
  }, [detail]);
  if (!actions.yes && !actions.no) return null;
  const press = (key: "yes" | "no") => {
    if (pressing.current) return;
    pressing.current = true;
    requestAnimationFrame(() => (pressing.current = false));
    detail.current?.querySelector<HTMLButtonElement>(`[data-inbox-action="${key}"]:not(:disabled)`)?.click();
  };
  return (
    <div className={styles.dock} role="group" aria-label="Decide" data-docked-actions="">
      {actions.no && (
        <Button
          variant="secondary"
          size="lg"
          disabled={deciding || actions.no.disabled}
          aria-describedby={actions.no.describedBy ?? undefined}
          onClick={() => press("no")}
        >
          {actions.no.label}
        </Button>
      )}
      {actions.yes && (
        <Button
          variant={actions.yes.weight === "quiet" ? "secondary" : "primary"}
          size="lg"
          disabled={deciding || actions.yes.disabled}
          aria-describedby={actions.yes.describedBy ?? undefined}
          onClick={() => press("yes")}
        >
          {actions.yes.label}
        </Button>
      )}
    </div>
  );
}

/**
 * The Inbox: one queue of everything that waits, with a chip per room to narrow it. A desk lists the
 * queue on the left and decides the chosen item on the right; a phone shows one card at a time, with
 * the list a tap away. J and K move, Y takes the item's main action, N ignores it. Chips are
 * addresses (`/inbox/emails` and so on), so the old room links open the queue filtered.
 */
export function InboxQueue({ filter }: { filter: InboxFilter }) {
  const { desk, queue, counts, emailCount, imports, planMap, decisions } = useInbox();
  const router = useRouter();
  const entries = entriesFor(queue, filter);
  const now = useNow("minute");
  const oldest = oldestLabel(entries, now);
  const waiting = inboxBadge(counts);
  const [chosen, setChosen] = useState<string | null>(null);
  const [phoneList, setPhoneList] = useState(false);
  const lastIndex = useRef(0);
  const detail = useRef<HTMLElement>(null);

  // The chosen entry, or, once it has been decided and left, the one that moved into its place.
  const found = entries.findIndex((entry) => entry.key === chosen);
  const index = entries.length === 0 ? -1 : found >= 0 ? found : Math.min(lastIndex.current, entries.length - 1);
  const selected: QueueEntry | null = index >= 0 ? entries[index]! : null;
  const selectedKey = selected?.key ?? null;
  // Keys that have been listed, so a chosen key that is missing can be told apart: one that left
  // (decided) gives way to what moved into its place; one not yet arrived is waited for.
  const seen = useRef(new Set<string>());
  for (const entry of entries) seen.current.add(entry.key);
  const arrived = useRef(false);
  useEffect(() => {
    if (index >= 0) lastIndex.current = index;
    // An item named in the address (`?item=capture:<id>`, from Review again) is chosen on arrival,
    // even before it has reached the list.
    if (!arrived.current) {
      arrived.current = true;
      const item = new URLSearchParams(window.location.search).get("item");
      if (item) return setChosen(item);
    }
    // A decided item gives way to the one that moved into its place, which is then held.
    if (selectedKey && found < 0 && chosen !== null && seen.current.has(chosen)) setChosen(selectedKey);
  }, [index, selectedKey, chosen, found]);
  // Until the person touches the item on screen the queue opens on its first entry, so items that load
  // late (an agent's proposals) still lead it. Once they do, it is held: an item arriving above it never
  // swaps the detail under them.
  const hold = () => {
    if (chosen === null && selectedKey) setChosen(selectedKey);
  };

  const { proposals, openBatch } = useInbox();
  // Choosing a capture opens it for review; choosing a held batch opens its review. Keyed on the
  // entry, so moving past an item opens the next rather than reopening one the person closed.
  useEffect(() => {
    if (!selected) return;
    if (selected.kind === "capture" && proposals.reviewingId !== selected.item.id) proposals.beginReview(selected.item);
    if (selected.kind === "calendar" && imports.batch?.id !== selected.batchId) openBatch(selected.batchId);
    if (selected.kind === "import" && imports.batch?.id !== selected.batch.id) openBatch(selected.batch.id);
    // Only when the selection moves; the review state it reads changes as a result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  const move = (step: number) => {
    if (!entries.length) return;
    const next = Math.max(0, Math.min(entries.length - 1, index + step));
    setChosen(entries[next]!.key);
  };

  // While the selected item's decision runs, its buttons stand down, so a second key press (or a
  // held key) cannot decide it again, or decide it the other way.
  const deciding =
    selected !== null && entryIds(selected).some((id) => decisions.leaving.has(id) || decisions.hidden.has(id));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = queueKey(event);
      if (!key || event.repeat) return;
      if (key === "next" || key === "previous") {
        event.preventDefault();
        move(key === "next" ? 1 : -1);
        return;
      }
      if (deciding) return;
      hold();
      const button = detail.current?.querySelector<HTMLButtonElement>(`[data-inbox-action="${key}"]:not(:disabled)`);
      if (!button) return;
      event.preventDefault();
      // A quiet-weighted yes is a risky change (settings, the time zone): Y only moves to the button, and
      // Enter or a click on it confirms.
      if (key === "yes" && button.dataset.inboxWeight === "quiet") button.focus();
      else button.click();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const choose = (filterTo: InboxFilter) => {
    setChosen(null);
    lastIndex.current = 0;
    router.replace(filterHref(filterTo), { scroll: false });
  };

  const chips = (
    <div className={styles.chips} role="group" aria-label="Show">
      <Chip pressed={filter === "all"} onClick={() => choose("all")}>
        All <span className={styles.chipCount}>{waiting}</span>
      </Chip>
      {visibleRooms().map((room) => (
        <Chip key={room.id} pressed={filter === room.id} onClick={() => choose(room.id)}>
          {room.label}
          {room.badged && <span className={styles.chipCount}>{counts[room.id]}</span>}
        </Chip>
      ))}
    </div>
  );

  const list = (
    <Card as="section" aria-label="Waiting" className={styles.list}>
      {entries.length ? (
        <List>
          {entries.map((entry) => (
            <ListRow
              key={entry.key}
              className={styles.row}
              current={desk && entry.key === selected?.key}
              title={entry.title}
              meta={entry.meta}
              trailing={
                <Badge tone={entry.tag.tone} dot={false}>
                  {entry.tag.label}
                </Badge>
              }
              onClick={() => {
                setChosen(entry.key);
                setPhoneList(false);
              }}
            />
          ))}
        </List>
      ) : (
        <EmptyState title={EMPTY[filter].title} body={EMPTY[filter].body} />
      )}
      <ListFoot filter={filter} stale={staleEntries(entries, now)} />
    </Card>
  );

  const detailCard = selected && (
    <Card
      as="section"
      padded
      aria-label="Selected"
      onPointerDownCapture={hold}
      onFocusCapture={hold}
      aria-busy={deciding || undefined}
      inert={deciding || undefined}
      className={desk ? styles.detail : `${styles.detail} ${styles.docked}`}
      ref={detail}
    >
      <QueueDetail key={selected.key} entry={selected} />
    </Card>
  );

  const waitingNote =
    (filter === "all" || filter === "emails") && emailCount.waiting > 0 ? (
      <p className={styles.caption}>
        {emailCount.waiting === 1 ? "1 email thread is" : `${emailCount.waiting} email threads are`} waiting for the
        desktop model. Changes appear here once it has read {emailCount.waiting === 1 ? "it" : "them"}.
      </p>
    ) : null;

  return (
    <div className={styles.page}>
      <PageHeader title="Inbox" answer={inboxAnswer(waiting, oldest)} actions={<AddSheet />} />
      {(desk || phoneList || !selected) && chips}
      {waitingNote}
      {filter === "calendar" && <ImportStatusBanners {...imports.queueStatus} />}
      {(filter === "calendar" || filter === "all") && imports.queueError && (
        <p className="form-error" role="alert">
          {imports.queueError}
        </p>
      )}
      {filter === "calendar" && !imports.queueLoaded && !imports.queueError && (
        <p className={styles.caption}>Loading held imports…</p>
      )}
      {planMap.status === "error" && (filter === "all" || filter === "map") && (
        <p className="form-error" role="alert">
          {planMap.error || "Links and findings could not be loaded."}{" "}
          <Button variant="ghost" size="sm" onClick={() => void planMap.reload()}>
            Try again
          </Button>
        </p>
      )}
      {planMap.actionError && (
        <p className="form-error" role="alert">
          {planMap.actionError}
        </p>
      )}
      {desk ? (
        <div className={styles.split}>
          {list}
          {detailCard}
        </div>
      ) : phoneList || !selected ? (
        <>
          {list}
          {selected && (
            <Button variant="secondary" block onClick={() => setPhoneList(false)}>
              One at a time
            </Button>
          )}
        </>
      ) : (
        <>
          <div className={styles.progress}>
            <IconButton label="Previous" disabled={index <= 0} onClick={() => move(-1)}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <path d="M10 3 5 8l5 5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </IconButton>
            <Progress index={index} total={entries.length} />
            <span className={styles.caption}>
              {index + 1} of {entries.length}
            </span>
            <IconButton label="Next" disabled={index >= entries.length - 1} onClick={() => move(1)}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <path d="m6 3 5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </IconButton>
            <Button variant="ghost" size="sm" onClick={() => setPhoneList(true)}>
              List
            </Button>
          </div>
          {detailCard}
          <DockedActions key={selected.key} detail={detail} deciding={deciding} />
        </>
      )}
      <Handled filter={filter} />
    </div>
  );
}

/** Under the list: the keys on a desk, and Links' confirm-many buttons. */
function ListFoot({ filter, stale }: { filter: InboxFilter; stale: readonly QueueEntry[] }) {
  const { desk, planMap, ignore } = useInbox();
  // One sweep at a time: a second press during the exit animation would start a second pass.
  const sweeping = useRef(false);
  const [sweepBusy, setSweepBusy] = useState(false);
  const sweepAll = async (ids: string[]) => {
    if (sweeping.current) return;
    sweeping.current = true;
    setSweepBusy(true);
    try {
      await ignore(ids);
    } finally {
      sweeping.current = false;
      setSweepBusy(false);
    }
  };
  const bulk = filter === "map" && planMap.map ? bulkConfirmGroups(planMap.map.links) : [];
  const sweep = filter === "all" || filter === "emails" || filter === "captured" ? stale : [];
  if (!desk && !bulk.length && !sweep.length) return null;
  return (
    <div className={styles.foot}>
      {sweep.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className={styles.sweep}
          disabled={sweepBusy}
          onClick={() => void sweepAll(sweep.flatMap(entryIds))}
        >
          {`Ignore everything older than 2 weeks (${sweep.length})`}
        </Button>
      )}
      {bulk.map((group) => (
        <Button
          key={`${group.proposer}:${group.kind}`}
          variant="ghost"
          size="sm"
          disabled={planMap.busy}
          onClick={() => void planMap.bulkConfirm(group.proposer, group.kind)}
        >
          {`Confirm all ${group.count} "${LINK_KIND_LABELS[group.kind]}" from ${group.proposer}`}
        </Button>
      ))}
      {desk && <p className={styles.caption}>Use J and K to move, Y to take the main action, N to ignore.</p>}
    </div>
  );
}

/** The foot of the page: what was decided under this chip in the last seven days. */
function Handled({ filter }: { filter: InboxFilter }) {
  const { proposals, imports, planMap, openBatch } = useInbox();
  const handled = useRecentlyHandled();
  const replaced = useRecentlyReplaced();
  const agentProposals = useAgentProposals();
  const now = useNow("minute");
  const agents = handledAgentRows(agentProposals, now.getTime());
  const rows: Record<InboxFilter, readonly HandledRow[]> = {
    all: newestFirst([...handled.emails, ...handled.captured, ...handled.kept, ...agents, ...planMap.handled]),
    emails: handled.emails,
    people: [],
    captured: newestFirst([...handled.captured, ...agents]),
    calendar: [],
    map: planMap.handled,
    kept: handled.kept
  };
  return (
    <div className={styles.handled}>
      {(filter === "all" || filter === "emails") && (
        <ReplacedList rows={replaced} error={proposals.replacedError} onRestore={proposals.restore} />
      )}
      {filter === "calendar" ? (
        <ImportHistoryList
          history={imports.history}
          selectedId={imports.batch?.id ?? null}
          busy={imports.busy}
          onOpen={openBatch}
        />
      ) : filter !== "people" ? (
        <RecentlyHandled rows={rows[filter]} />
      ) : null}
    </div>
  );
}
