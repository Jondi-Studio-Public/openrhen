"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useNow } from "@/shared/clock";
import { ageLabel } from "@/features/agent-proposals/agent-proposals-store";
import { Sheet } from "@/components/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { List, ListRow } from "@/components/ui/list-row";
import {
  basisText,
  detailIdFor,
  fieldLabel,
  orderedFields,
  planEffectItems,
  planEffectLine,
  readableLabel,
  rowHeading,
  valueText,
  type AgentChange,
  type AgentChangeDetail
} from "../agent-change-view";
import { markAgentChangesLooked, readAgentChangesLookedAt } from "../agent-changes-seen";
import styles from "./agent-changes-panel.module.css";

export type { AgentChange } from "../agent-change-view";

const STATUS_WORDS: Record<AgentChange["status"], string> = {
  applied: "Applied",
  undone: "Undone",
  superseded: "Superseded"
};

/** How long to wait before each re-read of a sheet whose plan effect is still pending. */
const PENDING_RETRY_MS = [3_000, 8_000, 20_000, 45_000];

/** One page of the list; "Show older" asks for the next. */
const PAGE = 20;
/** The most the list route returns at once, which a refresh after an undo asks for to keep older pages. */
const MAX_PAGE = 100;

interface ChangesPage {
  changes: AgentChange[];
  nextCursor: string | null;
}

/** A page of changes, newest first, or null when the list cannot be read. */
async function readChanges(options: { limit?: number; before?: string } = {}): Promise<ChangesPage | null> {
  const query = new URLSearchParams({ limit: String(options.limit ?? PAGE) });
  if (options.before) query.set("before", options.before);
  try {
    const response = await fetch(`/api/agent-changes?${query.toString()}`, { cache: "no-store" });
    const body = response.ok ? ((await response.json()) as { changes?: unknown; nextCursor?: unknown } | null) : null;
    if (!Array.isArray(body?.changes)) return null;
    return {
      changes: body.changes as AgentChange[],
      nextCursor: typeof body.nextCursor === "string" && body.nextCursor ? body.nextCursor : null
    };
  } catch {
    return null;
  }
}

type DetailState =
  { status: "loading" } | { status: "none" } | { status: "failed" } | { status: "ready"; detail: AgentChangeDetail };

async function readDetail(writeId: string): Promise<DetailState> {
  try {
    const response = await fetch(`/api/agent-changes/${encodeURIComponent(writeId)}`, { cache: "no-store" });
    if (response.status === 404) return { status: "none" };
    if (!response.ok) return { status: "failed" };
    return { status: "ready", detail: (await response.json()) as AgentChangeDetail };
  } catch {
    return { status: "failed" };
  }
}

/**
 * Scrolls to the list, then again while the cards above it are still loading and pushing it down, until
 * the person scrolls themselves or about two seconds pass.
 */
function followHash() {
  let placed: number | null = null;
  const place = () => {
    if (placed !== null && Math.abs(window.scrollY - placed) > 2) return false;
    document.getElementById("agent-changes")?.scrollIntoView({ block: "start" });
    placed = window.scrollY;
    return true;
  };
  requestAnimationFrame(() => {
    if (!place()) return;
    for (const delay of [400, 1000, 2000]) window.setTimeout(place, delay);
  });
}

/** The text of a failed answer's `error`, or a plain fallback. */
async function failureText(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" && body.error ? body.error : "That could not be done.";
}

/** What one write did, record by record, why the agent says it did it, and what it did to the plan. */
function ChangeDetail({ state, timezone, undone }: { state: DetailState; timezone: string; undone: boolean }) {
  if (state.status === "loading") return <p className={styles.quiet}>Loading what changed…</p>;
  if (state.status === "failed") return <p className={styles.quiet}>What changed could not be loaded.</p>;
  if (state.status === "none")
    return <p className={styles.quiet}>The details of this change aren't linked to it, so only its name is shown.</p>;
  const { detail } = state;
  const items = planEffectItems(detail.plan, timezone);
  return (
    <>
      {detail.rows.map((row, index) => {
        const basis = basisText(row.basis);
        const heading = rowHeading(row, { undone });
        const added = heading.startsWith("Added");
        return (
          <section key={`${row.entityType}:${row.entityId ?? index}`} className={styles.record}>
            <h3 className={styles.recordHead}>
              {heading}
              {row.title ? <span className={styles.recordTitle}> “{row.title}”</span> : null}
            </h3>
            <div className={styles.basis}>
              <Badge tone={basis.tone}>{basis.text}</Badge>
            </div>
            {row.statedEvidence ? <blockquote className={styles.quote}>{row.statedEvidence}</blockquote> : null}
            {row.fields.length > 0 ? (
              <dl className={styles.fields}>
                {orderedFields(row.fields).map((field) => (
                  <div key={field.field} className={styles.field}>
                    <dt>{fieldLabel(field.field)}</dt>
                    <dd>
                      {!added ? (
                        <>
                          <span className={styles.before}>{valueText(field.before, timezone)}</span>
                          <span aria-hidden="true"> → </span>
                          <span className="visually-hidden"> changed to </span>
                        </>
                      ) : null}
                      <span className={styles.after}>
                        {field.afterKnown ? valueText(field.after, timezone) : "not recorded"}
                      </span>
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className={styles.quiet}>No field-level change was kept for this record.</p>
            )}
          </section>
        );
      })}
      <section className={styles.record}>
        <h3 className={styles.recordHead}>Effect on the plan</h3>
        <p className={styles.effect}>{planEffectLine(detail.plan)}</p>
        {items.length > 0 ? (
          <ul className={styles.effectList}>
            {items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : null}
      </section>
    </>
  );
}

/**
 * What agents changed on their own, newest first. Each row
 * opens a sheet that says what the write changed (from → to), the basis and words the agent gave, and what it
 * did to the plan, with Undo for an applied write and Redo for an undone one. Both post to
 * `/api/agent-changes/[id]/undo`; the portal runs the same checks as `rhen undo`, so a record edited
 * since is refused and the reason is shown. "Show older" pages back. Showing the list marks it looked at on
 * this device, which is what Now's "since you looked" count counts from. Shows nothing while loading.
 */
export function AgentChangesPanel({ timezone }: { timezone: string }) {
  const now = useNow("minute");
  const [changes, setChanges] = useState<AgentChange[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderFailed, setOlderFailed] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ id: string; message: string; conflict: boolean } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  /** The change as it was when opened, so the sheet stays open if a refresh no longer lists it. */
  const [opened, setOpened] = useState<AgentChange | null>(null);
  const [detail, setDetail] = useState<DetailState>({ status: "loading" });
  /** When this device last looked, read once before this visit marks it, so new rows can say so. */
  const [lookedBefore, setLookedBefore] = useState<number | null>(null);
  const detailFor = useRef<string | null>(null);

  const show = useCallback((page: ChangesPage | null) => {
    if (page) {
      setChanges(page.changes);
      setNextCursor(page.nextCursor);
    }
    setLoadFailed(page === null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void readChanges().then((page) => {
      if (cancelled) return;
      show(page);
      if (page) {
        const looked = Date.parse(readAgentChangesLookedAt() ?? "");
        setLookedBefore(Number.isNaN(looked) ? null : looked);
        markAgentChangesLooked();
        // Now's "since you looked" line links here; the list only exists once loaded, so scroll now.
        if (window.location.hash === "#agent-changes") followHash();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [show]);

  const loadDetail = useCallback((change: AgentChange) => {
    const writeId = detailIdFor(change);
    detailFor.current = change.id;
    if (!writeId) {
      setDetail({ status: "none" });
      return;
    }
    setDetail({ status: "loading" });
    // While the plan is still recalculating, ask again a few times so an open sheet fills in its effect.
    const read = (attempt: number) => {
      void readDetail(writeId).then((next) => {
        if (detailFor.current !== change.id) return;
        setDetail(next);
        const retry = PENDING_RETRY_MS[attempt];
        if (next.status === "ready" && next.detail.plan.reason === "pending" && retry !== undefined)
          window.setTimeout(() => {
            if (detailFor.current === change.id) read(attempt + 1);
          }, retry);
      });
    };
    read(0);
  }, []);

  function open(change: AgentChange) {
    setOpenId(change.id);
    setOpened(change);
    setProblem(null);
    loadDetail(change);
  }

  async function older() {
    if (!nextCursor || !changes) return;
    setLoadingOlder(true);
    setOlderFailed(false);
    const page = await readChanges({ before: nextCursor });
    setLoadingOlder(false);
    if (!page) {
      setOlderFailed(true);
      return;
    }
    const seen = new Set(changes.map((change) => change.id));
    setChanges([...changes, ...page.changes.filter((change) => !seen.has(change.id))]);
    setNextCursor(page.nextCursor);
  }

  async function reverse(change: AgentChange, force = false) {
    // The buttons stay focusable while a request runs (aria-disabled, not disabled), so focus stays in the
    // sheet and Escape still closes it; this guard is what keeps a second press from posting again.
    if (pending !== null) return;
    setPending(change.id);
    setProblem(null);
    try {
      const response = await fetch(`/api/agent-changes/${encodeURIComponent(change.id)}/undo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redo: change.status === "undone", ...(force ? { force: true } : {}) })
      });
      if (response.ok) {
        const answer = (await response.json().catch(() => null)) as { warning?: unknown } | null;
        // Ask again for as many as are showing, so an undo does not fold away the older pages.
        const page = await readChanges({ limit: Math.min(MAX_PAGE, Math.max(PAGE, changes?.length ?? PAGE)) });
        show(page);
        const fresh = page?.changes.find((item) => item.id === change.id);
        // Only the change still open in the sheet: the person may have moved on to another while this ran.
        if (fresh && detailFor.current === change.id) loadDetail(fresh);
        // Gone from the refreshed page: the sheet still shows it, so show what just happened to it.
        if (!fresh)
          setOpened((open) =>
            open?.id === change.id ? { ...open, status: change.status === "undone" ? "applied" : "undone" } : open
          );
        if (typeof answer?.warning === "string" && answer.warning)
          setProblem({ id: change.id, message: answer.warning, conflict: false });
        else if (page === null)
          setProblem({ id: change.id, message: "Agent changes could not be reloaded.", conflict: false });
      } else {
        // A 409 is a refusal to overwrite or to reverse unchecked; the person may still choose to go ahead.
        setProblem({ id: change.id, message: await failureText(response), conflict: response.status === 409 });
      }
    } catch {
      setProblem({ id: change.id, message: "The portal could not be reached.", conflict: false });
    } finally {
      setPending(null);
    }
  }

  if (changes === null && !loadFailed) return null;

  const listed = changes?.find((change) => change.id === openId) ?? null;
  const selected = listed ?? (opened?.id === openId ? opened : null);
  const fresh = (change: AgentChange) =>
    lookedBefore !== null && change.status === "applied" && Date.parse(change.at) > lookedBefore;
  const newCount = changes?.filter(fresh).length ?? 0;

  return (
    <section aria-labelledby="agent-changes-heading" className={styles.panel} id="agent-changes">
      <div className={styles.head}>
        <h2 id="agent-changes-heading">Agent changes</h2>
        {newCount > 0 ? <Badge tone="accent">{newCount} new since you looked</Badge> : null}
      </div>
      {changes === null ? (
        <p className={styles.quiet}>Agent changes could not be loaded.</p>
      ) : changes.length === 0 ? (
        <p className={styles.quiet}>No agent changes yet.</p>
      ) : (
        <>
          <List>
            {changes.map((change) => (
              <ListRow
                key={change.id}
                onClick={() => open(change)}
                title={readableLabel(change.label)}
                meta={`${change.agent} · ${ageLabel(change.at, now.getTime())}`}
                trailing={
                  change.status !== "applied" ? (
                    <Badge tone="neutral" dot={false}>
                      {STATUS_WORDS[change.status]}
                    </Badge>
                  ) : fresh(change) ? (
                    <Badge tone="accent">New</Badge>
                  ) : undefined
                }
              />
            ))}
          </List>
          {nextCursor ? (
            <Button size="sm" variant="ghost" disabled={loadingOlder} onClick={() => void older()}>
              {loadingOlder ? "Loading…" : "Show older"}
            </Button>
          ) : null}
          {olderFailed ? <p className={styles.quiet}>Older changes could not be loaded.</p> : null}
        </>
      )}
      <Sheet
        open={selected !== null}
        onClose={() => {
          setOpenId(null);
          setOpened(null);
          detailFor.current = null;
        }}
        title="Agent change"
      >
        {selected ? (
          <div className={styles.sheet}>
            <div>
              <p className={styles.sheetTitle}>{readableLabel(selected.label)}</p>
              <p className={styles.quiet}>
                {selected.agent} · {ageLabel(selected.at, now.getTime())} · {STATUS_WORDS[selected.status]}
              </p>
            </div>
            <ChangeDetail state={detail} timezone={timezone} undone={selected.status === "undone"} />
            {problem?.id === selected.id && (
              <p className={styles.error} role="alert">
                {problem.message}
              </p>
            )}
            {selected.status !== "superseded" ? (
              <div className={styles.actions}>
                <Button
                  variant={selected.status === "undone" ? "secondary" : "danger"}
                  aria-disabled={pending !== null}
                  onClick={() => void reverse(selected)}
                >
                  {pending === selected.id
                    ? selected.status === "undone"
                      ? "Redoing…"
                      : "Undoing…"
                    : selected.status === "undone"
                      ? "Redo"
                      : "Undo"}
                </Button>
                {problem?.id === selected.id && problem.conflict && (
                  <Button variant="ghost" aria-disabled={pending !== null} onClick={() => void reverse(selected, true)}>
                    {selected.status === "undone" ? "Redo anyway" : "Undo anyway"}
                  </Button>
                )}
              </div>
            ) : (
              <p className={styles.quiet}>
                Superseded: a later change replaced this one, so it can no longer be undone here.
              </p>
            )}
          </div>
        ) : null}
      </Sheet>
    </section>
  );
}
