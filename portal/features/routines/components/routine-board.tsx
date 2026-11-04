"use client";

import { useLayoutEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { RoutineTile } from "@/features/routines/components/routine-tile";
import type { CadenceActionOption, RecurringWindowOption } from "@/features/routines/recurring-windows";
import { routineGraphLevels, type RoutinePresetDraft } from "@/features/routines/routine-editor";
import type { RoutinePresetStep } from "@/state/portal-state";
import type { TimeBand } from "@openrhen/contracts";

interface ConnectionLine {
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  terminal?: boolean;
}

/**
 * The canvas. Tiles are laid out in dependency levels by CSS, so the arrows between them can only be
 * measured after layout: the effect reads the real boxes and redraws whenever the graph or the size
 * changes.
 */
export function RoutineBoard({
  draft,
  editingId,
  setEditingId,
  patchStep,
  deleteStep,
  connect,
  dropConnection,
  reorder,
  contexts,
  recurringWindows,
  cadenceActions,
  timeBands,
  onCommitmentNameChange,
  onReplacesWakeRoutineChange
}: {
  draft: RoutinePresetDraft;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  patchStep: (id: string, patch: Partial<RoutinePresetStep>) => void;
  deleteStep: (id: string) => void;
  connect: (source: string, target: string) => void;
  dropConnection: (event: DragEvent, target: string) => void;
  reorder: (event: DragEvent, target: string) => void;
  contexts: string[];
  recurringWindows: RecurringWindowOption[];
  cadenceActions: CadenceActionOption[];
  timeBands: TimeBand[];
  onCommitmentNameChange: (value: string) => void;
  onReplacesWakeRoutineChange: (value: boolean) => void;
}) {
  const levels = useMemo(() => routineGraphLevels(draft.steps), [draft.steps]);
  const boardRef = useRef<HTMLDivElement>(null);
  const tileRefs = useRef(new Map<string, HTMLElement>());
  const commitmentRef = useRef<HTMLElement>(null);
  const [lines, setLines] = useState<ConnectionLine[]>([]);
  useLayoutEffect(() => {
    const draw = () => {
      const board = boardRef.current;
      if (!board) return;
      const bounds = board.getBoundingClientRect();
      const next: ConnectionLine[] = [];
      for (const step of draft.steps) {
        const target = tileRefs.current.get(step.id);
        if (!target) continue;
        const targetBounds = target.getBoundingClientRect();
        for (const sourceId of step.dependencyIds) {
          const source = tileRefs.current.get(sourceId);
          if (!source) continue;
          const sourceBounds = source.getBoundingClientRect();
          next.push({
            key: `${sourceId}:${step.id}`,
            x1: sourceBounds.right - bounds.left,
            y1: sourceBounds.top + sourceBounds.height / 2 - bounds.top,
            x2: targetBounds.left - bounds.left,
            y2: targetBounds.top + targetBounds.height / 2 - bounds.top
          });
        }
      }
      const dependedOn = new Set(draft.steps.flatMap((step) => step.dependencyIds));
      const commitment = commitmentRef.current;
      if (commitment) {
        const commitmentBounds = commitment.getBoundingClientRect();
        for (const leaf of draft.steps.filter((step) => step.phase !== "after" && !dependedOn.has(step.id))) {
          const source = tileRefs.current.get(leaf.id);
          if (!source) continue;
          const sourceBounds = source.getBoundingClientRect();
          next.push({
            key: `${leaf.id}:commitment`,
            x1: sourceBounds.right - bounds.left,
            y1: sourceBounds.top + sourceBounds.height / 2 - bounds.top,
            x2: commitmentBounds.left - bounds.left,
            y2: commitmentBounds.top + commitmentBounds.height / 2 - bounds.top,
            terminal: true
          });
        }
        for (const root of draft.steps.filter((step) => step.phase === "after" && !step.dependencyIds.length)) {
          const target = tileRefs.current.get(root.id);
          if (!target) continue;
          const targetBounds = target.getBoundingClientRect();
          next.push({
            key: `commitment:${root.id}`,
            x1: commitmentBounds.right - bounds.left,
            y1: commitmentBounds.top + commitmentBounds.height / 2 - bounds.top,
            x2: targetBounds.left - bounds.left,
            y2: targetBounds.top + targetBounds.height / 2 - bounds.top,
            terminal: true
          });
        }
      }
      setLines(next);
    };
    draw();
    const observer = new ResizeObserver(draw);
    if (boardRef.current) observer.observe(boardRef.current);
    return () => observer.disconnect();
  }, [draft.steps, editingId]);
  const tile = (step: RoutinePresetStep) => (
    <RoutineTile
      key={step.id}
      step={step}
      allSteps={draft.steps}
      editing={editingId === step.id}
      setEditingId={setEditingId}
      patchStep={patchStep}
      deleteStep={deleteStep}
      connect={connect}
      dropConnection={dropConnection}
      reorder={reorder}
      contexts={contexts}
      recurringWindows={recurringWindows}
      cadenceActions={cadenceActions}
      timeBands={timeBands}
      setRef={(node) => (node ? tileRefs.current.set(step.id, node) : tileRefs.current.delete(step.id))}
    />
  );
  return (
    <div className="routine-board-scroll">
      <div className="routine-board" ref={boardRef}>
        <svg className="routine-connections" aria-hidden="true">
          <defs>
            <marker id="routine-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" />
            </marker>
          </defs>
          {lines.map((line) => (
            <path
              key={line.key}
              className={line.terminal ? "terminal-line" : ""}
              d={`M ${line.x1} ${line.y1} C ${line.x1 + 50} ${line.y1}, ${line.x2 - 50} ${line.y2}, ${line.x2} ${line.y2}`}
              markerEnd="url(#routine-arrow)"
            />
          ))}
        </svg>
        {levels.before.map((column, index) => (
          <div className="routine-level" key={`before-${index}`}>
            <span className="level-label">{index === 0 ? "Starts" : "Then"}</span>
            {column.map(tile)}
          </div>
        ))}
        <div className="routine-level activity-level">
          <span className="level-label">Commitment</span>
          <article className="routine-activity-tile" ref={commitmentRef}>
            <span>Commitment</span>
            <CommitmentNameInput value={draft.activityName} onChange={onCommitmentNameChange} />
            <label className="replaces-wake-routine">
              <input
                type="checkbox"
                checked={draft.replacesWakeRoutine}
                onChange={(event) => onReplacesWakeRoutineChange(event.target.checked)}
              />
              Replaces wake routine
            </label>
          </article>
        </div>
        {levels.after.map((column, index) => (
          <div className="routine-level" key={`after-${index}`}>
            <span className="level-label">Then</span>
            {column.map(tile)}
          </div>
        ))}
      </div>
    </div>
  );
}

export function CommitmentNameInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <input
      className="activity-name-input"
      aria-label="Commitment name"
      value={value}
      placeholder="Name the commitment"
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
