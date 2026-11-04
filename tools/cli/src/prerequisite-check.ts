import { firstPrerequisiteCycle, prerequisiteNodes, prerequisiteRefSchema } from "@openrhen/contracts";
import { z } from "zod";
import type { PortalState } from "./client.js";
import { CliError, EXIT } from "./errors.js";

type Fields = Record<string, unknown>;
const KINDS = { project: "project", action: "action", deliverable: "deliverable" } as const;

/**
 * Checks the prerequisites a `save project|action|deliverable` is about to write, so a bad edge is
 * refused here with a plain sentence instead of surfacing as a server error: refs must be
 * `{kind, id}` naming a real record, an action or deliverable may not list its own kind (that is
 * `dependencyIds`), a child may not wait on its own project, and no loop. A save that carries no
 * `prerequisites` and no `dependencyIds` is not checked.
 */
export function checkPrerequisites(canonical: string, entity: Fields, state: PortalState): void {
  const kind = KINDS[canonical as keyof typeof KINDS];
  if (!kind) return;
  if (entity.prerequisites === undefined && entity.dependencyIds === undefined) return;
  const parsed = z.array(prerequisiteRefSchema).safeParse(entity.prerequisites ?? []);
  if (!parsed.success)
    throw new CliError(
      'prerequisites must be a list of {"kind":"project|deliverable|action","id":"..."} entries.',
      EXIT.validation,
      parsed.error.issues
    );
  const prerequisites = parsed.data;
  const dependencyIds = Array.isArray(entity.dependencyIds) ? entity.dependencyIds.map(String) : [];
  const id = typeof entity.id === "string" && entity.id ? entity.id : "new";
  const projectId = typeof entity.projectId === "string" ? entity.projectId : undefined;

  const known = {
    project: new Set(state.projects.map((item) => item.id)),
    deliverable: new Set(state.deliverables.map((item) => item.id)),
    action: new Set(state.actions.map((item) => item.id))
  };
  for (const ref of prerequisites) {
    if (!known[ref.kind].has(ref.id) && !(ref.kind === kind && ref.id === id))
      throw new CliError(`prerequisites names ${ref.kind} "${ref.id}", which does not exist.`, EXIT.validation);
    if (ref.kind === kind && kind !== "project")
      throw new CliError(
        `An ${kind} lists other ${kind}s in dependencyIds, not prerequisites (${ref.id}).`,
        EXIT.validation
      );
    if (ref.kind === kind && ref.id === id)
      throw new CliError(`A ${kind} cannot be its own prerequisite.`, EXIT.validation);
    if (ref.kind === "project" && ref.id === projectId)
      throw new CliError(`A ${kind} cannot depend on its own project.`, EXIT.validation);
  }

  const withEntity = <T extends { id: string }>(items: T[], make: () => T, patch: Partial<T>): T[] =>
    (items.some((item) => item.id === id) ? items : [...items, make()]).map((item) =>
      item.id === id ? { ...item, ...patch } : item
    );
  const nodes = prerequisiteNodes({
    projects:
      kind === "project"
        ? withEntity(state.projects, () => ({ id, title: "", status: "active" }) as (typeof state.projects)[number], {
            prerequisites
          })
        : state.projects,
    deliverables:
      kind === "deliverable"
        ? withEntity(
            state.deliverables,
            () =>
              ({ id, title: "", projectId: projectId ?? "", status: "ready" }) as (typeof state.deliverables)[number],
            { dependencyIds, prerequisites }
          )
        : state.deliverables,
    actions:
      kind === "action"
        ? withEntity(
            state.actions,
            () => ({ id, title: "", projectId: projectId ?? "", status: "planned" }) as (typeof state.actions)[number],
            { dependencyIds, prerequisites }
          )
        : state.actions
  });
  // A loop that was already there is not this save's doing.
  if (firstPrerequisiteCycle(prerequisiteNodes(state))) return;
  if (firstPrerequisiteCycle(nodes)) throw new CliError("Those prerequisites would create a cycle.", EXIT.validation);
}
