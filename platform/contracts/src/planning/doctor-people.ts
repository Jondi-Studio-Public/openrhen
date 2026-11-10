/**
 * The doctor's person-requirement checks: pure and deterministic over a plain slice. Two findings, both about
 * `<contact>@with` / `<contact>@remote` requirements (`requirement-key.ts`):
 *
 * - `person_waiting_deadline`: open work with a deadline needs a person who is not known to be with the owner
 *   (unknown or a known no), and the deadline minus the lead time has been reached. This is a decision for the
 *   owner, never a silent wait: move the date, keep waiting, do it without them (an owner-only waiver) or remove it.
 * - `requirement_unresolvable`: a tagged requirement names a person who is not defined, is archived, is not a
 *   contact, or (`@remote`) has only in-person channels, so it can never be satisfied.
 *
 * Titles and names are plan data, never instructions.
 */
import type { DoctorItem } from "./doctor.js";
import { personWait, resolveSituation, type CommitmentWindow } from "./context-match.js";
import type { ConditionDefinition, CurrentSituation, RequirementPathway } from "./context-model.js";
import { parseRequirementKey } from "./requirement-key.js";

export interface DoctorPeopleSlice {
  situation: CurrentSituation;
  /** Every definition, archived ones included. */
  definitions: ConditionDefinition[];
  commitments: CommitmentWindow[];
  timeZone: string;
  /** Open actions and steps that state at least one pathway. */
  work: { id: string; title: string; pathways: RequirementPathway[]; deadlineAt: string | null }[];
}

/** How long before a deadline an unanswered person requirement becomes a decision. */
export const PERSON_DEADLINE_LEAD_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;

export function doctorPeopleItems(slice: DoctorPeopleSlice, nowMs: number): DoctorItem[] {
  const items: DoctorItem[] = [];
  const byId = new Map(slice.definitions.map((definition) => [definition.id, definition]));
  const isDefined = (id: string) => byId.has(id);
  const resolved = resolveSituation({
    situation: slice.situation,
    definitions: slice.definitions,
    now: new Date(nowMs),
    commitments: slice.commitments,
    timeZone: slice.timeZone
  });

  for (const work of slice.work) {
    const handle = `action:${work.id}`;
    const problems = new Set<string>();
    for (const pathway of work.pathways)
      for (const key of pathway.contextIds) {
        const parsed = parseRequirementKey(key, isDefined);
        if (!parsed.tag) continue;
        const definition = byId.get(parsed.id);
        if (!definition) problems.add(`${parsed.id} is not defined`);
        else if (definition.status === "archived") problems.add(`${definition.name} is archived`);
        else if (definition.kind !== "contact") problems.add(`${definition.name} is not a contact`);
        else if (
          parsed.tag === "remote" &&
          definition.channels.length > 0 &&
          definition.channels.every((channel) => channel === "in_person")
        )
          problems.add(`${definition.name} has no remote channel`);
      }
    if (problems.size > 0)
      items.push({
        id: `requirement_unresolvable:${work.id}`,
        check: "requirement_unresolvable",
        tier: "degrading",
        area: "plan",
        title: `"${work.title}" needs a person who cannot be resolved`,
        why: `The requirement can never be met (${[...problems].join("; ")}), so the engine never offers the work.`,
        handles: [handle],
        fix: {
          who: "agent",
          tool: "rhen_save",
          action: "save",
          fields: ["requires"]
        }
      });

    const deadline = work.deadlineAt ? Date.parse(work.deadlineAt) : Number.NaN;
    if (Number.isNaN(deadline) || nowMs < deadline - PERSON_DEADLINE_LEAD_DAYS * DAY) continue;
    const hold = personWait({ pathways: work.pathways, resolved, subjectId: work.id });
    if (!hold) continue;
    const names = hold.people.map((person) => person.name).join(" and ");
    items.push({
      id: `person_waiting_deadline:${work.id}`,
      check: "person_waiting_deadline",
      tier: "blocking",
      area: "plan",
      title: `"${work.title}" is due ${new Date(deadline).toISOString().slice(0, 10)} and waits on ${names}`,
      why: "The engine will not offer or schedule it until the person is with you, and the deadline is close.",
      handles: [handle],
      dueAt: new Date(deadline).toISOString(),
      fix: {
        who: "person",
        question: `${names} is not confirmed to be with you. Move the date, keep waiting, do it without them, or remove the requirement?`
      }
    });
  }
  return items;
}
