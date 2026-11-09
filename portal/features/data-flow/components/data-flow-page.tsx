"use client";

import { useCallback, useMemo, useState } from "react";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { PageHeader } from "@/components/ui/page-header";
import { useNow } from "@/shared/clock";
import {
  DEFAULT_FILTERS,
  applyFilters,
  buildFlowModel,
  countsLine,
  listRows,
  type FlowFilters
} from "../data-flow-model";
import { useDataFlow } from "../use-data-flow";
import { DataFlowGraph } from "./data-flow-graph";
import { DataFlowList } from "./data-flow-list";
import { DataFlowPanel } from "./data-flow-panel";
import styles from "./data-flow.module.css";

const LEGEND: { tone: string; text: string; planned?: boolean }[] = [
  { tone: "green", text: "Fresh" },
  { tone: "amber", text: "Late or unused" },
  { tone: "red", text: "Stale or failing" },
  { tone: "grey", text: "Not tracked or not set up" },
  { tone: "hollow", text: "Never heard from" },
  { tone: "grey", text: "Planned (dashed)", planned: true }
];

/**
 * `/data`: every data point, where it feeds from and to, and what that gives. Read-only. The graph comes from the code's
 * registry; the colours come from live health, read every minute while the page is visible.
 */
export function DataFlowPage() {
  const flow = useDataFlow();
  const now = useNow("minute");
  const [filters, setFilters] = useState<FlowFilters>(DEFAULT_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const filtering =
    filters.category !== null ||
    filters.owner !== null ||
    filters.problemsOnly ||
    filters.reachesEngine ||
    filters.unusedOnly;
  // The map folds idle collectors; a filter, and the list, show every entry.
  const model = useMemo(
    () => (flow.data ? buildFlowModel(flow.data, { now, expanded, unfold: filtering }) : null),
    [flow.data, now, expanded, filtering]
  );
  const everyEntry = useMemo(
    () => (flow.data ? buildFlowModel(flow.data, { now, expanded, unfold: true }) : null),
    [flow.data, now, expanded]
  );
  const shown = useMemo(() => (model ? applyFilters(model, filters) : null), [model, filters]);
  const rows = useMemo(() => {
    if (!everyEntry) return [];
    const all = applyFilters(everyEntry, filters);
    return listRows(everyEntry, all.nodes, all.edges);
  }, [everyEntry, filters]);
  const toggle = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setSelectedId(null);
  }, []);
  const set = (patch: Partial<FlowFilters>) => setFilters((current) => ({ ...current, ...patch }));

  if (!model || !shown || !everyEntry) {
    return (
      <div className={styles.page}>
        <PageHeader title="Data" answer="Where every data point comes from, where it goes and what it gives." />
        {flow.status === "error" ? (
          <Banner
            tone="danger"
            action={
              <Button variant="secondary" onClick={() => void flow.reload()}>
                Try again
              </Button>
            }
          >
            The data map could not be read. Check the connection and try again.
          </Banner>
        ) : (
          <p className={styles.muted}>Reading the data map…</p>
        )}
      </div>
    );
  }

  const panelModel = selectedId && !model.byId.has(selectedId) ? everyEntry : model;
  const line = countsLine({ counts: model.counts, healthAvailable: model.healthAvailable && !flow.healthDown });
  const selected = selectedId ? (panelModel.byId.get(selectedId) ?? null) : null;

  return (
    <div className={styles.page}>
      <PageHeader
        title="Data"
        answer={
          model.counts.unused > 0 || model.counts.nothingSends > 0 ? (
            <button
              type="button"
              className={styles.countsButton}
              aria-pressed={filters.unusedOnly}
              title="Show the sources that are collected but unused"
              onClick={() => set({ unusedOnly: !filters.unusedOnly })}
            >
              {line}
            </button>
          ) : (
            line
          )
        }
      />
      {flow.healthDown ? (
        <Banner tone="warn">
          Health unavailable. The map shows what the code connects; the colours and ages are not live until the next
          read works.
        </Banner>
      ) : null}
      <div className={styles.filters} role="group" aria-label="Filters">
        <Chip pressed={filters.reachesEngine} onClick={() => set({ reachesEngine: !filters.reachesEngine })}>
          Reaches the engine
        </Chip>
        <Chip pressed={filters.problemsOnly} onClick={() => set({ problemsOnly: !filters.problemsOnly })}>
          Problems only
        </Chip>
        <Chip pressed={filters.showPlanned} onClick={() => set({ showPlanned: !filters.showPlanned })}>
          Show planned
        </Chip>
        <Chip pressed={filters.unusedOnly} onClick={() => set({ unusedOnly: !filters.unusedOnly })}>
          Collected, unused
        </Chip>
        {expanded.size > 0 ? (
          <Button variant="ghost" onClick={() => setExpanded(new Set())}>
            Fold all
          </Button>
        ) : null}
        {model.owners.length > 1 ? (
          <>
            <Chip
              pressed={filters.owner === "core"}
              onClick={() => set({ owner: filters.owner === "core" ? null : "core" })}
            >
              Core
            </Chip>
            <Chip
              pressed={filters.owner === "private"}
              onClick={() => set({ owner: filters.owner === "private" ? null : "private" })}
            >
              Private
            </Chip>
          </>
        ) : null}
      </div>
      <div className={styles.filters} role="group" aria-label="Category">
        {model.categories.map((category) => (
          <Chip
            key={category}
            pressed={filters.category === category}
            onClick={() => set({ category: filters.category === category ? null : category })}
          >
            {category}
          </Chip>
        ))}
      </div>
      <ul className={styles.legend} aria-label="Colour key">
        {LEGEND.map((item) => (
          <li key={item.text}>
            <span
              className={styles.swatch}
              data-tone={item.tone}
              data-planned={item.planned === true}
              aria-hidden="true"
            />
            {item.text}
          </li>
        ))}
      </ul>
      <div className={styles.mapFrame}>
        <DataFlowGraph nodes={shown.nodes} edges={shown.edges} selectedId={selectedId} onSelect={setSelectedId} />
      </div>
      <div className={styles.listFrame}>
        <DataFlowList rows={rows} onSelect={setSelectedId} />
      </div>
      <DataFlowPanel node={selected} model={panelModel} onClose={() => setSelectedId(null)} onToggle={toggle} />
    </div>
  );
}
