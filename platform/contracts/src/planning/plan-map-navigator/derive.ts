import type { ItemType, MapEdge, MapItem } from "./model.js";

type AnyRecord = Record<string, unknown>;
const asRecords = (items: unknown): AnyRecord[] => (Array.isArray(items) ? (items as AnyRecord[]) : []);

/**
 * The slice of the portal state the map reads. Structural on purpose: the CLI hands it the parsed
 * `GET /api/state` document and the portal hands it its in-memory state, and neither is typed to the other.
 */
export type PlanMapState = object;

/** Subjects live in the link store, not the plan, so the caller supplies them. */
export interface SubjectRef {
  id: string;
  name: string;
}

export interface BuildOptions {
  subjects?: readonly SubjectRef[];
}

export interface PlanIndex {
  items: Map<string, MapItem>;
  edges: MapEdge[];
}

const str = (record: AnyRecord, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : undefined;
};
const strings = (record: AnyRecord, key: string): string[] => {
  const value = record[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
};

export const handleOf = (type: ItemType, id: string): string => `${type}:${id}`;

/**
 * Reads the whole portal state once into items and derived edges. Nothing is stored: every call
 * recomputes from the rows it was given, so a card or an edge can never be stale.
 */
export function buildPlanIndex(source: PlanMapState, options: BuildOptions = {}): PlanIndex {
  const state = source as Record<string, unknown>;
  const items = new Map<string, MapItem>();
  const edges: MapEdge[] = [];
  const seenEdges = new Set<string>();

  const addItem = (item: Omit<MapItem, "handle">): string => {
    const handle = handleOf(item.type, item.id);
    items.set(handle, { handle, ...item });
    return handle;
  };
  const addEdge = (edge: Omit<MapEdge, "origin">): void => {
    if (edge.from === edge.to) return;
    const key = `${edge.from}|${edge.to}|${edge.kind}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push({ ...edge, origin: "derived" });
  };
  const tree = (parent: string | undefined, child: string): void => {
    if (parent) addEdge({ from: parent, to: child, kind: "parent_child" });
  };

  const areas = asRecords(state.areas);
  const outcomes = asRecords(state.outcomes);
  const projects = asRecords(state.projects);
  const actions = asRecords(state.actions);
  const deliverables = asRecords(state.deliverables);
  const commitments = asRecords(state.commitments);
  const rules = asRecords(state.commitmentRecurrenceRules);
  const conditions = asRecords(state.conditionDefinitions);

  for (const subject of options.subjects ?? [])
    addItem({ type: "subject", id: subject.id, title: subject.name, detail: "subject" });

  // Pass 1: the items. Parents are resolved to handles in pass 2, once every id is known.
  for (const area of areas)
    addItem({ type: "area", id: String(area.id), title: String(area.name), status: str(area, "status") });
  for (const outcome of outcomes)
    addItem({
      type: "outcome",
      id: String(outcome.id),
      title: String(outcome.title),
      status: str(outcome, "status"),
      when: str(outcome, "deadlineAt"),
      detail: str(outcome, "definitionOfDone")
    });
  for (const project of projects)
    addItem({
      type: "project",
      id: String(project.id),
      title: String(project.title),
      status: str(project, "status"),
      when: str(project, "externalDeadlineAt") ?? str(project, "internalDeadlineAt"),
      detail: `value ${String(project.value)}, consequence ${String(project.consequence)}`
    });
  for (const action of actions)
    addItem({
      type: "action",
      id: String(action.id),
      title: String(action.title),
      status: str(action, "status"),
      when: str(action, "deadlineAt"),
      detail: `${String(action.remainingMinutes)}m left, ${String(action.energy)}, ${String(action.schedulingMode ?? "one_off")}`
    });
  for (const deliverable of deliverables) {
    const criteria = asRecords(deliverable.criteria);
    const satisfied = criteria.filter((criterion) => criterion.state === "satisfied").length;
    addItem({
      type: "deliverable",
      id: String(deliverable.id),
      title: String(deliverable.title),
      status: str(deliverable, "status"),
      when: str(deliverable, "externalDeadlineAt") ?? str(deliverable, "internalDeadlineAt"),
      detail: `${satisfied}/${criteria.length} criteria satisfied`
    });
    for (const step of asRecords(deliverable.steps))
      addItem({
        type: "step",
        id: String(step.id),
        title: String(step.title),
        status: str(step, "status"),
        detail: `${String(step.remainingMinutes)}m left, ${String(step.energy)}`
      });
    for (const criterion of criteria)
      addItem({
        type: "criterion",
        id: String(criterion.id),
        title: String(criterion.title),
        status: str(criterion, "state"),
        detail: criterion.required === false ? "optional" : "required"
      });
    for (const blocker of asRecords(deliverable.blockers))
      addItem({
        type: "blocker",
        id: String(blocker.id),
        title: String(blocker.description),
        status: str(blocker, "state"),
        detail: str(blocker, "category")
      });
  }
  for (const commitment of commitments)
    addItem({
      type: "commitment",
      id: String(commitment.id),
      title: String(commitment.title),
      status: str(commitment, "status"),
      when: str(commitment, "startsAt"),
      detail: str(commitment, "location")
    });
  for (const rule of rules)
    addItem({
      type: "rule",
      id: String(rule.id),
      title: String(rule.title),
      status: str(rule, "status"),
      detail: `${String(rule.localStartTime)}-${String(rule.localEndTime)} from ${String(rule.startDate)}`
    });
  for (const condition of conditions) {
    const kind = condition.kind;
    const type: ItemType | undefined = kind === "location" ? "place" : kind === "contact" ? "contact" : undefined;
    // A capability or live condition is a hub too, but only once something requires it; see below.
    if (type)
      addItem({
        type,
        id: String(condition.id),
        title: String(condition.name),
        status: str(condition, "status"),
        detail: str(condition, "address")
      });
  }
  const conditionById = new Map(conditions.map((condition) => [String(condition.id), condition]));
  /** The hub for a condition id: a place or contact where the id names one, otherwise a context item made on demand. */
  const hubForCondition = (id: string): string => {
    const known = conditionById.get(id);
    const type: ItemType = known?.kind === "location" ? "place" : known?.kind === "contact" ? "contact" : "context";
    const handle = handleOf(type, id);
    if (!items.has(handle))
      addItem({
        type,
        id,
        title: known ? String(known.name) : id,
        status: known ? str(known, "status") : undefined
      });
    return handle;
  };

  // Pass 2: tree parents and the edges the hard tables already hold.
  const parentOf = (item: MapItem, parent: string | undefined) => {
    if (parent && items.has(parent)) {
      item.parent = parent;
      tree(parent, item.handle);
    }
  };
  for (const outcome of outcomes)
    parentOf(items.get(handleOf("outcome", String(outcome.id)))!, ref("area", str(outcome, "areaId")));
  for (const project of projects) {
    const item = items.get(handleOf("project", String(project.id)))!;
    parentOf(item, ref("outcome", str(project, "outcomeId")) ?? ref("area", str(project, "area")));
  }
  /** Extra prerequisites (`planning/prerequisites.ts`): any edge from or to a project, and mixed kinds. */
  const addExtraPrerequisites = (from: string, owner: Record<string, unknown>) => {
    for (const prerequisite of asRecords(owner.prerequisites)) {
      const kind = str(prerequisite, "kind");
      const id = str(prerequisite, "id");
      if (id && (kind === "project" || kind === "deliverable" || kind === "action") && items.has(handleOf(kind, id)))
        addEdge({ from, to: handleOf(kind, id), kind: "depends_on" });
    }
  };
  for (const project of projects) addExtraPrerequisites(handleOf("project", String(project.id)), project);
  for (const action of actions) {
    const item = items.get(handleOf("action", String(action.id)))!;
    parentOf(item, ref("project", str(action, "projectId")));
    addExtraPrerequisites(item.handle, action);
    for (const dependency of strings(action, "dependencyIds"))
      addEdge({ from: item.handle, to: handleOf("action", dependency), kind: "depends_on" });
    const prepFor = str(action, "prepForCommitmentId");
    if (prepFor) addEdge({ from: item.handle, to: handleOf("commitment", prepFor), kind: "prep" });
    for (const pathway of asRecords(action.requirementPathways))
      for (const contextId of strings(pathway, "contextIds"))
        addEdge({
          from: item.handle,
          to: hubForCondition(contextId),
          kind: "same_place",
          evidence: `requires ${contextId}`
        });
  }
  for (const deliverable of deliverables) {
    const item = items.get(handleOf("deliverable", String(deliverable.id)))!;
    parentOf(item, ref("project", str(deliverable, "projectId")));
    addExtraPrerequisites(item.handle, deliverable);
    for (const dependency of strings(deliverable, "dependencyIds"))
      addEdge({ from: item.handle, to: handleOf("deliverable", dependency), kind: "depends_on" });
    for (const sourceId of strings(deliverable, "sourceIds")) {
      const hub = handleOf("source", sourceId);
      if (!items.has(hub)) addItem({ type: "source", id: sourceId, title: sourceId });
      addEdge({ from: item.handle, to: hub, kind: "same_source" });
    }
    for (const step of asRecords(deliverable.steps)) {
      const stepItem = items.get(handleOf("step", String(step.id)))!;
      parentOf(stepItem, item.handle);
      for (const dependency of strings(step, "dependencyIds"))
        addEdge({ from: stepItem.handle, to: handleOf("step", dependency), kind: "depends_on" });
      for (const pathway of asRecords(step.requirementPathways))
        for (const contextId of strings(pathway, "contextIds"))
          addEdge({
            from: stepItem.handle,
            to: hubForCondition(contextId),
            kind: "same_place",
            evidence: `requires ${contextId}`
          });
    }
    for (const criterion of asRecords(deliverable.criteria)) {
      const criterionItem = items.get(handleOf("criterion", String(criterion.id)))!;
      parentOf(criterionItem, item.handle);
      for (const stepId of strings(criterion, "stepIds"))
        addEdge({ from: handleOf("step", stepId), to: criterionItem.handle, kind: "criterion" });
    }
    for (const blocker of asRecords(deliverable.blockers)) {
      const blockerItem = items.get(handleOf("blocker", String(blocker.id)))!;
      parentOf(blockerItem, item.handle);
      for (const stepId of strings(blocker, "stepIds"))
        addEdge({ from: handleOf("step", stepId), to: blockerItem.handle, kind: "blocker" });
    }
  }
  for (const rule of rules) {
    const item = items.get(handleOf("rule", String(rule.id)))!;
    parentOf(item, ref("project", str(rule, "projectId")));
    linkPlaceAndContact(item.handle, rule);
  }
  for (const commitment of commitments) {
    const item = items.get(handleOf("commitment", String(commitment.id)))!;
    parentOf(item, ref("rule", str(commitment, "recurrenceRuleId")) ?? ref("project", str(commitment, "projectId")));
    linkPlaceAndContact(item.handle, commitment);
  }

  // Edges into things that do not exist (a dangling dependency id) are dropped, not shown.
  return { items, edges: edges.filter((edge) => items.has(edge.from) && items.has(edge.to)) };

  function ref(type: ItemType, id: string | undefined): string | undefined {
    return id ? handleOf(type, id) : undefined;
  }
  function linkPlaceAndContact(handle: string, record: AnyRecord): void {
    const locationId = str(record, "locationId");
    if (locationId) addEdge({ from: handle, to: hubForCondition(locationId), kind: "same_place" });
    const contactId = str(record, "contactId");
    if (contactId) addEdge({ from: handle, to: hubForCondition(contactId), kind: "same_contact" });
  }
}
