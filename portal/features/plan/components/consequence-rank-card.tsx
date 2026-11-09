"use client";

import { localDateOf, type ConsequenceGroupView } from "@openrhen/contracts";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { cx } from "@/components/ui/cx";
import { EmptyState } from "@/components/ui/empty-state";
import { readNow } from "@/shared/clock";
import { createClientId } from "@/shared/client-id";
import { usePortal } from "@/state/portal-provider";
import { fetchNextGroup, postAnswer } from "../consequence-rank-client";
import {
  DAILY_GROUPS,
  addAnswer,
  answeredOn,
  answeredThisWeek,
  dropIndex,
  groupHeading,
  itemContext,
  moveItem,
  pausedForToday,
  poolNoun,
  positionLabel,
  progressLine,
  rankCommand,
  readAnswerLog,
  skipCommand,
  starsText,
  tieCommand,
  writeAnswerLog,
  type AnswerLog
} from "../consequence-rank-model";
import styles from "./consequence-rank-card.module.css";

type Phase = "idle" | "loading" | "group" | "empty" | "loadError" | "paused";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * "Rank these four": the optional comparison that sharpens how same-star projects (or one project's actions) order.
 * It stays closed until opened, because reading the next group records it as issued. The person puts the items best
 * first by dragging, or with the Move up and Move down buttons (which work from the keyboard and on a phone), then
 * sends the order, says the items are equal, or skips. Nothing is required: with nothing answered, ranking is
 * unchanged. The server derives that this is the person's own answer and refits and recalculates, which the portal
 * picks up through its normal state push. A soft "a few more" prompt follows the third group of the day.
 */
export function ConsequenceRankCard() {
  const { state } = usePortal();
  const timezone = state.settings.timezone;
  const [phase, setPhase] = useState<Phase>("idle");
  const [group, setGroup] = useState<ConsequenceGroupView | null>(null);
  const [order, setOrder] = useState<ConsequenceGroupView["items"]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [log, setLog] = useState<AnswerLog>(() => readAnswerLog(storage()));
  const [more, setMore] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const commandId = useRef(createClientId());
  const rows = useRef(new Map<string, HTMLLIElement>());
  const focusAfter = useRef<{ id: string; direction: "up" | "down" } | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
  // The order as last set, readable by a pointer event that arrives before React has re-rendered.
  const latest = useRef<ConsequenceGroupView["items"]>([]);

  const today = localDateOf(readNow(), timezone);
  const doneToday = answeredOn(log, today);
  const week = answeredThisWeek(log, today);

  const load = useCallback(async () => {
    setPhase("loading");
    setError("");
    try {
      const next = await fetchNextGroup();
      commandId.current = createClientId();
      if (!next) {
        setGroup(null);
        setPhase("empty");
        return;
      }
      setGroup(next);
      latest.current = next.items;
      setOrder(next.items);
      setPhase("group");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The next group could not be loaded.");
      setPhase("loadError");
    }
  }, []);

  const open = () => {
    if (pausedForToday(doneToday, more)) setPhase("paused");
    else void load();
  };

  useEffect(() => {
    const target = focusAfter.current;
    if (!target) return;
    focusAfter.current = null;
    const row = rows.current.get(target.id);
    const preferred = row?.querySelector<HTMLButtonElement>(`[data-move="${target.direction}"]:not(:disabled)`);
    const other = row?.querySelector<HTMLButtonElement>("[data-move]:not(:disabled)");
    (preferred ?? other)?.focus();
  }, [order]);

  const reorder = (from: number, to: number, direction?: "up" | "down") => {
    const current = latest.current;
    const moved = current[from];
    if (!moved) return;
    const next = moveItem(current, from, to);
    const landed = next.findIndex((item) => item.id === moved.id);
    if (landed === from) return;
    commandId.current = createClientId();
    if (direction) focusAfter.current = { id: moved.id, direction };
    latest.current = next;
    setOrder(next);
    setAnnouncement(positionLabel(moved.title, landed, next.length));
  };

  const startDrag = (event: ReactPointerEvent<HTMLElement>, id: string) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(id);
  };
  const dragOver = (event: ReactPointerEvent<HTMLElement>) => {
    if (!dragging) return;
    const current = latest.current;
    const midpoints = current.map((item) => {
      const box = rows.current.get(item.id)?.getBoundingClientRect();
      return box ? box.top + box.height / 2 : 0;
    });
    // Compare against the other rows' centres, so the dragged row swaps as its pointer crosses a neighbour.
    const from = current.findIndex((item) => item.id === dragging);
    const others = midpoints.filter((_, index) => index !== from);
    reorder(from, dropIndex(others, event.clientY));
  };
  const endDrag = () => setDragging(null);

  const finish = (message: string, counted: boolean) => {
    setConfirmation(message);
    if (counted) {
      const next = addAnswer(log, today);
      setLog(next);
      writeAnswerLog(storage(), next);
      if (pausedForToday(answeredOn(next, today), more)) {
        setGroup(null);
        setPhase("paused");
        return;
      }
    }
    void load();
  };

  const send = async (kind: "rank" | "tie" | "skip") => {
    if (!group || busy) return;
    setBusy(true);
    setError("");
    try {
      const id = commandId.current;
      await postAnswer(
        kind === "rank"
          ? rankCommand(group, order, id)
          : kind === "tie"
            ? tieCommand(group, id)
            : skipCommand(group, id)
      );
      setBusy(false);
      finish(
        kind === "rank"
          ? "Saved. Your plan is recalculating with that order."
          : kind === "tie"
            ? "Saved as equal. Nothing moves because of it."
            : "Skipped. That group will not come back for a while.",
        kind !== "skip"
      );
    } catch (failure) {
      setBusy(false);
      setError(failure instanceof Error ? failure.message : "The answer was not saved.");
    }
  };

  return (
    <Card as="section" aria-labelledby="rank-card-title">
      <CardHeader
        title={<span id="rank-card-title">{phase === "group" && group ? groupHeading(group) : "Rank these four"}</span>}
        trailing={
          phase === "idle" ? (
            <Button size="sm" onClick={open}>
              Start
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setPhase("idle")}>
              Close
            </Button>
          )
        }
      />
      <div className={styles.body}>
        {phase === "idle" && (
          <p className={styles.lead}>
            Four at a time, say which matters most. It only sharpens the order between items with the same stars, and
            you can stop whenever you like.
          </p>
        )}
        {phase === "loading" && (
          <p className={styles.lead} role="status">
            Loading the next group…
          </p>
        )}
        {phase === "loadError" && (
          <>
            <p className="form-error" role="alert">
              {error}
            </p>
            <div className={styles.actions}>
              <Button onClick={() => void load()}>Try again</Button>
            </div>
          </>
        )}
        {phase === "empty" && (
          <EmptyState
            title="Nothing to rank right now"
            body="A group needs at least two active projects (or two actions in one project) to compare, and each pair is only asked once every 30 days. Add more projects or actions, or come back later."
          />
        )}
        {phase === "paused" && (
          <>
            <p className={styles.lead}>
              {doneToday >= DAILY_GROUPS
                ? `That is ${doneToday} for today, which is plenty.`
                : "You have answered enough for today."}{" "}
              Another time is fine.
            </p>
            <div className={styles.actions}>
              <Button
                onClick={() => {
                  setMore(true);
                  void load();
                }}
              >
                A few more
              </Button>
            </div>
          </>
        )}
        {phase === "group" && group && (
          <>
            <h3 className={styles.question}>{group.question}</h3>
            <p className={styles.lead} id="rank-hint">
              Drag the {poolNoun(group)} into order, or use Move up and Move down, with the best at the top.
            </p>
            <ol className={styles.list} aria-labelledby="rank-hint" ref={listRef}>
              {order.map((item, index) => {
                const context = itemContext(group, item, state);
                return (
                  <li
                    key={item.id}
                    ref={(node) => {
                      if (node) rows.current.set(item.id, node);
                      else rows.current.delete(item.id);
                    }}
                    className={cx(styles.row, dragging === item.id && styles.dragging)}
                  >
                    <span
                      className={styles.grip}
                      aria-hidden="true"
                      onPointerDown={(event) => startDrag(event, item.id)}
                      onPointerMove={dragOver}
                      onPointerUp={endDrag}
                      onPointerCancel={endDrag}
                    >
                      ⋮⋮
                    </span>
                    <span className={styles.rank} aria-hidden="true">
                      {index + 1}
                    </span>
                    <span className={styles.text}>
                      <span className={styles.title}>{item.title}</span>
                      <span className={styles.meta}>
                        <span role="img" aria-label={`${item.stars} of 5 stars`}>
                          {starsText(item.stars)}
                        </span>
                        {context.parent ? ` · ${group.pool === "action" ? "in" : "under"} ${context.parent}` : ""}
                      </span>
                    </span>
                    <span className={styles.moves}>
                      <Button
                        size="sm"
                        data-move="up"
                        aria-label={`Move ${item.title} up`}
                        disabled={index === 0 || busy}
                        onClick={() => reorder(index, index - 1, "up")}
                      >
                        ↑
                      </Button>
                      <Button
                        size="sm"
                        data-move="down"
                        aria-label={`Move ${item.title} down`}
                        disabled={index === order.length - 1 || busy}
                        onClick={() => reorder(index, index + 1, "down")}
                      >
                        ↓
                      </Button>
                    </span>
                  </li>
                );
              })}
            </ol>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className={styles.actions}>
              <Button variant="primary" disabled={busy} onClick={() => void send("rank")}>
                Submit order
              </Button>
              <Button disabled={busy} onClick={() => void send("tie")}>
                These are equal / can’t decide
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => void send("skip")}>
                Skip
              </Button>
              {error && (
                <Button variant="ghost" disabled={busy} onClick={() => void load()}>
                  Load the waiting group
                </Button>
              )}
            </div>
          </>
        )}
        {confirmation && phase !== "idle" && (
          <p className={styles.confirm} role="status">
            {confirmation}
          </p>
        )}
        <p className={styles.progress}>{progressLine(doneToday, week)}</p>
        <span className="visually-hidden" role="status" aria-live="polite">
          {announcement}
        </span>
      </div>
    </Card>
  );
}
