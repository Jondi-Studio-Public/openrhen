import { describe, expect, it } from "vitest";
import { MAX_EFFORT_NEEDS, buildNowAnswer, runningAnchors } from "./now-answer.js";
import type { NowAnswerInput } from "./now-answer.js";
import { mcpManifestTool, validateToolArguments } from "../mcp-manifest.js";

/**
 * Replay of the 2026-10-06 night. The engine had replanned the wake to 10:19 after a missed 01:20
 * start (540 minutes protected), Now showed the pre-sleep step due, and MCP `status` said only
 * "Time to sleep · 540 min" so an agent measured it against a 06:45 alarm. Both surfaces now read this
 * one payload, so the wake, the engine's reason and the step due first travel together.
 *
 * Also the 10-07 "I'm free" family: two overlapping running anchors must both be visible.
 */

const now = new Date("2026-10-06T00:50:00+10:00");

const night = {
  id: "sleep-tonight",
  status: "planned",
  allowedMinutes: 540,
  hardErrors: [],
  plannedStartAt: "2026-10-06T01:20:00+10:00",
  plannedWakeAt: "2026-10-06T10:19:00+10:00",
  explanation: "The planned start was missed, so the wake time moved later to protect 540 minutes of sleep.",
  replannedFromMissedStart: true
};

const teeth = {
  id: "step-teeth",
  anchorType: "sleep_plan",
  anchorId: "sleep-tonight",
  purpose: "bedtime",
  title: "Brush and floss teeth",
  durationMinutes: 8,
  sequence: 0,
  dependencyIds: [],
  contexts: [],
  status: "pending",
  scheduledStartAt: "2026-10-06T00:40:00+10:00",
  scheduledEndAt: "2026-10-06T01:20:00+10:00"
};

function input(overrides: Record<string, unknown> = {}): NowAnswerInput {
  return {
    state: {
      activeSession: null,
      commitments: [],
      routineSteps: [teeth],
      sleepPlans: [night],
      conditionDefinitions: [],
      currentSituation: { locationId: null },
      projects: [],
      settings: { preferredWakeTime: "06:45" },
      ...overrides
    } as unknown as NowAnswerInput["state"],
    currentDirective: {
      kind: "sleep",
      targetId: "sleep-tonight",
      title: "Time to sleep",
      recommendedMinutes: 540
    } as NowAnswerInput["currentDirective"],
    now
  };
}

describe("buildNowAnswer", () => {
  it("states the wake, the reason and the step due before sleep with the sleep directive", () => {
    const answer = buildNowAnswer(input(), new Map());
    expect(answer.directive?.sleep).toMatchObject({
      wakesAt: night.plannedWakeAt,
      preferredWakeTime: "06:45",
      replannedFromMissedStart: true,
      currentStep: { id: "step-teeth", title: "Brush and floss teeth" }
    });
    expect(answer.directive?.sleep?.wakeConstraint).toBeUndefined();
  });

  it("carries a break's earliest start and reason for resting work and for the journey to it", () => {
    const notBefore = "2026-10-06T01:05:00+10:00";
    const breakBlock = {
      startsAt: now.toISOString(),
      endsAt: notBefore,
      kind: "gap",
      targetId: null,
      title: "Take a break",
      focusedMinutes: 0,
      wallClockMinutes: 15,
      reason: "Take a break until 1:05 am, then Essay.",
      confidence: "high",
      gapKind: "none"
    };
    const work = { kind: "action", targetId: "essay", title: "Essay", recommendedMinutes: 60, notBefore };
    const journey = {
      kind: "travel",
      toLocationId: "campus",
      title: "Drive to campus",
      recommendedMinutes: 20,
      source: "fallback",
      notBefore,
      // oxlint-disable-next-line unicorn/no-thenable -- `then` is a domain field of the travel directive, not a promise continuation
      then: { kind: "action", targetId: "essay", title: "Essay", recommendedMinutes: 60 }
    };
    for (const currentDirective of [work, journey]) {
      const answer = buildNowAnswer(
        {
          ...input(),
          currentDirective: currentDirective as NowAnswerInput["currentDirective"],
          dayPlan: { blocks: [breakBlock] } as unknown as NowAnswerInput["dayPlan"]
        },
        new Map()
      );
      expect(answer.directive).toMatchObject({ notBefore, reason: breakBlock.reason });
    }
  });

  it("names no step when the due step belongs to a different night than the directive's", () => {
    const other = { ...teeth, anchorId: "sleep-last-night" };
    const answer = buildNowAnswer(input({ routineSteps: [other] }), new Map());
    expect(answer.directive?.sleep?.currentStep).toBeUndefined();
  });
});

describe("runningAnchors", () => {
  const anchor = (id: string, endsAt: string) => ({
    id,
    status: "confirmed",
    presence: "anchor",
    startsAt: "2026-10-07T09:00:00+10:00",
    endsAt,
    locationId: "campus"
  });
  const at = new Date("2026-10-07T14:00:00+10:00");

  it("reports every running anchor, so overlapping classes cannot hide each other", () => {
    const state = {
      activeSession: null,
      commitments: [anchor("class", "2026-10-07T16:00:00+10:00"), anchor("class-copy", "2026-10-07T16:30:00+10:00")],
      routineSteps: [],
      sleepPlans: [],
      conditionDefinitions: [],
      currentSituation: { locationId: "campus" }
    } as unknown as NowAnswerInput["state"];
    expect(runningAnchors(state, at).open).toEqual(["class", "class-copy"]);
  });

  it("splits engaged from open, and leaves an anchor you have not arrived at out", () => {
    const state = {
      activeSession: { status: "running", targetType: "fixed_commitment", targetId: "class" },
      commitments: [anchor("class", "2026-10-07T16:00:00+10:00"), anchor("class-copy", "2026-10-07T16:30:00+10:00")],
      routineSteps: [],
      sleepPlans: [],
      conditionDefinitions: [],
      currentSituation: { locationId: "home" }
    } as unknown as NowAnswerInput["state"];
    expect(runningAnchors(state, at)).toEqual({ open: [], engaged: ["class"] });
  });
});

describe("buildNowAnswer needs", () => {
  const HOUR = 60 * 60_000;
  const today = new Date("2026-10-27T21:20:00.000Z");
  const ago = (ms: number) => new Date(today.getTime() - ms).toISOString();
  const homeDefinition = { id: "home", name: "Home", kind: "location", status: "active" };

  function needsInput(overrides: Record<string, unknown> = {}, settings: Record<string, unknown> = {}): NowAnswerInput {
    return {
      state: {
        activeSession: null,
        commitments: [],
        routineSteps: [],
        sleepPlans: [],
        conditionDefinitions: [homeDefinition],
        currentSituation: { locationId: "home", locationSetAt: ago(HOUR), energySetAt: ago(HOUR) },
        projects: [],
        actions: [{ id: "action-1", title: "Lab 7: VLAN trunking notes" }],
        currentEnergy: "recovery",
        settings: { preferredWakeTime: "06:45", maxAwakeHours: 20, lastWokeAt: ago(2 * HOUR), ...settings },
        ...overrides
      } as unknown as NowAnswerInput["state"],
      currentDirective: { kind: "none", title: "Nothing fits", recommendedMinutes: 0 },
      now: today
    };
  }

  const openSession = (overrides: Record<string, unknown> = {}) => ({
    id: "session-1",
    actionId: "action-1",
    targetType: "action",
    targetId: "action-1",
    status: "running",
    startedAt: ago(19 * HOUR),
    plannedEndAt: ago(18 * HOUR + 15 * 60_000),
    plannedMinutes: 45,
    ...overrides
  });

  it("has no needs while every fact is recent", () => {
    expect(buildNowAnswer(needsInput(), new Map()).needs).toEqual([]);
  });

  it("asks when a session left open stopped, and says how to settle it", () => {
    const [need, ...rest] = buildNowAnswer(needsInput({ activeSession: openSession() }), new Map()).needs;
    expect(rest).toEqual([]);
    expect(need).toEqual({
      fact: "session_end",
      subjectId: "session-1",
      title: "Lab 7: VLAN trunking notes",
      question: "Running 19 h, planned 45 min. When did it stop?",
      asOf: ago(18 * HOUR + 15 * 60_000),
      blocksDirective: true,
      answer: {
        tool: "rhen_session",
        action: "finish",
        fields: ["endedAt"],
        cli: "rhen session finish --ended-at <time>",
        call: {
          tool: "rhen_session",
          arguments: { subcommand: "finish", "ended-at": "<ISO time with owner's offset>" }
        },
        instructions: expect.stringContaining('"subcommand":"finish","ended-at"')
      }
    });
  });

  it("finishes a paused session as it stands, since its end is the pause and a given end is refused", () => {
    for (const [targetType, command] of [
      ["action", "session"],
      ["routine_step", "activity"]
    ] as const) {
      const session = openSession({
        targetType,
        status: "paused",
        pausedAt: ago(5 * HOUR),
        plannedEndAt: ago(6 * HOUR)
      });
      const [need] = buildNowAnswer(needsInput({ activeSession: session }), new Map()).needs;
      expect(need, targetType).toMatchObject({
        fact: "session_end",
        question: "Paused 5 h ago. Finish it?",
        blocksDirective: true,
        answer: { tool: `rhen_${command}`, action: "finish", fields: [], cli: `rhen ${command} finish` }
      });
    }
  });

  it("finishes a session paused and then left awaiting feedback as it stands too", () => {
    const parked = openSession({
      status: "feedback",
      pausedRemainingSeconds: 600,
      pausedAt: ago(5 * HOUR),
      plannedEndAt: ago(6 * HOUR)
    });
    const [need] = buildNowAnswer(needsInput({ activeSession: parked }), new Map()).needs;
    expect(need).toMatchObject({
      question: "Paused 5 h ago. Finish it?",
      answer: { fields: [], cli: "rhen session finish" }
    });
  });

  it("settles a stale routine or deliverable session through the activity command", () => {
    const session = openSession({ targetType: "routine_step", targetTitle: "Pack bag", plannedEndAt: ago(6 * HOUR) });
    const [need] = buildNowAnswer(needsInput({ activeSession: session }), new Map()).needs;
    expect(need?.answer).toMatchObject({ tool: "rhen_activity", action: "finish" });
    expect(need?.title).toBe("Pack bag");
  });

  it("asks about a wake that has aged out, without blocking the directive", () => {
    const [need, ...rest] = buildNowAnswer(needsInput({}, { lastWokeAt: ago(21 * 24 * HOUR) }), new Map()).needs;
    expect(rest).toEqual([]);
    expect(need).toMatchObject({
      fact: "wake",
      question: "Last woke 21 days ago. When did you wake up?",
      blocksDirective: false,
      answer: { tool: "rhen_wake", action: "wake", fields: ["at"], cli: "rhen wake --at <time>" }
    });
  });

  it("asks about energy that has aged out, and about energy nobody ever dated", () => {
    const aged = { locationId: "home", locationSetAt: ago(HOUR), energySetAt: ago(3 * 24 * HOUR) };
    const [need] = buildNowAnswer(needsInput({ currentSituation: aged }), new Map()).needs;
    expect(need).toMatchObject({
      fact: "energy",
      question: "You said recovery energy 3 days ago. How is it now?",
      asOf: aged.energySetAt,
      blocksDirective: false
    });
    // Nothing says when it was true, so there is no `asOf` to show, but the stored value is ignored all the same.
    const undated = { locationId: "home", locationSetAt: ago(HOUR) };
    const [unknown, ...rest] = buildNowAnswer(needsInput({ currentSituation: undated }), new Map()).needs;
    expect(rest).toEqual([]);
    expect(unknown).toMatchObject({ fact: "energy", question: "How is your energy now?", blocksDirective: false });
    expect(unknown).not.toHaveProperty("asOf");
  });

  it("turns a stale place into the same question the answer directive asks, and blocks on it", () => {
    const stale = { locationId: "home", locationSetAt: ago(3 * 24 * HOUR), energySetAt: ago(HOUR) };
    const directive = {
      kind: "answer",
      title: "Home is unanswered for Lab 7",
      recommendedMinutes: 0,
      question: "Are you at Home?",
      contextIds: ["home"],
      candidate: null
    } as NowAnswerInput["currentDirective"];
    const asked = buildNowAnswer(
      { ...needsInput({ currentSituation: stale }), currentDirective: directive },
      new Map([["home", "Home"]])
    );
    expect(asked.needs).toEqual([
      {
        fact: "location",
        subjectId: "home",
        title: "Home",
        question: "Are you at Home?",
        asOf: stale.locationSetAt,
        blocksDirective: true,
        answer: {
          tool: "rhen_arrive",
          action: "arrive",
          fields: ["place"],
          cli: 'rhen arrive "Home"',
          call: { tool: "rhen_arrive", arguments: { place: "Home" } }
        }
      }
    ]);
    // With nothing waiting on it, the place is still worth confirming, but the directive stands.
    const quiet = buildNowAnswer(needsInput({ currentSituation: stale }), new Map([["home", "Home"]]));
    expect(quiet.needs[0]).toMatchObject({ fact: "location", question: "Still at Home?", blocksDirective: false });
  });

  it("keeps its own question when the directive asks about a different place", () => {
    const stale = { locationId: "work", locationSetAt: ago(3 * 24 * HOUR), energySetAt: ago(HOUR) };
    const directive = {
      kind: "answer",
      title: "Home is unanswered for Lab 7",
      recommendedMinutes: 0,
      question: "Are you at Home?",
      contextIds: ["home"],
      candidate: null
    } as NowAnswerInput["currentDirective"];
    const answer = buildNowAnswer(
      { ...needsInput({ currentSituation: stale }), currentDirective: directive },
      new Map([
        ["home", "Home"],
        ["work", "Work"]
      ])
    );
    // The directive asks about Home itself; the need is about Work and must not answer the Home question.
    expect(answer.needs).toEqual([
      expect.objectContaining({
        fact: "location",
        subjectId: "work",
        question: "Still at Work?",
        blocksDirective: false,
        answer: expect.objectContaining({ cli: 'rhen arrive "Work"' })
      })
    ]);
  });

  it("lists the needs that block the directive first", () => {
    const stale = { locationId: "home", locationSetAt: ago(3 * 24 * HOUR), energySetAt: ago(3 * 24 * HOUR) };
    const answer = buildNowAnswer(
      needsInput({ activeSession: openSession(), currentSituation: stale }, { lastWokeAt: ago(30 * HOUR) }),
      new Map([["home", "Home"]])
    );
    expect(answer.needs.map((item) => item.fact)).toEqual(["session_end", "location", "wake", "energy"]);
    expect(answer.needs.map((item) => item.blocksDirective)).toEqual([true, false, false, false]);
  });

  describe("effort", () => {
    const DAY = 24 * HOUR;
    const effortAction = (id: string, overrides: Record<string, unknown> = {}) => ({
      id,
      projectId: "project-1",
      title: `Action ${id}`,
      status: "active",
      remainingMinutes: 180,
      remainingSetAt: ago(21 * DAY),
      schedulingMode: "one_off",
      ...overrides
    });
    // The plan's forecast lists each project's aged inputs; by default every action given, as the engine would for
    // old estimates it prices.
    const schedule = (health: Record<string, string>, actions: Record<string, unknown>[]) => ({
      forecasts: Object.entries(health).map(([projectId, value]) => ({
        projectId,
        health: value,
        agedInputs: actions
          .filter((action) => action.projectId === projectId)
          .map((action) => ({ actionId: action.id, title: action.title, setAt: action.remainingSetAt }))
      }))
    });
    const withEffort = (actions: Record<string, unknown>[], health: Record<string, string> | null) => ({
      ...needsInput({ actions }),
      ...(health ? { schedule: schedule(health, actions) } : {})
    });

    it("asks whether an old estimate on an at-risk project still holds, and says how to settle it", () => {
      const answer = buildNowAnswer(
        withEffort([effortAction("draft", { title: "Draft chapter 3" })], { "project-1": "at_risk" }),
        new Map()
      );
      expect(answer.needs).toEqual([
        {
          fact: "effort",
          subjectId: "draft",
          title: "Draft chapter 3",
          question: "Still about 3 h left on Draft chapter 3? Last set 21 days ago.",
          asOf: ago(21 * DAY),
          blocksDirective: false,
          answer: {
            tool: "rhen_save",
            action: "action",
            fields: ["remainingMinutes"],
            cli: "rhen save action --id draft --set remainingMinutes=<minutes>",
            call: {
              tool: "rhen_save",
              arguments: {
                entityType: "action",
                id: "draft",
                fields: { remainingMinutes: "<minutes>" }
              }
            }
          }
        }
      ]);
    });

    it("says nothing about an estimate under 14 days old, a project that is not at risk, or no plan at all", () => {
      const recent = [effortAction("draft", { remainingSetAt: ago(13 * DAY) })];
      expect(buildNowAnswer(withEffort(recent, { "project-1": "behind" }), new Map()).needs).toEqual([]);
      const old = [effortAction("draft")];
      for (const health of ["on_track", "ahead", "unknown"])
        expect(buildNowAnswer(withEffort(old, { "project-1": health }), new Map()).needs, health).toEqual([]);
      expect(buildNowAnswer(withEffort(old, null), new Map()).needs).toEqual([]);
      // Actions that carry only an id and a title (a caller that names the open session) are not effort.
      expect(buildNowAnswer(needsInput(), new Map()).needs).toEqual([]);
    });

    it("asks only about the estimates the plan's forecast aged", () => {
      const actions = [effortAction("priced"), effortAction("held-back")];
      const plan = schedule({ "project-1": "at_risk" }, actions.slice(0, 1));
      const answer = buildNowAnswer({ ...needsInput({ actions }), schedule: plan }, new Map());
      expect(answer.needs.map((item) => item.subjectId)).toEqual(["priced"]);
      // A plan from before effort age lists no aged inputs, so it asks about none.
      const older = { forecasts: [{ projectId: "project-1", health: "at_risk" }] };
      expect(buildNowAnswer({ ...needsInput({ actions }), schedule: older }, new Map()).needs).toEqual([]);
    });

    it("asks about the three most at risk: behind first, then the oldest estimate", () => {
      expect(MAX_EFFORT_NEEDS).toBe(3);
      const actions = [
        effortAction("a", { remainingSetAt: ago(15 * DAY) }),
        effortAction("b", { remainingSetAt: ago(40 * DAY) }),
        effortAction("c", { remainingSetAt: ago(20 * DAY) }),
        effortAction("d", { projectId: "project-2", remainingSetAt: ago(16 * DAY) }),
        effortAction("e", { remainingSetAt: ago(30 * DAY) })
      ];
      const answer = buildNowAnswer(withEffort(actions, { "project-1": "at_risk", "project-2": "behind" }), new Map());
      expect(answer.needs.map((item) => item.subjectId)).toEqual(["d", "b", "e"]);
    });

    it("comes after the facts a person tells, and never blocks the directive", () => {
      const answer = buildNowAnswer(
        {
          ...withEffort([effortAction("draft")], { "project-1": "at_risk" }),
          state: {
            ...withEffort([effortAction("draft")], null).state,
            currentSituation: { locationId: "home", locationSetAt: ago(HOUR), energySetAt: ago(3 * DAY) }
          } as NowAnswerInput["state"]
        },
        new Map()
      );
      expect(answer.needs.map((item) => item.fact)).toEqual(["energy", "effort"]);
      expect(answer.needs.every((item) => !item.blocksDirective)).toBe(true);
    });

    it("gives every need an exact tool call whose arguments the real tool accepts (F3-01)", () => {
      const stale = { locationId: "home", locationSetAt: ago(3 * DAY), energySetAt: ago(3 * DAY) };
      const base = withEffort([effortAction("draft")], { "project-1": "at_risk" });
      const answer = buildNowAnswer(
        {
          ...base,
          state: {
            ...base.state,
            currentSituation: stale,
            activeSession: openSession(),
            settings: { preferredWakeTime: "06:45", maxAwakeHours: 20, lastWokeAt: ago(30 * HOUR) }
          } as unknown as NowAnswerInput["state"]
        },
        new Map([["home", "Home"]])
      );
      expect(answer.needs.map((item) => item.fact).sort()).toEqual([
        "effort",
        "energy",
        "location",
        "session_end",
        "wake"
      ]);
      // What an agent does with a placeholder: swaps in a real value. The shape is what the tool checks.
      const iso = "2026-10-05T12:00:00+10:00";
      const filled = (value: unknown): unknown =>
        typeof value === "string" && value.startsWith("<")
          ? /high\|medium/.test(value)
            ? "low"
            : /minutes/.test(value)
              ? 30
              : /owner's words/.test(value)
                ? "I am tired"
                : iso
          : value && typeof value === "object"
            ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, filled(inner)]))
            : value;
      for (const need of answer.needs) {
        const call = (need.answer as { call?: { tool: string; arguments: Record<string, unknown> } }).call;
        expect(call, `${need.fact} has answer.call`).toBeDefined();
        expect(call!.tool, need.fact).toBe(need.answer.tool);
        const tool = mcpManifestTool(call!.tool);
        expect(tool, `${call!.tool} is a served tool`).toBeDefined();
        const checked = validateToolArguments(tool!.inputSchema, filled(call!.arguments), call!.tool);
        expect(checked, `${need.fact}: ${JSON.stringify(call!.arguments)}`).toMatchObject({ ok: true });
        // `action` on session/activity is the ACTION to work on, never the verb: the verb is `subcommand`.
        if (need.fact === "session_end") {
          expect(call!.arguments).toMatchObject({ subcommand: "finish" });
          expect(call!.arguments).not.toHaveProperty("action");
          expect(call!.arguments).not.toHaveProperty("endedAt");
          expect(call!.arguments).toHaveProperty("ended-at");
        }
        // Energy is never inferred: the call must say it is stated, with the owner's words.
        if (need.fact === "energy")
          expect(call!.arguments).toMatchObject({
            entityType: "current_availability",
            basis: "stated",
            evidence: expect.any(String)
          });
        // The two answers an agent gets wrong without being told say why, in words.
        if (need.fact === "session_end" || need.fact === "energy")
          expect(need.answer.instructions, need.fact).toMatch(/subcommand|infer/);
      }
    });

    it("quotes an action id that is not a plain word in the command line", () => {
      const answer = buildNowAnswer(withEffort([effortAction("draft ch 3")], { "project-1": "at_risk" }), new Map());
      expect(answer.needs[0]?.answer.cli).toBe('rhen save action --id "draft ch 3" --set remainingMinutes=<minutes>');
    });
  });
});
