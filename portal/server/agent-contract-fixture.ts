import { AGENT_DRIVE_WRITE_SCOPES, MCP_TOOL_MANIFEST, allDirectWritesOn } from "@openrhen/contracts";
import { createSeedState, type PortalState } from "@/state/portal-state";
import { databaseJournalStore } from "./agent-journal-runner";
import type { NormalizedPostgresStateStore } from "./persistence/postgres/state-store";
import { handleMcpRequest, type McpDeps } from "./mcp-endpoint";
import { RESOURCE, agentRecord, fakeDeps } from "./mcp-test-support";

/**
 * What `agent-contract.integration.test.ts` needs besides its assertions: a clock whose every moment is a fixed
 * offset from one anchor, a small realistic state to seed, and a caller that makes an MCP `tools/call` as the
 * OpenClaw agent. Nothing here asserts anything.
 */

/**
 * Brisbane keeps +10:00 all year, so "Thursday 15:30" is the same offset from the anchor in every week the test
 * can run in; a zone with daylight saving would move an hour at a change-over.
 */
export const FIXTURE_ZONE = "Australia/Brisbane";
const OFFSET_MINUTES = 10 * 60;
const DAY_MS = 86_400_000;

export interface ContractClock {
  /** Wednesday 08:30 local: the moment the person's message reaches the agent. */
  readonly now: Date;
  /** The instant `days` after (or before) the anchor's date, at local `time` (`"15:30"`). */
  at(days: number, time: string): Date;
  /** The same instant written as an agent writes it: local time with its offset (`2026-10-29T15:30:00+10:00`). */
  local(days: number, time: string): string;
  /** The local calendar date `days` from the anchor (`2026-10-29`). */
  date(days: number): string;
}

/**
 * The latest Wednesday 08:30 local that is not in the future. The week is the one the real calendar is in, because
 * the portal reads some things (the sleep log's window) against the database's own clock and a date pinned in the
 * past would age out of them; the weekday and the time of day never move, so every offset below means the same
 * thing on every run: day 1 is Thursday, day 3 Saturday, day 4 Sunday, day 5 Monday, day 7 the next Wednesday.
 */
export function contractClock(real = new Date()): ContractClock {
  const local = new Date(real.getTime() + OFFSET_MINUTES * 60_000);
  const sinceWednesday = (local.getUTCDay() - 3 + 7) % 7;
  let anchorDay = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - sinceWednesday);
  if (anchorDay + (8 * 60 + 30) * 60_000 - OFFSET_MINUTES * 60_000 > real.getTime()) anchorDay -= 7 * DAY_MS;
  const at = (days: number, time: string): Date => {
    const [hours = 0, minutes = 0] = time.split(":").map(Number);
    return new Date(anchorDay + days * DAY_MS + (hours * 60 + minutes) * 60_000 - OFFSET_MINUTES * 60_000);
  };
  const date = (days: number) => new Date(anchorDay + days * DAY_MS).toISOString().slice(0, 10);
  return { now: at(0, "08:30"), at, date, local: (days, time) => `${date(days)}T${time.padStart(5, "0")}:00+10:00` };
}

/**
 * The scopes OpenClaw is given when the person approves the plugin: every scope a served tool needs, plus the broad
 * write scopes that make its writes apply. `tools/cli/test/openclaw-plugin.test.ts` pins the plugin manifest's
 * `oauth.scope` to exactly this list, so the agent here asks for what the real one does.
 */
export function openclawScopes(): string[] {
  return [...new Set([...MCP_TOOL_MANIFEST.flatMap((tool) => tool.scopes), ...AGENT_DRIVE_WRITE_SCOPES])].sort();
}

export interface ToolOutcome {
  isError: boolean;
  /** Everything the tool returned, as one text. */
  text: string;
  /** The text parsed as JSON, or undefined when it is not. */
  json: unknown;
}

/**
 * A caller that sends `tools/call` to the real `/mcp` handler with a bearer token for the OpenClaw agent: the
 * plugin's scopes, every direct write on, the database-backed undo journal, and the generated route table behind it.
 * The tool name and arguments are checked against the manifest's schema exactly as for a live client.
 */
export async function connectAgent(clock: ContractClock, name = "openclaw") {
  const scopes = openclawScopes();
  const agent = agentRecord({
    name,
    scopes,
    directWrites: allDirectWritesOn(),
    expiresAt: new Date(clock.now.getTime() + 365 * DAY_MS)
  });
  const fakes = fakeDeps([agent], clock.now);
  const { token } = await fakes.deps.mintAccessToken({ agent, resource: RESOURCE, scopes });
  const mcp: McpDeps = { oauth: fakes.deps, journalStore: databaseJournalStore, serverVersion: "contract-test" };
  let sequence = 0;
  return async function call(tool: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
    sequence += 1;
    const response = await handleMcpRequest(
      new Request(RESOURCE, {
        method: "POST",
        headers: {
          host: "portal.test",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: sequence,
          method: "tools/call",
          params: { name: tool, arguments: args }
        })
      }),
      mcp
    );
    const reply = (await response.json()) as {
      result?: { isError?: boolean; content?: { type: string; text?: string }[] };
      error?: { message: string };
    };
    if (reply.error || !reply.result)
      return { isError: true, text: `protocol error: ${reply.error?.message ?? "no result"}`, json: undefined };
    const text = (reply.result.content ?? []).map((part) => part.text ?? "").join("\n");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { isError: reply.result.isError === true, text, json };
  };
}

export type AgentCall = Awaited<ReturnType<typeof connectAgent>>;

type Action = PortalState["actions"][number];

const action = (fields: Partial<Action> & Pick<Action, "id" | "projectId" | "title">): Action => ({
  status: "planned",
  optimisticMinutes: 15,
  expectedMinutes: 30,
  pessimisticMinutes: 45,
  remainingMinutes: 30,
  splittable: true,
  setupMinutes: 0,
  energy: "medium",
  minimumSessionMinutes: 15,
  maximumSessionMinutes: 60,
  importance: 3,
  consequence: 3,
  contexts: [],
  dependencyIds: [],
  schedulingMode: "one_off",
  requirementPathways: [],
  preferences: [],
  ...fields
});

type ReportStep = PortalState["deliverables"][number]["steps"][number];

const reportStep = (id: string, title: string, sortOrder: number, fields: Partial<ReportStep>): ReportStep => ({
  id,
  title,
  status: "planned",
  optimisticMinutes: 30,
  expectedMinutes: 60,
  pessimisticMinutes: 90,
  remainingMinutes: 60,
  energy: "high",
  minimumSessionMinutes: 15,
  maximumSessionMinutes: 90,
  splittable: true,
  setupMinutes: 0,
  required: true,
  sortOrder,
  dependencyIds: [],
  requirementPathways: [],
  ...fields
});

/**
 * The person's plan as it stood on the Wednesday morning: a few areas with the records the message is about, one
 * deliverable and one dentist booking. The repeating commitments, the saved places and the night already logged go
 * in through the portal afterwards, because `put` does not carry them. Ids are readable slugs; the portal turns
 * them into UUIDs.
 */
export function contractSeedState(clock: ContractClock): PortalState {
  const base = createSeedState(clock.now);
  return {
    ...base,
    settings: { ...base.settings, timezone: FIXTURE_ZONE },
    areas: [
      { id: "area-study", name: "Study", status: "active", sortOrder: 0 },
      { id: "area-home", name: "Home and admin", status: "active", sortOrder: 1 },
      { id: "area-family", name: "Family", status: "active", sortOrder: 2 },
      { id: "area-work", name: "Work", status: "active", sortOrder: 3 }
    ],
    outcomes: [
      {
        id: "outcome-networking",
        areaId: "area-study",
        title: "Pass Networking",
        definitionOfDone: "Assessment 2 submitted and the labs done",
        value: 5,
        status: "active"
      },
      {
        id: "outcome-admin",
        areaId: "area-home",
        title: "Keep the household admin up to date",
        definitionOfDone: "Bills paid, forms returned, rego renewed",
        value: 3,
        status: "active"
      },
      {
        id: "outcome-family",
        areaId: "area-family",
        title: "Stay in touch with family",
        definitionOfDone: "Regular calls",
        value: 3,
        status: "active"
      },
      {
        id: "outcome-work",
        areaId: "area-work",
        title: "Grow at work",
        definitionOfDone: "A supervisor role",
        value: 3,
        status: "active"
      }
    ],
    projects: [
      {
        id: "project-assessment",
        title: "Networking assessment 2",
        area: "Study",
        outcomeId: "outcome-networking",
        status: "active",
        uncertainty: "some",
        value: 5,
        consequence: 4
      },
      {
        id: "project-labs",
        title: "Networking labs",
        area: "Study",
        outcomeId: "outcome-networking",
        status: "active",
        uncertainty: "some",
        value: 3,
        consequence: 3
      },
      {
        id: "project-security",
        title: "Security presentation",
        area: "Study",
        outcomeId: "outcome-networking",
        status: "active",
        uncertainty: "some",
        value: 3,
        consequence: 3
      },
      {
        id: "project-admin",
        title: "Household admin",
        area: "Home and admin",
        outcomeId: "outcome-admin",
        status: "active",
        uncertainty: "known",
        value: 3,
        consequence: 3
      },
      {
        id: "project-family",
        title: "Family",
        area: "Family",
        outcomeId: "outcome-family",
        status: "active",
        uncertainty: "known",
        value: 3,
        consequence: 2
      },
      {
        id: "project-work",
        title: "Work shifts",
        area: "Work",
        outcomeId: "outcome-work",
        status: "active",
        uncertainty: "known",
        value: 3,
        consequence: 3
      }
    ],
    actions: [
      action({
        id: "action-lab-7",
        projectId: "project-labs",
        title: "Lab 7: VLAN notes",
        status: "doing",
        expectedMinutes: 120,
        remainingMinutes: 120,
        optimisticMinutes: 90,
        pessimisticMinutes: 180
      }),
      action({
        id: "action-slides",
        projectId: "project-security",
        title: "Finish the threat modelling slides",
        status: "doing"
      }),
      action({
        id: "action-priya",
        projectId: "project-assessment",
        title: "Email Priya: can the diagram be hand-drawn?",
        status: "waiting",
        remainingMinutes: 10,
        expectedMinutes: 10,
        optimisticMinutes: 5,
        pessimisticMinutes: 15,
        minimumSessionMinutes: 5
      }),
      action({
        id: "action-mia-form",
        projectId: "project-admin",
        title: "Get Mia's excursion form signed",
        remainingMinutes: 10,
        expectedMinutes: 10,
        optimisticMinutes: 5,
        pessimisticMinutes: 15,
        minimumSessionMinutes: 5
      }),
      action({
        id: "action-electricity",
        projectId: "project-admin",
        title: "Pay the electricity bill",
        remainingMinutes: 10,
        expectedMinutes: 10,
        optimisticMinutes: 5,
        pessimisticMinutes: 15,
        minimumSessionMinutes: 5,
        deadlineAt: clock.at(1, "12:00").toISOString()
      }),
      action({
        id: "action-library",
        projectId: "project-admin",
        title: "Return the library books",
        remainingMinutes: 20,
        expectedMinutes: 20,
        optimisticMinutes: 15,
        pessimisticMinutes: 30
      }),
      action({
        id: "action-rego",
        projectId: "project-admin",
        title: "Renew the car rego",
        remainingMinutes: 15,
        expectedMinutes: 15,
        optimisticMinutes: 10,
        pessimisticMinutes: 25
      }),
      action({
        id: "action-ask-dana",
        projectId: "project-work",
        title: "Ask Dana about a supervisor trial shift",
        remainingMinutes: 10,
        expectedMinutes: 10,
        optimisticMinutes: 5,
        pessimisticMinutes: 15,
        minimumSessionMinutes: 5
      })
    ],
    commitments: [
      {
        id: "commitment-dentist",
        title: "Dentist check-up",
        startsAt: clock.at(6, "14:00").toISOString(),
        endsAt: clock.at(6, "14:45").toISOString(),
        status: "confirmed",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      }
    ],
    deliverables: [
      {
        id: "deliverable-report",
        projectId: "project-assessment",
        title: "Assessment 2: Network design report",
        status: "in_progress",
        uncertainty: "some",
        importance: 5,
        consequence: 4,
        internalDeadlineAt: clock.at(2, "17:00").toISOString(),
        externalDeadlineAt: clock.at(3, "23:59").toISOString(),
        contractVersion: 1,
        planVersion: 1,
        contractApprovedAt: clock.at(-7, "09:00").toISOString(),
        planApprovedAt: clock.at(-7, "09:00").toISOString(),
        sortOrder: 0,
        dependencyIds: [],
        sourceIds: [],
        sourceFiles: [],
        criteria: [],
        blockers: [],
        contractProposals: [],
        steps: [
          reportStep("step-brief", "Read the brief and pick the topology", 0, { status: "done", remainingMinutes: 0 }),
          reportStep("step-sections-one", "Write sections 1 and 2", 1, { remainingMinutes: 60 }),
          reportStep("step-sections-two", "Write sections 3 and 4", 2, { remainingMinutes: 60 }),
          reportStep("step-diagram", "Draw the network diagram", 3, { remainingMinutes: 30 }),
          reportStep("step-references", "Add references and check the formatting", 4, { remainingMinutes: 15 }),
          reportStep("step-submit", "Submit the report", 5, { remainingMinutes: 10 })
        ]
      }
    ]
  };
}

/** Home and College as saved places, and the person last seen at College: `put` does not carry either. */
export async function seedContractPlaces(store: Pick<NormalizedPostgresStateStore, "saveEntity" | "get">) {
  for (const [id, name, latitude, longitude] of [
    ["place-home", "Home", -27.4698, 153.0251],
    ["place-college", "College", -27.4811, 153.0352]
  ] as const)
    await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "condition_definition",
      entity: { id, name, kind: "location", latitude, longitude }
    });
  const state = await store.get();
  await store.saveEntity({
    commandId: crypto.randomUUID(),
    expectedVersion: state?.settings.version ?? null,
    type: "save_entity",
    entityType: "current_availability",
    entity: { currentEnergy: "medium", assertedConditions: [], currentSituation: { locationId: "place-college" } }
  });
}

/** The repeating commitments and the night already logged: written through the portal, which makes the occurrences. */
export async function seedContractRepeats(
  store: Pick<NormalizedPostgresStateStore, "saveCommitmentRecurrenceRule" | "saveEntity">,
  clock: ContractClock
): Promise<void> {
  const rule = (id: string, title: string, weekdays: number[], start: string, end: string, projectId?: string) =>
    store.saveCommitmentRecurrenceRule({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      rule: {
        id,
        title,
        timezone: FIXTURE_ZONE,
        startDate: clock.date(-7),
        repeat: { unit: "weeks", intervalWeeks: 1, weekdays },
        localStartTime: start,
        localEndTime: end,
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0,
        presence: "blocking",
        ...(projectId ? { projectId } : {})
      }
    });
  await rule("rule-spin", "Spin class", [3, 5], "18:00", "19:00");
  await rule("rule-uni", "Networking class", [4], "12:30", "15:30");
  await rule("rule-shift", "Work (shift)", [6], "07:00", "15:30", "project-work");
  // Last night as the person logged it before the agent was told better.
  await store.saveEntity({
    commandId: crypto.randomUUID(),
    expectedVersion: null,
    type: "save_entity",
    entityType: "sleep_log_entry",
    entity: { sleepAt: clock.at(-1, "22:40").toISOString(), wakeAt: clock.at(0, "06:20").toISOString() }
  });
}
