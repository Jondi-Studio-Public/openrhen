import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { COLUMN_COUNT, COLUMN_TITLES, type FlowEdge, type FlowNode } from "../data-flow-model";
import {
  COLUMN_GAP,
  HEADER_HEIGHT,
  LANE_TITLE_HEIGHT,
  NODE_HEIGHT,
  NODE_WIDTH,
  PAD,
  edgePath,
  layoutFlow,
  type FlowLayout
} from "../data-flow-layout";
import styles from "./data-flow.module.css";

const CHARS = 22;
const DETAIL_CHARS = 29;
const clipTo = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const clip = (text: string) => clipTo(text, CHARS);

const nodeName = (node: FlowNode) => `${node.label}, ${node.detail}${node.marker ? `, ${node.marker}` : ""}`;

/** Lay out what survives the filters; exported so the page and the tests share one call. */
export function layoutFor(nodes: readonly FlowNode[], edges: readonly FlowEdge[]): FlowLayout {
  return layoutFlow(
    nodes.map((node) => ({ id: node.id, column: node.column })),
    edges,
    COLUMN_COUNT
  );
}

/**
 * The map: five fixed columns, cubic edges (solid where the path reaches the engine, dotted where the engine is blind),
 * nodes with a status dot and their status in words. Drawn as SVG, so there is no graph library.
 */
export function DataFlowGraph({
  nodes,
  edges,
  selectedId,
  onSelect
}: {
  nodes: readonly FlowNode[];
  edges: readonly FlowEdge[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const layout = useMemo(() => layoutFor(nodes, edges), [nodes, edges]);
  const byNode = useMemo(() => new Map(nodes.map((node) => [node.id, node] as const)), [nodes]);
  const step = NODE_WIDTH + COLUMN_GAP;

  // One tab stop: the node last focused (or the selected one, or the first). Arrow keys move between nodes.
  const refs = useRef(new Map<string, SVGGElement>());
  const [focusId, setFocusId] = useState<string | null>(null);
  const stop =
    [focusId, selectedId].find((id): id is string => id !== null && layout.byId.has(id)) ??
    layout.placed[0]?.id ??
    null;

  const move = (from: string, key: string): string | null => {
    const here = layout.byId.get(from);
    if (!here) return null;
    const sameColumn = layout.placed.filter((box) => box.column === here.column).sort((a, b) => a.y - b.y);
    const at = sameColumn.findIndex((box) => box.id === from);
    if (key === "ArrowDown") return sameColumn[at + 1]?.id ?? null;
    if (key === "ArrowUp") return sameColumn[at - 1]?.id ?? null;
    const wanted = key === "ArrowRight" ? here.column + 1 : here.column - 1;
    const near = layout.placed
      .filter((box) => box.column === wanted)
      .sort((a, b) => Math.abs(a.y - here.y) - Math.abs(b.y - here.y) || a.y - b.y)[0];
    return near?.id ?? null;
  };

  const keyDown = (event: KeyboardEvent, id: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(id);
      return;
    }
    if (!event.key.startsWith("Arrow")) return;
    const next = move(id, event.key);
    event.preventDefault();
    if (next) {
      setFocusId(next);
      refs.current.get(next)?.focus();
    }
  };

  return (
    <svg
      className={styles.map}
      role="group"
      aria-label="Data flow map"
      width={layout.width}
      height={layout.height}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
    >
      {COLUMN_TITLES.map((title, column) => (
        <text key={title} className={styles.columnTitle} x={PAD + column * step} y={HEADER_HEIGHT - 10}>
          {title}
        </text>
      ))}
      {layout.laneTop !== null ? (
        <text className={styles.laneTitle} x={PAD} y={layout.laneTop + LANE_TITLE_HEIGHT - 10}>
          Planned, not built yet
        </text>
      ) : null}
      <g aria-hidden="true">
        {edges.map((edge) => {
          const from = layout.byId.get(edge.from);
          const to = layout.byId.get(edge.to);
          if (!from || !to) return null;
          const active = selectedId !== null && (edge.from === selectedId || edge.to === selectedId);
          return (
            <path
              key={`${edge.from}>${edge.to}`}
              className={styles.edge}
              d={edgePath(from, to)}
              data-engine={edge.engine}
              data-active={active}
              data-dim={selectedId !== null && !active}
            />
          );
        })}
      </g>
      {layout.placed.map((box) => {
        const node = byNode.get(box.id);
        if (!node) return null;
        return (
          <g
            key={node.id}
            className={styles.node}
            transform={`translate(${box.x} ${box.y})`}
            role="button"
            ref={(element) => {
              if (element) refs.current.set(node.id, element);
              else refs.current.delete(node.id);
            }}
            tabIndex={stop === node.id ? 0 : -1}
            onFocus={() => setFocusId(node.id)}
            aria-label={nodeName(node)}
            aria-pressed={selectedId === node.id}
            data-kind={node.kind}
            data-tone={node.tone}
            data-planned={node.planned}
            data-pass={node.passThrough}
            data-selected={selectedId === node.id}
            onClick={() => onSelect(node.id)}
            onKeyDown={(event) => keyDown(event, node.id)}
          >
            <title>{nodeName(node)}</title>
            <rect className={styles.box} width={NODE_WIDTH} height={NODE_HEIGHT} rx={8} />
            <circle className={styles.dot} data-tone={node.tone} cx={13} cy={12} r={5} />
            <text className={styles.label} x={24} y={16}>
              {clip(node.label)}
            </text>
            <text className={styles.detail} x={13} y={28}>
              {clipTo(node.detail, DETAIL_CHARS)}
            </text>
            {node.marker && !node.planned ? (
              <g aria-hidden="true">
                <path className={styles.stub} d={`M ${NODE_WIDTH} ${NODE_HEIGHT - 8} h 14`} />
                <path
                  className={styles.stub}
                  d={`M ${NODE_WIDTH + 14} ${NODE_HEIGHT - 13} v 10`}
                  strokeDasharray="none"
                />
                <title>{node.marker}</title>
              </g>
            ) : null}
          </g>
        );
      })}
      <desc>{`${nodes.length} nodes, ${edges.length} connections`}</desc>
    </svg>
  );
}
