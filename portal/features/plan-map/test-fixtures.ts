import type { PlanFinding, PlanLink, PlanMap } from "@openrhen/contracts";

let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

export function link(overrides: Partial<PlanLink> = {}): PlanLink {
  return {
    id: uuid(),
    fromType: "action",
    fromId: "a1",
    toType: "subject",
    toId: "maths",
    kind: "about",
    weight: null,
    status: "suggested",
    proposer: "rule:keywords",
    evidence: [],
    createdAt: "2026-09-20T00:00:00.000Z",
    decidedAt: null,
    lastConfirmedAt: null,
    ...overrides
  };
}

export function finding(overrides: Partial<PlanFinding> = {}): PlanFinding {
  return {
    id: uuid(),
    checkName: "gap-check",
    itemIds: ["project:p1"],
    text: "Nothing prepares the exam.",
    evidence: ["No action is linked"],
    suggestedChanges: [],
    questions: [],
    status: "open",
    createdAt: "2026-09-20T00:00:00.000Z",
    decidedAt: null,
    ...overrides
  };
}

export const titles = {
  actions: [
    { id: "a1", title: "Practice paper" },
    { id: "a2", title: "Meal prep" }
  ],
  projects: [
    { id: "p1", title: "Maths exam" },
    { id: "p2", title: "Drafting folio" }
  ],
  deliverables: [{ id: "d1", title: "Folio sheet" }],
  commitments: [
    { id: "c-once", title: "Dentist" },
    { id: "c-occ", title: "Squad (Tue)", recurrenceRuleId: "rule-squad" }
  ],
  commitmentRecurrenceRules: [{ id: "rule-squad", title: "Swim squad" }]
};

export function planMap(overrides: Partial<PlanMap> = {}): PlanMap {
  return {
    subjects: [
      { id: "maths", name: "Maths", description: null, status: "active" },
      { id: "meals", name: "Meals", description: null, status: "active" }
    ],
    links: [],
    findings: [],
    switches: [],
    ...overrides
  };
}
