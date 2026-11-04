"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/banner";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { PlaceTabs } from "@/components/place-tabs";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { usePortal } from "@/state/portal-provider";
import { useNow } from "@/shared/clock";
import { usePlanMap } from "@/features/plan-map/use-plan-map";
import { parseHandle } from "@/features/plan-map/plan-map-model";
import { outcomePlanHref, projectPlanHref } from "@/features/plan/area-grouping";
import type { PortalState } from "@/state/portal-state";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  DEFAULT_CONTROLS,
  EDGE_LOOK_LABELS,
  START_GROUPS,
  buildMapView,
  busiestAreaHandle,
  describeCard,
  humanise,
  edgeKindLabel,
  edgeLook,
  edgePath,
  itemFromSearch,
  controlsFromSearch,
  mapAddress,
  layoutMap,
  mapHref,
  mapStarts,
  type MapControls,
  type MapView
} from "@/features/plan-map/map-view-model";
import styles from "./plan-map-page.module.css";

/**
 * The address bar is the state: `?item=<handle>` names the centre of the map and the controls ride
 * along (`controlsFromSearch`), so a map can be bookmarked as drawn and Back works. A new centre is a
 * new history entry; a change of control replaces the current one.
 */
function useMapAddress(): {
  target: string | null;
  controls: MapControls;
  go: (handle: string | null) => void;
  setControls: (controls: MapControls) => void;
} {
  const [address, setAddress] = useState<{ target: string | null; controls: MapControls }>({
    target: null,
    controls: DEFAULT_CONTROLS
  });
  useEffect(() => {
    const read = () =>
      setAddress({
        target: itemFromSearch(window.location.search),
        controls: controlsFromSearch(window.location.search)
      });
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  // Each writer reads the other half from the address itself, which is the state.
  const go = useCallback((next: string | null) => {
    window.history.pushState(null, "", mapAddress(next, controlsFromSearch(window.location.search)));
    setAddress((current) => ({ ...current, target: next }));
  }, []);
  const setControls = useCallback((controls: MapControls) => {
    window.history.replaceState(null, "", mapAddress(itemFromSearch(window.location.search), controls));
    setAddress((current) => ({ ...current, controls }));
  }, []);
  return { ...address, go, setControls };
}

/**
 * Re-centring swaps the whole picture, so it cross-fades as one View Transition rather than jumping.
 * Browsers without the API, and anyone who asked for reduced motion, get the plain swap.
 */
function recentre(update: () => void) {
  const doc = document as Document & { startViewTransition?: (callback: () => void) => unknown };
  if (typeof doc.startViewTransition !== "function" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
    return update();
  doc.startViewTransition(() => flushSync(update));
}

// A 168px card fits about 20 characters of the 13px bold title; 24 ran past the card's right edge.
const TRUNCATE = 20;
// Drawn a little larger than its own units on a wide screen, but never stretched to the full width.
const MAP_SCALE = 1.25;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * The read-only plan map: one item and what is connected to it, drawn from the navigator the CLI's `map`
 * command uses. Confirmed links are solid, suggested links dashed and marked suggested, and links
 * computed from the plan itself are thin and grey. Nothing here changes a link; confirming and
 * dismissing stay in the Inbox's Links and findings window.
 */
export function PlanMapPage() {
  const { state } = usePortal();
  const planMap = usePlanMap();
  const now = useNow("minute");
  const { target, controls, go, setControls } = useMapAddress();
  const setTarget = useCallback((handle: string | null) => recentre(() => go(handle)), [go]);
  const timezone = state.settings.timezone;
  // With nothing named in the address, the map opens on the area with the most open work, so the
  // first thing on the page is a picture rather than a list. The address stays `/map`.
  const centre = useMemo(() => target ?? busiestAreaHandle(state), [target, state]);

  const view = useMemo(
    () => buildMapView(state, planMap.map, centre, controls, now),
    [state, planMap.map, centre, controls, now]
  );
  const starts = useMemo(() => mapStarts(view), [view]);

  const centreTitle = view.root?.title;
  return (
    <section className={styles.page} aria-label="Plan map">
      <PageHeader
        title="Plan"
        answer={centreTitle ? `See what is connected to ${centreTitle}.` : "See what is connected."}
      />
      <PlaceTabs />

      {planMap.status === "error" && (
        <Banner
          tone="warn"
          action={
            <Button variant="secondary" size="sm" onClick={() => void planMap.reload()}>
              Try again
            </Button>
          }
        >
          {planMap.error || "Stored links could not be loaded."} Showing links computed from the plan only.
        </Banner>
      )}
      {planMap.status === "loading" && !planMap.map && <p className={styles.note}>Loading stored links...</p>}

      <div className={styles.desk}>
        <aside className={styles.side} aria-label="Map settings">
          <MapControlsBar
            starts={starts}
            target={view.rootHandle ?? centre}
            controls={controls}
            onTarget={setTarget}
            onControls={setControls}
          />
          <hr className={styles.divider} />
          {view.root && <CentreCard root={view.root} href={centreHref(view.root.handle, state)} timezone={timezone} />}
          <a className={styles.inboxLink} href="/inbox/map">
            Review suggested links in the Inbox
          </a>
        </aside>

        <div className={styles.main}>
          {view.problem && (
            <p className={styles.note} role="status">
              {view.problem}
            </p>
          )}
          {view.root && (
            <div className={styles.body}>
              <MapBody view={view} timezone={timezone} onPick={setTarget} />
            </div>
          )}
        </div>
      </div>

      {!target && <MapStarts starts={starts} centre={view.rootHandle} onPick={setTarget} />}
    </section>
  );
}

/**
 * Where the centre item lives outside the map, if it has a page: an area's own page, an outcome's or
 * project's card in Plan, or a deliverable's workspace. Subjects, actions and the rest have none.
 */
export function centreHref(handle: string, state: Pick<PortalState, "areas" | "outcomes" | "projects">): string | null {
  const ref = parseHandle(handle);
  if (!ref) return null;
  if (ref.type === "area") return state.areas.some((area) => area.id === ref.id) ? `/plan/${ref.id}` : null;
  if (ref.type === "outcome") {
    const outcome = state.outcomes.find((item) => item.id === ref.id);
    return outcome ? outcomePlanHref(outcome, state.areas) : null;
  }
  if (ref.type === "project") {
    const project = state.projects.find((item) => item.id === ref.id);
    return project ? projectPlanHref(project, state.outcomes, state.areas) : null;
  }
  if (ref.type === "deliverable") return `/deliverables?deliverable=${encodeURIComponent(ref.id)}`;
  return null;
}

/** What the map is centred on, in a few words, with a way to its own page where one exists. */
function CentreCard({
  root,
  href,
  timezone
}: {
  root: NonNullable<MapView["root"]>;
  href: string | null;
  timezone: string;
}) {
  const kind = humanise(root.type);
  const summary = describeCard(root, timezone);
  const detail = summary.startsWith(kind) ? summary.slice(kind.length).replace(/^,\s*/, "") : summary;
  return (
    <Card padded className={styles.centre} aria-label="Centre of the map">
      <Badge dot={false} className={styles.kind}>
        {kind.charAt(0).toUpperCase() + kind.slice(1)}
      </Badge>
      <h2 className={styles.centreTitle}>{root.title}</h2>
      {detail && <p className={styles.centreText}>{detail}</p>}
      {href && (
        <div className={styles.centreActions}>
          <ButtonLink href={href} variant="secondary" size="sm">
            Open
          </ButtonLink>
        </div>
      )}
    </Card>
  );
}

function MapControlsBar({
  starts,
  target,
  controls,
  onTarget,
  onControls
}: {
  starts: ReturnType<typeof mapStarts>;
  target: string | null;
  controls: MapControls;
  onTarget: (handle: string | null) => void;
  onControls: (controls: MapControls) => void;
}) {
  const known = target !== null && starts.some((start) => start.handle === target);
  return (
    <div className={styles.controls}>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="plan-map-centre">
          Centre on
        </label>
        <select
          id="plan-map-centre"
          className={styles.select}
          value={target ?? ""}
          onChange={(event) => onTarget(event.target.value || null)}
        >
          <option value="">Choose an area, outcome, project or subject</option>
          {target && !known && <option value={target}>{target}</option>}
          {START_GROUPS.map((group) => {
            const options = starts.filter((start) => start.group === group);
            return options.length === 0 ? null : (
              <optgroup key={group} label={group}>
                {options.map((start) => (
                  <option key={start.handle} value={start.handle}>
                    {start.title}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
      </div>
      <div className={styles.field}>
        <span className={styles.label}>How far out</span>
        <Segmented
          label="How far out"
          value={String(controls.depth) as "1" | "2" | "3"}
          options={[
            { value: "1", label: "1 link" },
            { value: "2", label: "2 links" },
            { value: "3", label: "3 links" }
          ]}
          onChange={(value) => onControls({ ...controls, depth: Number(value) as MapControls["depth"] })}
        />
      </div>
      <div className={styles.switches}>
        <label className={styles.switchRow}>
          <span>Show suggested links</span>
          <Switch
            label="Show suggested links"
            checked={controls.showSuggested}
            onChange={(checked) => onControls({ ...controls, showSuggested: checked })}
          />
        </label>
        <label className={styles.switchRow}>
          <span>Links from the plan</span>
          <Switch
            label="Links from the plan"
            checked={controls.showDerived}
            onChange={(checked) => onControls({ ...controls, showDerived: checked })}
          />
        </label>
      </div>
    </div>
  );
}

/**
 * Where else to start: every live area, outcome, project and subject as a chip, grouped by kind. Shown
 * while the address names no item — beside the busiest area's map, or alone when the plan has none.
 */
function MapStarts({
  starts,
  centre,
  onPick
}: {
  starts: ReturnType<typeof mapStarts>;
  centre: string | null;
  onPick: (handle: string) => void;
}) {
  if (starts.length === 0)
    return <p className={styles.note}>There are no areas, outcomes, projects or subjects to draw a map from yet.</p>;
  return (
    <Card as="section" padded className={styles.starts} aria-labelledby="plan-map-starts-title">
      <p className={styles.startsTitle} id="plan-map-starts-title">
        {centre ? "Or start somewhere else" : "Start from an area, outcome, project or subject"}
      </p>
      {START_GROUPS.map((group) => {
        const chips = starts.filter((start) => start.group === group);
        if (chips.length === 0) return null;
        const id = `plan-map-starts-${group.toLowerCase()}`;
        return (
          <div className={styles.startGroup} key={group}>
            <h3 id={id}>{group}</h3>
            <ul className={styles.chips} aria-labelledby={id}>
              {chips.map((start) => (
                <li key={start.handle}>
                  <a
                    className={styles.chip}
                    href={mapHref(start.handle)}
                    aria-current={start.handle === centre ? "true" : undefined}
                    onClick={(event) => followInPage(event, () => onPick(start.handle))}
                  >
                    {start.title}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </Card>
  );
}

/** Plain clicks recentre the map without reloading; a modified click still opens a new tab. */
function followInPage(event: MouseEvent, go: () => void) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  go();
}

function MapBody({ view, timezone, onPick }: { view: MapView; timezone: string; onPick: (handle: string) => void }) {
  const root = view.root!;
  const layout = useMemo(() => layoutMap(root, view.cards, view.edges), [root, view.cards, view.edges]);
  const titleOf = (handle: string) => view.index.items.get(handle)?.title ?? handle;
  const counts = { confirmed: 0, suggested: 0, derived: 0 };
  for (const edge of view.edges) counts[edgeLook(edge)] += 1;
  // A map wider than the screen scrolls sideways; start it scrolled to the centre item, not the left edge.
  // Only when the centre or the map's width changes: the clock tick and state polls rebuild the layout
  // every minute, and re-centring then would snap away from wherever the reader had scrolled.
  const canvasRef = useRef<HTMLDivElement>(null);
  const centredFor = useRef<string | null>(null);
  const rootPlaced = layout.byHandle.get(root.handle);
  const centreKey = `${root.handle}@${layout.width}`;
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const svg = canvas?.querySelector("svg");
    if (centredFor.current === centreKey) return;
    if (!canvas || !svg || !rootPlaced || canvas.scrollWidth <= canvas.clientWidth) return;
    const scale = svg.getBoundingClientRect().width / layout.width;
    canvas.scrollLeft = (rootPlaced.x + CARD_WIDTH / 2) * scale - canvas.clientWidth / 2;
    centredFor.current = centreKey;
  }, [centreKey, layout.width, rootPlaced]);

  return (
    <>
      {view.cards.length === 0 && (
        <p className={styles.note}>
          Nothing is connected to {root.title} yet with these settings.
          {counts.derived === 0 && " Try showing links from the plan, or add a connection from the item's page."}
        </p>
      )}
      <Card as="section" className={styles.canvasCard} aria-label="Map">
        <div className={styles.canvas} data-map-canvas="" ref={canvasRef}>
          <svg
            className={styles.svg}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            role="img"
            aria-label={`Map of ${root.title} and ${view.cards.length} connected ${view.cards.length === 1 ? "item" : "items"}. The same links are listed below.`}
            style={{
              width: `${layout.width * MAP_SCALE}px`,
              maxWidth: "100%",
              // Never drawn below its own units: on a phone that left 8px subtitles. A wider map scrolls
              // sideways instead, opened on the centre item.
              minWidth: `${layout.width}px`,
              height: "auto"
            }}
          >
            {view.edges.map((edge) => {
              const from = layout.byHandle.get(edge.from);
              const to = layout.byHandle.get(edge.to);
              if (!from || !to) return null;
              const look = edgeLook(edge);
              return (
                <path
                  key={`${edge.from}|${edge.to}|${edge.kind}|${edge.origin}`}
                  className={styles.edge}
                  data-look={look}
                  d={edgePath(from, to)}
                  fill="none"
                >
                  <title>{`${titleOf(edge.from)} ${edgeKindLabel(edge.kind)} ${titleOf(edge.to)} (${EDGE_LOOK_LABELS[look]})`}</title>
                </path>
              );
            })}
            {layout.placed.map(({ card, x, y, distance }) => (
              <a
                key={card.handle}
                href={mapHref(card.handle)}
                onClick={(event) => followInPage(event as unknown as MouseEvent, () => onPick(card.handle))}
                aria-label={`${card.title}, ${describeCard(card, timezone)}. Centre the map on it.`}
              >
                <g className={`${styles.node} ${distance === 0 ? styles.root : ""}`} transform={`translate(${x} ${y})`}>
                  <rect width={CARD_WIDTH} height={CARD_HEIGHT} rx={12} />
                  <text x={12} y={22} className={styles.nodeTitle}>
                    {clip(card.title, TRUNCATE)}
                  </text>
                  <text x={12} y={40} className={styles.nodeMeta}>
                    {clip(describeCard(card, timezone), 28)}
                  </text>
                  <title>{`${card.title} (${describeCard(card, timezone)})`}</title>
                </g>
              </a>
            ))}
          </svg>
        </div>
        <Legend counts={counts} />
      </Card>
      {view.omitted > 0 && (
        <p className={styles.note}>
          {view.omitted} more connected {view.omitted === 1 ? "item is" : "items are"} not drawn to keep the map
          readable. Centre on one of the items shown to see its own neighbours.
        </p>
      )}
      <LinkList view={view} onPick={onPick} />
    </>
  );
}

function Legend({ counts }: { counts: Record<"confirmed" | "suggested" | "derived", number> }) {
  return (
    <ul className={styles.legend} aria-label="Key">
      <li>
        <svg width="40" height="10" aria-hidden="true">
          <line x1="0" y1="5" x2="40" y2="5" className={styles.edge} data-look="confirmed" />
        </svg>
        Confirmed link ({counts.confirmed})
      </li>
      <li>
        <svg width="40" height="10" aria-hidden="true">
          <line x1="0" y1="5" x2="40" y2="5" className={styles.edge} data-look="suggested" />
        </svg>
        Suggested, not yet confirmed ({counts.suggested})
      </li>
      <li>
        <svg width="40" height="10" aria-hidden="true">
          <line x1="0" y1="5" x2="40" y2="5" className={styles.edge} data-look="derived" />
        </svg>
        From the plan itself ({counts.derived})
      </li>
    </ul>
  );
}

/** The same edges as text, for a phone, a screen reader, and anyone who wants the evidence behind a link. */
function LinkList({ view, onPick }: { view: MapView; onPick: (handle: string) => void }) {
  const cards = new Map([[view.root!.handle, view.root!], ...view.cards.map((card) => [card.handle, card] as const)]);
  const rank = { confirmed: 0, suggested: 1, derived: 2 } as const;
  const edges = [...view.edges].sort((a, b) => rank[edgeLook(a)] - rank[edgeLook(b)]);
  if (edges.length === 0) return null;
  const end = (handle: string) => {
    const card = cards.get(handle);
    return (
      <a href={mapHref(handle)} onClick={(event) => followInPage(event, () => onPick(handle))}>
        {card?.title ?? handle}
      </a>
    );
  };
  return (
    <Card className={styles.links}>
      <ul className={styles.linkList} aria-label="Links on this map">
        {edges.map((edge) => {
          const look = edgeLook(edge);
          return (
            <li key={`${edge.from}|${edge.to}|${edge.kind}|${edge.origin}`} className={styles.linkRow} data-look={look}>
              <p className={styles.linkLine}>
                {end(edge.from)} <span className={styles.kindWord}>{edgeKindLabel(edge.kind)}</span> {end(edge.to)}
                <span className={styles.kindWord}> {EDGE_LOOK_LABELS[look]}</span>
              </p>
              {edge.evidence && <p className={styles.note}>{edge.evidence}</p>}
              {look === "suggested" && <p className={styles.note}>It changes nothing until confirmed in the Inbox.</p>}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
