/**
 * The demo household's plan: capabilities and places, areas, outcomes, projects, deliverables, routine
 * presets and actions. Dates are written against the fictional "today" of Tue 2026-10-27 and moved by
 * `demo-dates.ts` at run time. Ids are aliases: the portal rewrites custom ids to UUIDv5 on save, so
 * the seed finds records again by title or name, never by these ids.
 */
export type Fields = Record<string, unknown>;

const LAP = "cap-laptop";
const PH = "cap-phone";
const CAR = "cap-car";

const condition = (fields: Fields): Fields => ({
  status: "active",
  pathways: [],
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0,
  ...fields
});

const capability = (id: string, name: string, portability: "portable" | "fixed"): Fields =>
  condition({ id, name, kind: "capability", portability, channels: ["in_person"] });

const location = (
  id: string,
  name: string,
  latitude: number,
  longitude: number,
  address: string,
  travelMinutes?: number,
  usualTransportMode?: string,
  extra: Fields = {}
): Fields =>
  condition({
    id,
    name,
    kind: "location",
    portability: "fixed",
    channels: ["in_person"],
    latitude,
    longitude,
    address,
    ...(travelMinutes === undefined ? {} : { travelMinutes }),
    ...(usualTransportMode === undefined ? {} : { usualTransportMode }),
    ...extra
  });

/** Capabilities first: a place's `grants` refer to them by id. */
export const CONDITIONS: Fields[] = [
  capability(LAP, "Laptop", "portable"),
  capability(PH, "Phone", "portable"),
  capability(CAR, "Car", "portable"),
  capability("cap-server", "Home server", "fixed"),
  location("ctx-home", "Home", 39.5, -71.0, "14 Elm Street, Riverside", undefined, undefined, {
    grants: ["cap-server"]
  }),
  location("ctx-work", "Harbor Mart (Riverside Mall)", 39.498, -70.9981, "Riverside Mall, 150 Main Street", 15, "car"),
  location("ctx-gym", "Fit Hub Gym", 39.503, -70.9911, "2 Station Lane, Riverside", 10, "car"),
  location("ctx-college", "Riverside Community College", 39.482, -70.9911, "College Avenue, Riverside", 20, "car"),
  location("ctx-school", "Maple Elementary School", 39.495, -71.0111, "Maple Avenue, Riverside", 8, "walk"),
  location("ctx-dentist", "Riverside Dental", 39.499, -70.9971, "Suite 1, 22 Oak Street", 12, "car"),
  location("ctx-shops", "Corner Grocer", 39.501, -70.9991, "Main Street, Riverside", 6, "walk"),
  condition({
    id: "con-sam",
    name: "Sam (partner)",
    kind: "contact",
    channels: ["sync_remote", "async"],
    phone: "555-0100"
  }),
  condition({
    id: "con-tutor",
    name: "Instructor (Priya)",
    kind: "contact",
    channels: ["async"],
    email: "priya.teacher@example.invalid"
  })
];

/** A fresh database already holds 7 default areas (including Health and Study); these four sit beside Health. */
export const AREAS: Fields[] = [
  { id: "area-work", name: "Work", description: "Scheduled retail shifts at Harbor Mart" },
  { id: "area-study", name: "Study", description: "IT support certificate at Riverside Community College" },
  { id: "area-home", name: "Home", description: "Household, kids and admin" },
  { id: "area-projects", name: "Projects", description: "Home server and hobby projects" }
].map((area, sortOrder) => ({ ...area, status: "active", sortOrder }));

/** `areaId: "HEALTH"` and `"STUDY"` are replaced with the stored ids of the default Health and Study areas. */
export const OUTCOMES: Fields[] = [
  {
    id: "out-roster",
    areaId: "area-work",
    title: "Hold steady hours and win a supervisor trial",
    definitionOfDone: "Supervisor trial shift confirmed by end of November",
    value: 4,
    deadlineAt: "2026-11-30T17:00:00-05:00"
  },
  {
    id: "out-cert",
    areaId: "STUDY",
    title: "Pass this semester's certificate courses",
    definitionOfDone: "Networking and Cyber Security courses both passed",
    value: 5,
    deadlineAt: "2026-12-04T17:00:00-05:00"
  },
  {
    id: "out-home",
    areaId: "area-home",
    title: "Keep the household running smoothly",
    definitionOfDone: "School admin, bills and repairs are never a surprise",
    value: 4
  },
  {
    id: "out-health",
    areaId: "HEALTH",
    title: "Be fitter and sort overdue health admin",
    definitionOfDone: "Complete 10k fun run and attend dental follow-ups",
    value: 3,
    deadlineAt: "2026-12-06T09:00:00-05:00"
  },
  {
    id: "out-server",
    areaId: "area-projects",
    title: "Home server is reliable and backed up",
    definitionOfDone: "Photos and documents on the home server backed up off-site and restore tested",
    value: 3
  }
].map((outcome) => ({ ...outcome, status: "active" }));

export const PROJECTS: Fields[] = [
  {
    id: "proj-supervisor",
    outcomeId: "out-roster",
    title: "Supervisor trial application",
    uncertainty: "some",
    consequence: 4,
    internalDeadlineAt: "2026-11-13T17:00:00-05:00",
    externalDeadlineAt: "2026-11-20T17:00:00-05:00"
  },
  {
    id: "proj-net",
    outcomeId: "out-cert",
    title: "Networking unit - Assessment 2 and 3",
    uncertainty: "some",
    consequence: 5,
    internalDeadlineAt: "2026-10-29T17:00:00-04:00",
    externalDeadlineAt: "2026-10-30T23:59:00-04:00"
  },
  {
    id: "proj-cyber",
    outcomeId: "out-cert",
    title: "Cyber Security unit workbook",
    uncertainty: "known",
    consequence: 4,
    externalDeadlineAt: "2026-11-05T23:59:00-05:00"
  },
  {
    id: "proj-kids",
    outcomeId: "out-home",
    title: "Kids: end of semester admin",
    uncertainty: "known",
    consequence: 3,
    externalDeadlineAt: "2026-11-06T09:00:00-05:00"
  },
  { id: "proj-house", outcomeId: "out-home", title: "House and car admin", uncertainty: "known", consequence: 3 },
  {
    id: "proj-fitrun",
    outcomeId: "out-health",
    title: "10k fun run training",
    uncertainty: "known",
    consequence: 2,
    externalDeadlineAt: "2026-12-06T09:00:00-05:00"
  },
  {
    id: "proj-dental",
    outcomeId: "out-health",
    title: "Dental check-up and follow-up",
    uncertainty: "known",
    consequence: 3
  },
  {
    id: "proj-server",
    outcomeId: "out-server",
    title: "Home server: SSD migration and off-site backup",
    uncertainty: "high",
    consequence: 2
  }
].map((project) => ({ ...project, status: "active" }));

// ---------------------------------------------------------------------------------------------------------------------
// Deliverables

type StepOptions = {
  deps?: string[];
  ctx?: string[];
  required?: boolean;
  max?: number;
  split?: boolean;
  details?: string;
};

function step(
  index: number,
  id: string,
  title: string,
  status: string,
  expected: number,
  remaining: number,
  energy: string,
  options: StepOptions = {}
): Fields {
  return {
    id,
    title,
    status,
    optimisticMinutes: Math.max(5, Math.floor(expected / 2)),
    expectedMinutes: expected,
    pessimisticMinutes: Math.floor(expected * 1.6),
    remainingMinutes: remaining,
    energy,
    minimumSessionMinutes: Math.min(15, expected),
    maximumSessionMinutes: options.max ?? 60,
    splittable: options.split ?? true,
    setupMinutes: 5,
    required: options.required ?? true,
    sortOrder: index,
    dependencyIds: options.deps ?? [],
    requirementPathways: [{ id: "p1", contextIds: options.ctx ?? [LAP] }],
    ...(options.details ? { details: options.details } : {})
  };
}

function criterion(
  index: number,
  id: string,
  key: string,
  title: string,
  expectedEvidence: string,
  verificationMethod: string,
  state: string,
  stepIds: string[],
  required = true
): Fields {
  return { id, key, title, required, expectedEvidence, verificationMethod, state, sortOrder: index, stepIds };
}

function deliverable(fields: Fields): Fields {
  return {
    uncertainty: "some",
    importance: 3,
    consequence: 3,
    contractVersion: 1,
    planVersion: 1,
    sortOrder: 0,
    dependencyIds: [],
    blockers: [],
    ...fields
  };
}

export const NETWORK_REPORT_TITLE = "Assessment 2: Network design report";

export const DELIVERABLES: Fields[] = [
  deliverable({
    id: "del-net-a2",
    projectId: "proj-net",
    title: NETWORK_REPORT_TITLE,
    details:
      "Design a small-office network (12 users, 2 VLANs) and write up the addressing plan, device list and security choices. 2,000 words plus diagram.",
    status: "in_progress",
    externalDeadlineAt: "2026-10-30T23:59:00-04:00",
    internalDeadlineAt: "2026-10-29T17:00:00-04:00",
    importance: 5,
    consequence: 5,
    completionThreshold: "All required criteria satisfied and submitted via the college's Canvas portal",
    contractApprovedAt: "2026-10-20T19:00:00-04:00",
    planApprovedAt: "2026-10-20T19:30:00-04:00",
    criteria: [
      criterion(
        0,
        "crit-net-1",
        "C1",
        "Logical diagram with VLANs and IP plan",
        "Diagram PNG embedded in the report",
        "llm_inspection",
        "satisfied",
        ["step-net-diagram"]
      ),
      criterion(
        1,
        "crit-net-2",
        "C2",
        "Device list with justification",
        "Table of switches, router, AP with a reason for each",
        "llm_inspection",
        "unsatisfied",
        ["step-net-devices"]
      ),
      criterion(
        2,
        "crit-net-3",
        "C3",
        "Security controls section (firewall rules, guest isolation)",
        "At least 5 named controls with rationale",
        "user_confirmation",
        "unsatisfied",
        ["step-net-security"]
      ),
      criterion(
        3,
        "crit-net-4",
        "C4",
        "Submitted before the deadline",
        "Canvas submission receipt",
        "submission_receipt",
        "unsatisfied",
        ["step-net-submit"]
      )
    ],
    steps: [
      {
        ...step(0, "step-net-diagram", "Draw logical network diagram", "done", 60, 0, "medium", { max: 90 }),
        optimisticMinutes: 45,
        pessimisticMinutes: 90,
        minimumSessionMinutes: 30
      },
      {
        ...step(1, "step-net-devices", "Write device list and justifications", "doing", 60, 40, "medium", {
          deps: ["step-net-diagram"]
        }),
        optimisticMinutes: 45,
        pessimisticMinutes: 90,
        minimumSessionMinutes: 30
      },
      {
        ...step(2, "step-net-security", "Write security controls section", "planned", 90, 90, "high", {
          deps: ["step-net-devices"],
          max: 90
        }),
        optimisticMinutes: 60,
        pessimisticMinutes: 120,
        minimumSessionMinutes: 30
      },
      {
        ...step(3, "step-net-proof", "Proofread and export PDF", "planned", 30, 30, "low", {
          deps: ["step-net-security"],
          max: 45,
          split: false
        }),
        optimisticMinutes: 15,
        pessimisticMinutes: 45,
        setupMinutes: 0
      },
      {
        ...step(4, "step-net-submit", "Submit on Canvas and keep receipt", "planned", 15, 15, "low", {
          deps: ["step-net-proof"],
          max: 15,
          split: false
        }),
        optimisticMinutes: 5,
        pessimisticMinutes: 30,
        minimumSessionMinutes: 5,
        setupMinutes: 0
      }
    ]
  }),
  deliverable({
    id: "del-cyber-wb",
    projectId: "proj-cyber",
    title: "Cyber Security workbook (modules 5-8)",
    details: "Complete the four workbook modules and the end-of-unit quiz on Canvas.",
    status: "ready",
    externalDeadlineAt: "2026-11-05T23:59:00-05:00",
    uncertainty: "known",
    importance: 4,
    consequence: 4,
    completionThreshold: "Workbook marked complete and quiz >= 70%",
    contractApprovedAt: "2026-10-24T10:00:00-04:00",
    planApprovedAt: "2026-10-24T10:10:00-04:00",
    criteria: [
      criterion(
        0,
        "crit-cy-1",
        "C1",
        "Modules 5-8 workbook answers completed",
        "Workbook PDF with every question answered",
        "user_confirmation",
        "unsatisfied",
        ["step-cy-m5", "step-cy-m7"]
      ),
      criterion(
        1,
        "crit-cy-2",
        "C2",
        "End-of-unit quiz at 70% or higher",
        "Canvas quiz result",
        "external_result",
        "unsatisfied",
        ["step-cy-quiz"]
      )
    ],
    steps: [
      step(0, "step-cy-m5", "Workbook modules 5 and 6", "planned", 90, 90, "medium"),
      step(1, "step-cy-m7", "Workbook modules 7 and 8", "planned", 90, 90, "medium", { deps: ["step-cy-m5"] }),
      step(2, "step-cy-quiz", "Sit the end-of-unit quiz", "planned", 45, 45, "high", {
        deps: ["step-cy-m7"],
        max: 45,
        split: false
      })
    ]
  }),
  deliverable({
    id: "del-super-app",
    projectId: "proj-supervisor",
    title: "Supervisor trial application pack",
    details: "Written application (one page), updated resume, and a referee from the store manager.",
    status: "needs_breakdown",
    externalDeadlineAt: "2026-11-20T17:00:00-05:00",
    internalDeadlineAt: "2026-11-13T17:00:00-05:00",
    uncertainty: "high",
    importance: 4,
    consequence: 4,
    sortOrder: 1,
    completionThreshold: "Pack emailed to the store manager and acknowledged",
    criteria: [
      criterion(
        0,
        "crit-sv-1",
        "C1",
        "One-page application addressing the selection criteria",
        "Draft reviewed by Sam",
        "user_confirmation",
        "unsatisfied",
        ["step-sv-draft"]
      ),
      criterion(1, "crit-sv-2", "C2", "Updated resume (2 pages max)", "PDF resume", "llm_inspection", "unsatisfied", [
        "step-sv-resume"
      ]),
      criterion(
        2,
        "crit-sv-3",
        "C3",
        "Referee confirmed",
        "Email reply from referee",
        "external_result",
        "uncertain",
        ["step-sv-ref"],
        false
      )
    ],
    steps: [
      step(0, "step-sv-resume", "Update resume with retail achievements", "planned", 60, 60, "medium"),
      step(1, "step-sv-draft", "Draft one-page application", "planned", 90, 90, "high", { deps: ["step-sv-resume"] }),
      step(2, "step-sv-ref", "Ask store manager to be referee", "waiting", 15, 15, "low", {
        ctx: [PH],
        required: false,
        split: false,
        max: 15
      })
    ],
    blockers: [
      {
        id: "blk-sv-1",
        description: "Waiting for the store manager to confirm she will act as referee",
        category: "waiting_on_someone",
        state: "awaiting_response",
        proposedResolution: "Follow up in person at the next shift",
        stepIds: ["step-sv-ref"]
      }
    ]
  }),
  deliverable({
    id: "del-srv-backup",
    projectId: "proj-server",
    title: "Off-site backup of family photos",
    details: "Restic to a Backblaze-style bucket nightly, with a tested restore of one album.",
    status: "ready",
    importance: 2,
    consequence: 2,
    sortOrder: 2,
    uncertainty: "high",
    completionThreshold: "Nightly job green for 3 nights and one album restored",
    criteria: [
      criterion(
        0,
        "crit-sb-1",
        "C1",
        "Nightly backup job runs unattended",
        "Three green runs in the log",
        "user_confirmation",
        "unsatisfied",
        ["step-sb-job"]
      ),
      criterion(
        1,
        "crit-sb-2",
        "C2",
        "Restore of one album verified",
        "Restored album opens correctly",
        "user_confirmation",
        "unsatisfied",
        ["step-sb-restore"]
      )
    ],
    steps: [
      step(0, "step-sb-bucket", "Create bucket and application key", "planned", 30, 30, "low"),
      step(1, "step-sb-job", "Write restic script and systemd timer", "planned", 90, 90, "high", {
        deps: ["step-sb-bucket"],
        ctx: ["ctx-home"],
        max: 90
      }),
      step(2, "step-sb-restore", "Test restore of one album", "planned", 45, 45, "medium", {
        deps: ["step-sb-job"],
        ctx: ["ctx-home"]
      })
    ]
  })
];

// ---------------------------------------------------------------------------------------------------------------------
// Routine presets

type PresetStepOptions = { energy?: string; ctx?: string[]; rule?: string; maxLeadMinutes?: number };

function presetStep(
  presetId: string,
  index: number,
  title: string,
  durationMinutes: number,
  phase: "before" | "after",
  options: PresetStepOptions = {}
): Fields {
  return {
    id: `${presetId}-s${index}`,
    title,
    durationMinutes,
    sequence: index,
    timingRule: options.rule ?? "contiguous",
    energy: options.energy ?? "low",
    contexts: options.ctx ?? ["ctx-home"],
    dependencyIds: [],
    phase,
    ...(options.maxLeadMinutes === undefined ? {} : { maxLeadMinutes: options.maxLeadMinutes })
  };
}

export const MORNING_PRESET = "Morning routine";
export const EVENING_PRESET = "Evening shutdown";
export const SHIFT_PRESET = "Get ready for a shift";
export const GYM_PRESET = "Gym prep";

export const PRESETS: Fields[] = [
  {
    id: "preset-morning",
    name: MORNING_PRESET,
    activityName: "Getting the day started",
    status: "active",
    replacesWakeRoutine: false,
    steps: [
      presetStep("preset-morning", 0, "Glass of water and meds", 5, "after"),
      presetStep("preset-morning", 1, "Shower and dress", 15, "after"),
      presetStep("preset-morning", 2, "Get the kids up and dressed", 15, "after"),
      presetStep("preset-morning", 3, "Breakfast and pack lunches", 25, "after"),
      presetStep("preset-morning", 4, "Five-minute tidy and check the calendar", 5, "after")
    ]
  },
  {
    id: "preset-evening",
    name: EVENING_PRESET,
    activityName: "Shutting down the day",
    status: "active",
    replacesWakeRoutine: false,
    steps: [
      presetStep("preset-evening", 0, "Tidy kitchen and run dishwasher", 15, "before"),
      presetStep("preset-evening", 1, "Pack school bags and tomorrow's lunches", 10, "before"),
      presetStep("preset-evening", 2, "Review tomorrow's plan", 5, "before", { ctx: [PH] }),
      presetStep("preset-evening", 3, "Brush teeth and screens off", 10, "before"),
      // A flexible step needs maxLeadMinutes; the portal's error does not name the step that lacks it.
      presetStep("preset-evening", 4, "Read in bed", 15, "before", { rule: "flexible", maxLeadMinutes: 60 })
    ]
  },
  {
    id: "preset-shift",
    name: SHIFT_PRESET,
    activityName: "Heading to work",
    status: "active",
    replacesWakeRoutine: true,
    steps: [
      presetStep("preset-shift", 0, "Uniform on, name badge, lunch in bag", 10, "before"),
      presetStep("preset-shift", 1, "Drive to the mall and park", 15, "before", { ctx: [CAR] })
    ]
  },
  {
    id: "preset-gym",
    name: GYM_PRESET,
    activityName: "Going to the gym",
    status: "active",
    replacesWakeRoutine: false,
    steps: [
      presetStep("preset-gym", 0, "Pack gym bag and fill bottle", 5, "before"),
      presetStep("preset-gym", 1, "Drive to Fit Hub", 10, "before", { ctx: [CAR] }),
      presetStep("preset-gym", 2, "Shower and change after class", 10, "after", { ctx: ["ctx-gym"] })
    ]
  }
];

// ---------------------------------------------------------------------------------------------------------------------
// Actions

type ActionRow = {
  id: string;
  project: string;
  title: string;
  /** "done" rows are created planned and completed after the history sessions (a session cannot start on a done action). */
  status: string;
  expected: number;
  energy: string;
  paths: string[][];
  deadline: string | null;
  importance: number;
  consequence: number;
  extra?: Fields;
};

const ACTION_ROWS: ActionRow[] = [
  {
    id: "a-super-ask",
    project: "proj-supervisor",
    title: "Ask Dana about supervisor trial shift dates",
    status: "planned",
    expected: 15,
    energy: "low",
    paths: [["ctx-work"]],
    deadline: "2026-10-28T15:30:00-04:00",
    importance: 4,
    consequence: 3,
    extra: { notes: "Catch her before the lunch rush on shift day." }
  },
  {
    id: "a-super-refresher",
    project: "proj-supervisor",
    title: "Complete cash-handling refresher module online",
    status: "active",
    expected: 45,
    energy: "medium",
    paths: [[LAP]],
    deadline: "2026-10-31T17:00:00-04:00",
    importance: 3,
    consequence: 3
  },
  {
    id: "a-work-swap",
    project: "proj-supervisor",
    title: "Reply to Jess about swapping the Saturday shift",
    status: "waiting",
    expected: 5,
    energy: "low",
    paths: [[PH]],
    deadline: null,
    importance: 2,
    consequence: 2,
    extra: { blockingReason: "waiting_on_someone", note: "Waiting for Jess to confirm she can take Sat." }
  },
  {
    id: "a-net-lab7",
    project: "proj-net",
    title: "Review lab 7: VLAN trunking notes",
    status: "done",
    expected: 45,
    energy: "medium",
    paths: [[LAP]],
    deadline: null,
    importance: 3,
    consequence: 3
  },
  {
    id: "a-net-pt",
    project: "proj-net",
    title: "Practice the Packet Tracer inter-VLAN routing lab",
    status: "planned",
    expected: 60,
    energy: "high",
    paths: [[LAP]],
    deadline: "2026-10-29T17:00:00-04:00",
    importance: 5,
    consequence: 4,
    extra: { notes: "Needed for the report diagram." }
  },
  {
    id: "a-net-ask",
    project: "proj-net",
    title: "Email Priya: can the diagram be hand-drawn?",
    status: "waiting",
    expected: 5,
    energy: "low",
    paths: [[LAP], [PH]],
    deadline: "2026-10-28T12:00:00-04:00",
    importance: 3,
    consequence: 3,
    extra: { blockingReason: "waiting_on_someone", note: "Emailed yesterday evening, no reply yet." }
  },
  {
    id: "a-net-lic",
    project: "proj-net",
    title: "Renew Packet Tracer student licence",
    status: "blocked",
    expected: 10,
    energy: "low",
    paths: [[LAP]],
    deadline: "2026-10-28T17:00:00-04:00",
    importance: 3,
    consequence: 3,
    extra: { blockingReason: "technical_problem", note: "Cisco Academy login loops on the password reset page." }
  },
  {
    id: "a-cy-slides",
    project: "proj-cyber",
    title: "Read module 5 slides on threat modelling",
    status: "active",
    expected: 30,
    energy: "medium",
    paths: [[LAP]],
    deadline: null,
    importance: 3,
    consequence: 3
  },
  {
    id: "a-cy-flash",
    project: "proj-cyber",
    title: "Make flashcards for the CIA triad and common attacks",
    status: "planned",
    expected: 30,
    energy: "low",
    paths: [[LAP], [PH]],
    deadline: "2026-11-03T17:00:00-05:00",
    importance: 2,
    consequence: 2
  },
  {
    id: "a-college-kit",
    project: "proj-net",
    title: "Return borrowed switch kit to the college lab",
    status: "planned",
    expected: 15,
    energy: "low",
    paths: [["ctx-college"]],
    deadline: "2026-10-29T12:30:00-04:00",
    importance: 3,
    consequence: 2,
    extra: { notes: "Class day. Ask for lab technician Raj.", availableFrom: "2026-10-29T08:00:00-04:00" }
  },
  {
    id: "a-kids-form",
    project: "proj-kids",
    title: "Sign Mia's field trip permission slip",
    status: "planned",
    expected: 5,
    energy: "low",
    paths: [["ctx-home"]],
    deadline: "2026-10-27T17:00:00-04:00",
    importance: 4,
    consequence: 3,
    extra: { notes: "The slip is in Mia's backpack." }
  },
  {
    id: "a-kids-cake",
    project: "proj-kids",
    title: "Order cake for Mia's 7th birthday",
    status: "planned",
    expected: 15,
    energy: "low",
    paths: [[PH]],
    deadline: "2026-10-31T17:00:00-04:00",
    importance: 4,
    consequence: 3
  },
  {
    id: "a-kids-gifts",
    project: "proj-kids",
    title: "Buy party bags and a gift for Mia",
    status: "planned",
    expected: 60,
    energy: "low",
    paths: [["ctx-shops"]],
    deadline: "2026-11-04T18:00:00-05:00",
    importance: 3,
    consequence: 3
  },
  {
    id: "a-kids-uniform",
    project: "proj-kids",
    title: "Order Noah's summer school uniform",
    status: "planned",
    expected: 15,
    energy: "low",
    paths: [[LAP]],
    deadline: "2026-10-24T17:00:00-04:00",
    importance: 3,
    consequence: 3,
    extra: { notes: "Overdue: the school store closes online orders at semester end." }
  },
  {
    id: "a-house-power",
    project: "proj-house",
    title: "Pay the electricity bill",
    status: "planned",
    expected: 5,
    energy: "low",
    paths: [[PH], [LAP]],
    deadline: "2026-10-25T17:00:00-04:00",
    importance: 4,
    consequence: 4
  },
  {
    id: "a-house-rego",
    project: "proj-house",
    title: "Renew car registration online",
    status: "planned",
    expected: 15,
    energy: "low",
    paths: [[PH], [LAP]],
    deadline: "2026-11-03T17:00:00-05:00",
    importance: 4,
    consequence: 4
  },
  {
    id: "a-house-gutters",
    project: "proj-house",
    title: "Clean the front gutters",
    status: "planned",
    expected: 90,
    energy: "medium",
    paths: [["ctx-home"]],
    deadline: null,
    importance: 2,
    consequence: 3,
    extra: { notes: "Needs dry weather and the long ladder." }
  },
  {
    id: "a-house-quote",
    project: "proj-house",
    title: "Wait for home insurance quote from broker",
    status: "waiting",
    expected: 5,
    energy: "low",
    paths: [[PH]],
    deadline: "2026-11-02T17:00:00-05:00",
    importance: 3,
    consequence: 3,
    extra: { blockingReason: "waiting_on_someone", note: "Broker said later this week." }
  },
  {
    id: "a-house-groc",
    project: "proj-house",
    title: "Do the weekly grocery shop",
    status: "planned",
    expected: 45,
    energy: "low",
    paths: [["ctx-shops"]],
    deadline: "2026-10-28T19:00:00-04:00",
    importance: 4,
    consequence: 3
  },
  {
    id: "a-house-lib",
    project: "proj-house",
    title: "Return library books",
    status: "planned",
    expected: 15,
    energy: "low",
    paths: [["ctx-shops"]],
    deadline: "2026-10-26T17:00:00-04:00",
    importance: 2,
    consequence: 2,
    extra: { notes: "Overdue by a day, fines start at 25 cents per item." }
  },
  {
    id: "a-fit-easy",
    project: "proj-fitrun",
    title: "Easy 5 km run",
    status: "done",
    expected: 35,
    energy: "medium",
    paths: [[PH]],
    deadline: null,
    importance: 3,
    consequence: 2
  },
  {
    id: "a-fit-long",
    project: "proj-fitrun",
    title: "Long run 8 km along the river",
    status: "planned",
    expected: 60,
    energy: "high",
    paths: [[PH]],
    deadline: "2026-11-01T10:00:00-05:00",
    importance: 3,
    consequence: 2
  },
  {
    id: "a-dental-book",
    project: "proj-dental",
    title: "Book the dentist follow-up for the filling",
    status: "planned",
    expected: 5,
    energy: "low",
    paths: [[PH]],
    deadline: "2026-10-30T17:00:00-04:00",
    importance: 3,
    consequence: 3
  },
  {
    id: "a-srv-ssd",
    project: "proj-server",
    title: "Order 2 TB NVMe SSD for the server",
    status: "done",
    expected: 10,
    energy: "low",
    paths: [[LAP]],
    deadline: null,
    importance: 2,
    consequence: 2
  },
  {
    id: "a-srv-image",
    project: "proj-server",
    title: "Image the old boot drive before the migration",
    status: "active",
    expected: 45,
    energy: "high",
    paths: [["ctx-home"]],
    deadline: "2026-11-07T21:00:00-05:00",
    importance: 3,
    consequence: 3,
    extra: { dependencyIds: ["a-srv-ssd"] }
  },
  {
    id: "a-srv-docs",
    project: "proj-server",
    title: "Read the Immich migration docs and note gotchas",
    status: "planned",
    expected: 30,
    energy: "medium",
    paths: [[LAP]],
    deadline: null,
    importance: 2,
    consequence: 2
  },
  {
    id: "a-srv-fan",
    project: "proj-server",
    title: "Replace the noisy case fan",
    status: "planned",
    expected: 30,
    energy: "medium",
    paths: [["ctx-home"]],
    deadline: null,
    importance: 1,
    consequence: 1
  }
];

function actionPayload(row: ActionRow): Fields {
  const { id, expected } = row;
  return {
    id,
    projectId: row.project,
    title: row.title,
    status: row.status === "done" ? "planned" : row.status,
    optimisticMinutes: Math.max(5, Math.floor(expected / 2)),
    expectedMinutes: expected,
    pessimisticMinutes: Math.floor(expected * 1.6),
    remainingMinutes: expected,
    energy: row.energy,
    minimumSessionMinutes: Math.min(expected, 15),
    maximumSessionMinutes: expected >= 15 ? Math.min(expected, 90) : expected,
    splittable: expected >= 45,
    setupMinutes: expected >= 30 ? 5 : 0,
    importance: row.importance,
    consequence: row.consequence,
    contexts: [...new Set(row.paths.flat())].sort(),
    requirementPathways: row.paths.map((contextIds, index) => ({ id: `${id}-p${index}`, contextIds })),
    dependencyIds: [],
    schedulingMode: "one_off",
    ...(row.deadline ? { deadlineAt: row.deadline } : {}),
    ...row.extra
  };
}

/** Dependencies come last: `a-srv-image` depends on `a-srv-ssd`, which must exist first. */
export const ACTIONS: Fields[] = [
  ...ACTION_ROWS.filter((row) => row.id !== "a-srv-image"),
  ...ACTION_ROWS.filter((row) => row.id === "a-srv-image")
].map(actionPayload);
