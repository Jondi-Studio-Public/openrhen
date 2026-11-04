/** Cycle detection for the dependency graphs commands write: actions, steps, deliverables, routines. */
import { InvalidCommandError } from "./command-errors";
import { requiredText, stringList } from "./command-values";

export function hasCycle(graph: Map<string, string[]>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if ((graph.get(id) ?? []).some(visit)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return [...graph.keys()].some(visit);
}

export function validateRoutineEntityGraph(steps: Record<string, unknown>[]) {
  const ids = steps.map((step) => requiredText(step.id, "Routine step id"));
  if (new Set(ids).size !== ids.length) throw new InvalidCommandError("Every routine step needs a unique id.");
  const known = new Set(ids);
  const phases = new Map(
    steps.map((step) => [requiredText(step.id, "Routine step id"), step.phase === "after" ? "after" : "before"])
  );
  const dependencies = new Map<string, string[]>();
  for (const step of steps) {
    const id = requiredText(step.id, "Routine step id");
    const values = stringList(step.dependencyIds);
    if (values.includes(id)) throw new InvalidCommandError("A routine step cannot depend on itself.");
    if (values.some((value) => !known.has(value)))
      throw new InvalidCommandError("A routine connection refers to a missing step.");
    if (values.some((value) => phases.get(value) !== phases.get(id)))
      throw new InvalidCommandError("A routine step cannot connect across before/after the commitment.");
    dependencies.set(id, values);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if ((dependencies.get(id) ?? []).some(visit)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  if (ids.some(visit)) throw new InvalidCommandError("Routine connections cannot form a cycle.");
}
