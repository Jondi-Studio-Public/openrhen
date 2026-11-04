import type { RoutinePreset, RoutinePresetStep } from "@/state/portal-state";

export const newRoutineStep = (
  id: string,
  sequence: number,
  phase: "before" | "after" = "before"
): RoutinePresetStep => ({
  id,
  title: "",
  durationMinutes: 10,
  sequence,
  timingRule: "contiguous",
  energy: "low",
  contexts: [],
  dependencyIds: [],
  phase
});

export const routinePresetDraft = (preset?: RoutinePreset) => ({
  id: preset?.id ?? "",
  name: preset?.name ?? "",
  activityName: preset?.activityName ?? preset?.name ?? "",
  status: preset?.status ?? ("active" as const),
  // See the wake routine design note: when true and this preset resolves for a confirmed commitment,
  // that commitment can skip or truncate the day's wake routine instance instead of running alongside it.
  replacesWakeRoutine: preset?.replacesWakeRoutine ?? false,
  steps: preset?.steps.map((step) => ({ ...step, contexts: [...step.contexts] })) ?? []
});

/** What the routine editor holds while it is being edited, before it becomes a saved preset. */
export type RoutinePresetDraft = ReturnType<typeof routinePresetDraft>;

// Display labels are stored as text; technical identifiers are generated separately.
export const normalizeRoutineLabel = (value: string) => value.trim().replace(/\s+/g, " ");

export const routinePresetsForView = (presets: RoutinePreset[], archived: boolean) =>
  presets.filter((preset) => (preset.status === "archived") === archived);

export const patchRoutineStep = (steps: RoutinePresetStep[], index: number, patch: Partial<RoutinePresetStep>) =>
  steps.map((step, position) => (position === index ? { ...step, ...patch } : step));

export const removeRoutineStep = (steps: RoutinePresetStep[], index: number) =>
  steps
    .filter((_, position) => position !== index)
    .map((step) => ({ ...step, dependencyIds: step.dependencyIds.filter((id) => id !== steps[index]?.id) }));

export const toggleRoutineAccordion = (current: string | null, requested: string) =>
  current === requested ? null : requested;

export function validateRoutineGraph(steps: RoutinePresetStep[]): string | null {
  const ids = new Set(steps.map((step) => step.id));
  const phases = new Map(steps.map((step) => [step.id, step.phase]));
  for (const step of steps) {
    if (step.dependencyIds.includes(step.id)) return `“${step.title || "Untitled step"}” cannot depend on itself.`;
    if (new Set(step.dependencyIds).size !== step.dependencyIds.length)
      return `“${step.title || "Untitled step"}” contains a duplicate connection.`;
    if (step.dependencyIds.some((id) => !ids.has(id)))
      return `“${step.title || "Untitled step"}” refers to a step that no longer exists.`;
    if (step.dependencyIds.some((id) => phases.get(id) !== step.phase))
      return `“${step.title || "Untitled step"}” cannot connect across before/after the commitment.`;
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const step = steps.find((item) => item.id === id);
    if (step?.dependencyIds.some(visit)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return steps.some((step) => visit(step.id)) ? "Routine connections cannot form a cycle." : null;
}

function levelsFor(steps: RoutinePresetStep[]): RoutinePresetStep[][] {
  const memo = new Map<string, number>();
  const level = (step: RoutinePresetStep): number => {
    const existing = memo.get(step.id);
    if (existing !== undefined) return existing;
    const value = step.dependencyIds.length
      ? 1 + Math.max(...step.dependencyIds.map((id) => level(steps.find((item) => item.id === id)!)))
      : 0;
    memo.set(step.id, value);
    return value;
  };
  const columns: RoutinePresetStep[][] = [];
  for (const step of steps) {
    const value = level(step);
    (columns[value] ??= []).push(step);
  }
  for (const column of columns) column.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  return columns;
}

export function routineGraphLevels(steps: RoutinePresetStep[]): {
  before: RoutinePresetStep[][];
  after: RoutinePresetStep[][];
} {
  const before = steps.filter((step) => step.phase !== "after");
  const after = steps.filter((step) => step.phase === "after");
  if (validateRoutineGraph(steps))
    return {
      before: [before.slice().sort((a, b) => a.sequence - b.sequence)],
      after: [after.slice().sort((a, b) => a.sequence - b.sequence)]
    };
  return { before: levelsFor(before), after: levelsFor(after) };
}

export function topologicalRoutineSteps(steps: RoutinePresetStep[]): RoutinePresetStep[] {
  const error = validateRoutineGraph(steps);
  if (error) throw new Error(error);
  const levels = routineGraphLevels(steps);
  return [...levels.before.flat(), ...levels.after.flat()];
}
