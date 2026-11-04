import { describe, expect, it } from "vitest";
import {
  extractUnitCodes,
  healthFindingKey,
  planHealthCheckLabel,
  runPlanHealthChecks,
  type HealthSnapshot
} from "./plan-health.js";

const CODE_PATTERN = String.raw`\b(?![A-Z]{3}[5-9]\d{4}\b)(?:[A-Z]{3,7}\d{3,4}[A-Z]?|[A-Z]{3}\d{5})\b`;

const NOW = new Date("2026-10-01T00:00:00.000Z");
const inDays = (days: number) => new Date(NOW.getTime() + days * 86_400_000);

function snapshot(overrides: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    now: NOW,
    projects: [],
    deliverables: [],
    actions: [],
    blockers: [],
    commitments: [],
    emails: [],
    proposals: [],
    links: [],
    subjects: [],
    codePattern: CODE_PATTERN,
    ...overrides
  };
}
const project = (id: string, title: string, deadline: Date | null = null, status = "active") => ({
  id,
  title,
  status,
  externalDeadlineAt: deadline
});
const deliverable = (id: string, projectId: string, extra: Record<string, unknown> = {}) => ({
  id,
  projectId,
  title: `Assessment ${id}`,
  status: "in_progress",
  externalDeadlineAt: null,
  actionCount: 1,
  criterionCount: 1,
  ...extra
});
const run = (overrides: Partial<HealthSnapshot>, check: string) =>
  runPlanHealthChecks(snapshot(overrides)).filter((finding) => finding.checkName === check);

describe("unit codes", () => {
  it("reads units and ignores qualification codes", () => {
    expect(extractUnitCodes("ABC10001 and ABC10002, then ABC50222 and QRSTUV272", CODE_PATTERN)).toEqual([
      "ABC10001",
      "ABC10002",
      "QRSTUV272"
    ]);
    expect(extractUnitCodes("ABC50222", CODE_PATTERN)).toEqual([]);
    expect(extractUnitCodes("ABC20001", CODE_PATTERN)).toEqual(["ABC20001"]);
    expect(extractUnitCodes(null, CODE_PATTERN)).toEqual([]);
    expect(extractUnitCodes("ABC10001", null)).toEqual([]);
  });

  it("raises a finding for a code in a commitment or email with no project, and none once a project names it", () => {
    const base = {
      commitments: [{ id: "c1", title: "ABC10001 class", startsAt: inDays(2), status: "confirmed" }],
      emails: [{ id: "e1", subject: "Re: ABC10001 results", receivedAt: inDays(-3), unitCodes: [] }]
    };
    const found = run(base, "unit_code_no_project");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ itemIds: ["commitment:c1"] });
    expect(found[0]!.text).toContain("ABC10001");
    expect(found[0]!.evidence).toHaveLength(2);
    expect(run({ ...base, projects: [project("p1", "ABC10001 Apply engineering")] }, "unit_code_no_project")).toEqual(
      []
    );
    expect(
      run(
        {
          ...base,
          projects: [project("p1", "Trade")],
          deliverables: [deliverable("d1", "p1", { title: "ABC10001 A1" })]
        },
        "unit_code_no_project"
      )
    ).toEqual([]);
  });

  it("ignores old commitments, cancelled ones and old emails", () => {
    const found = run(
      {
        commitments: [
          { id: "c1", title: "ABC10001 class", startsAt: inDays(-60), status: "confirmed" },
          { id: "c2", title: "ABC10001 class", startsAt: inDays(2), status: "cancelled" }
        ],
        emails: [{ id: "e1", subject: "ABC10001", receivedAt: inDays(-200), unitCodes: [] }]
      },
      "unit_code_no_project"
    );
    expect(found).toEqual([]);
  });

  it("matches codes as written, so order and reference numbers are not units", () => {
    expect(extractUnitCodes("INV10023 ref12345 Order123456 ABC20001", CODE_PATTERN)).toEqual(["INV10023", "ABC20001"]);
    expect(extractUnitCodes("abc20001", CODE_PATTERN, true)).toEqual(["ABC20001"]);
    const found = run(
      {
        emails: [
          { id: "e1", subject: "Invoice INV10023 paid", receivedAt: inDays(-1), unitCodes: [] },
          { id: "e2", subject: "Class ABC20001 moved", receivedAt: inDays(-1), unitCodes: [] }
        ],
        commitments: [{ id: "c1", title: "ABC20001 class", startsAt: inDays(1), status: "confirmed" }],
        projects: [project("p1", "abc20001 lower-case title is still a project")]
      },
      "unit_code_no_project"
    );
    expect(found).toEqual([]);
    const subjectOnly = run(
      { emails: [{ id: "e2", subject: "Class ABC20001 moved", receivedAt: inDays(-1), unitCodes: [] }] },
      "unit_code_no_project"
    );
    expect(subjectOnly).toEqual([]);
  });

  it("reads codes the extraction named on an email", () => {
    const found = run(
      { emails: [{ id: "e1", subject: "Your results", receivedAt: inDays(-1), unitCodes: ["ABC10002"] }] },
      "unit_code_no_project"
    );
    expect(found[0]!.text).toContain("ABC10002");
    expect(found[0]!.itemIds).toEqual([]);
  });
});

describe("stale deadlines", () => {
  it("flags an active project or deliverable whose deadline has passed, not a finished or future one", () => {
    const found = run(
      {
        projects: [
          project("p1", "Past", inDays(-5)),
          project("p2", "Future", inDays(5)),
          project("p3", "Done", inDays(-5), "done")
        ],
        deliverables: [
          deliverable("d1", "p1", { externalDeadlineAt: inDays(-2) }),
          deliverable("d2", "p1", { externalDeadlineAt: inDays(-2), status: "completed" }),
          deliverable("d3", "p3", { externalDeadlineAt: inDays(-2) })
        ]
      },
      "stale_deadline"
    );
    expect(found.map((finding) => finding.itemIds[0])).toEqual(["project:p1", "deliverable:d1"]);
    expect(found[0]!.text).toContain("2026-09-26");
  });
});

describe("empty assessments", () => {
  it("flags an active deliverable with no steps and no criteria only", () => {
    const found = run(
      {
        projects: [project("p1", "P")],
        deliverables: [
          deliverable("d1", "p1", { actionCount: 0, criterionCount: 0 }),
          deliverable("d2", "p1", { actionCount: 0, criterionCount: 2 }),
          deliverable("d3", "p1", { actionCount: 0, criterionCount: 0, status: "cancelled" })
        ]
      },
      "empty_assessment"
    );
    expect(found.map((finding) => finding.itemIds)).toEqual([["deliverable:d1"]]);
  });
});

describe("blockers with no person", () => {
  const blocker = (id: string, category = "waiting_on_someone", state = "open") => ({
    id,
    deliverableId: "d1",
    description: "Waiting for the trainer to confirm the brief",
    category,
    state
  });
  const base = { projects: [project("p1", "P")], deliverables: [deliverable("d1", "p1")] };

  it("flags an open waiting-on-someone blocker with no confirmed contact link", () => {
    expect(run({ ...base, blockers: [blocker("b1")] }, "blocker_no_person")).toHaveLength(1);
    expect(run({ ...base, blockers: [blocker("b1", "prerequisite")] }, "blocker_no_person")).toEqual([]);
    expect(run({ ...base, blockers: [blocker("b1", "waiting_on_someone", "resolved")] }, "blocker_no_person")).toEqual(
      []
    );
  });

  it("is satisfied by a confirmed involves link to a contact, not a suggested one", () => {
    const link = (status: string) => ({
      fromType: "deliverable",
      fromId: "d1",
      toType: "contact",
      toId: "trainer",
      kind: "involves",
      status
    });
    expect(run({ ...base, blockers: [blocker("b1")], links: [link("confirmed")] }, "blocker_no_person")).toEqual([]);
    expect(run({ ...base, blockers: [blocker("b1")], links: [link("suggested")] }, "blocker_no_person")).toHaveLength(
      1
    );
  });
});

describe("no practice before a deadline", () => {
  const about = (type: string, id: string, status = "confirmed") => ({
    fromType: type,
    fromId: id,
    toType: "subject",
    toId: "maths",
    kind: "about",
    status
  });
  const base = {
    subjects: [{ id: "maths", name: "Maths", status: "active" }],
    projects: [project("p1", "Maths exam prep", inDays(6))]
  };

  it("flags a subject with a deadline inside 14 days and nothing preparing", () => {
    const found = run({ ...base, links: [about("project", "p1")] }, "no_practice_before_deadline");
    expect(found).toHaveLength(1);
    expect(found[0]!.itemIds).toEqual(["subject:maths", "project:p1"]);
    expect(found[0]!.text).toContain("Maths");
  });

  it("stays quiet with no confirmed about link, a far deadline, or a suggested link", () => {
    expect(run({ ...base, links: [about("project", "p1", "suggested")] }, "no_practice_before_deadline")).toEqual([]);
    expect(
      run(
        { ...base, projects: [project("p1", "x", inDays(40))], links: [about("project", "p1")] },
        "no_practice_before_deadline"
      )
    ).toEqual([]);
    expect(run(base, "no_practice_before_deadline")).toEqual([]);
  });

  it("is satisfied by an open action that prepares the subject or the item, or a cadence action about the subject", () => {
    const action = (id: string, schedulingMode = "one_off", status = "planned") => ({
      id,
      projectId: "p1",
      title: `Practice ${id}`,
      status,
      deadlineAt: null,
      schedulingMode
    });
    const prepares = (toType: string, toId: string) => ({
      fromType: "action",
      fromId: "a1",
      toType,
      toId,
      kind: "prepares",
      status: "confirmed"
    });
    const links = [about("project", "p1")];
    expect(
      run(
        { ...base, actions: [action("a1")], links: [...links, prepares("subject", "maths")] },
        "no_practice_before_deadline"
      )
    ).toEqual([]);
    expect(
      run(
        { ...base, actions: [action("a1")], links: [...links, prepares("project", "p1")] },
        "no_practice_before_deadline"
      )
    ).toEqual([]);
    expect(
      run(
        { ...base, actions: [action("a1", "one_off", "done")], links: [...links, prepares("subject", "maths")] },
        "no_practice_before_deadline"
      )
    ).toHaveLength(1);
    expect(
      run(
        { ...base, actions: [action("a2", "cadence")], links: [...links, about("action", "a2")] },
        "no_practice_before_deadline"
      )
    ).toEqual([]);
  });
});

describe("duplicate captures", () => {
  it("flags pending proposals that would create the same thing, and open duplicate actions", () => {
    const found = run(
      {
        projects: [project("p1", "P")],
        proposals: [
          { id: "1", sourceId: "s1", proposalType: "action", title: "Book dentist" },
          { id: "2", sourceId: "s2", proposalType: "action", title: "Re: book  dentist" },
          { id: "3", sourceId: "s3", proposalType: "commitment", title: "Book dentist" }
        ],
        actions: [
          {
            id: "a1",
            projectId: "p1",
            title: "Send form",
            status: "planned",
            deadlineAt: null,
            schedulingMode: "one_off"
          },
          {
            id: "a2",
            projectId: "p1",
            title: "send form",
            status: "inbox",
            deadlineAt: null,
            schedulingMode: "one_off"
          },
          { id: "a3", projectId: "p1", title: "Send form", status: "done", deadlineAt: null, schedulingMode: "one_off" }
        ]
      },
      "duplicate_captures"
    );
    expect(found).toHaveLength(2);
    expect(found[0]!.itemIds).toEqual(["source:s1", "source:s2"]);
    expect(found[1]!.itemIds).toEqual(["action:a1", "action:a2"]);
  });
});

describe("finding identity", () => {
  it("is stable across days: no counts or dates of the run in the text", () => {
    const input = {
      emails: [{ id: "e1", subject: "Results", receivedAt: inDays(-1), unitCodes: ["ABC10001"] }]
    };
    const first = runPlanHealthChecks(snapshot(input));
    const second = runPlanHealthChecks(
      snapshot({
        ...input,
        now: inDays(3),
        emails: [...input.emails, { id: "e2", subject: "ABC10001 again", receivedAt: inDays(2), unitCodes: [] }]
      })
    );
    expect(healthFindingKey(first[0]!)).toBe(healthFindingKey(second[0]!));
  });

  it("labels known checks and passes unknown names through", () => {
    expect(planHealthCheckLabel("stale_deadline")).toBe("Deadline passed on an active item");
    expect(planHealthCheckLabel("something_else")).toBe("something_else");
  });
});
