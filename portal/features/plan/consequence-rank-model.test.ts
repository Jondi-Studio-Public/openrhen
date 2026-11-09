import { describe, expect, it } from "vitest";
import type { ConsequenceGroupView } from "@openrhen/contracts";
import {
  addAnswer,
  answeredOn,
  answeredThisWeek,
  dropIndex,
  groupHeading,
  itemContext,
  moveItem,
  pausedForToday,
  progressLine,
  rankCommand,
  readAnswerLog,
  skipCommand,
  starsText,
  tieCommand,
  writeAnswerLog
} from "./consequence-rank-model";

const group: ConsequenceGroupView = {
  groupId: "g1",
  pool: "project",
  wording: "only_finish_one",
  question: "If you could only get one of these done, which would you do?",
  items: ["a", "b", "c", "d"].map((id, index) => ({ n: index + 1, id, title: id.toUpperCase(), stars: 3 })),
  reissued: false,
  answerCall: { tool: "rhen_save", arguments: {} },
  instructions: ""
};

describe("moveItem", () => {
  it("moves an item and clamps at the ends", () => {
    expect(moveItem([1, 2, 3, 4], 0, 2)).toEqual([2, 3, 1, 4]);
    expect(moveItem([1, 2, 3, 4], 3, 0)).toEqual([4, 1, 2, 3]);
    expect(moveItem([1, 2, 3, 4], 0, -5)).toEqual([1, 2, 3, 4]);
    expect(moveItem([1, 2, 3, 4], 1, 99)).toEqual([1, 3, 4, 2]);
    expect(moveItem([1, 2], 7, 0)).toEqual([1, 2]);
  });
});

describe("dropIndex", () => {
  it("counts the row centres the pointer has passed", () => {
    expect(dropIndex([10, 50, 90], 0)).toBe(0);
    expect(dropIndex([10, 50, 90], 60)).toBe(2);
    expect(dropIndex([10, 50, 90], 500)).toBe(3 - 1);
    expect(dropIndex([], 5)).toBe(0);
  });
});

describe("answer commands", () => {
  const order = [group.items[2]!, group.items[0]!, group.items[3]!, group.items[1]!];
  it("sends every id once, best first, under the wording asked", () => {
    expect(rankCommand(group, order, "c1")).toEqual({
      commandId: "c1",
      groupId: "g1",
      rankedIds: ["c", "a", "d", "b"],
      wording: "only_finish_one"
    });
  });
  it("sends a tie, and a skip as a tie that says so", () => {
    expect(tieCommand(group, "c2")).toEqual({ commandId: "c2", groupId: "g1", tie: true, wording: "only_finish_one" });
    expect(skipCommand(group, "c3")).toMatchObject({ tie: true, evidence: "skipped" });
  });
});

describe("itemContext", () => {
  const plan = {
    outcomes: [{ id: "o1", title: "Home" }],
    projects: [{ id: "p1", title: "Shed", outcomeId: "o1" }],
    actions: [{ id: "x1", projectId: "p1" }]
  };
  it("names the outcome of a project and the project of an action", () => {
    expect(itemContext(group, { id: "p1" }, plan).parent).toBe("Home");
    expect(itemContext({ ...group, pool: "action" }, { id: "x1" }, plan).parent).toBe("Shed");
    expect(itemContext(group, { id: "gone" }, plan).parent).toBeNull();
  });
});

describe("labels", () => {
  it("draws stars and the heading", () => {
    expect(starsText(2)).toBe("★★☆☆☆");
    expect(starsText(9)).toBe("★★★★★");
    expect(groupHeading(group)).toBe("Rank these four");
  });
});

describe("answer log", () => {
  it("counts today and the week, drops old days, and reads storage safely", () => {
    let log = addAnswer([], "2026-11-01");
    log = addAnswer(log, "2026-11-08");
    log = addAnswer(log, "2026-11-09");
    log = addAnswer(log, "2026-11-09");
    expect(answeredOn(log, "2026-11-09")).toBe(2);
    expect(answeredThisWeek(log, "2026-11-09")).toBe(3);
    expect(addAnswer(log, "2026-12-30")).toEqual(["2026-12-30"]);
    const store = new Map<string, string>();
    writeAnswerLog({ setItem: (k, v) => void store.set(k, v) }, log);
    expect(readAnswerLog({ getItem: (k) => store.get(k) ?? null })).toEqual(log);
    expect(readAnswerLog({ getItem: () => "not json" })).toEqual([]);
    expect(readAnswerLog({ getItem: () => '{"a":1}' })).toEqual([]);
    expect(readAnswerLog(null)).toEqual([]);
  });
  it("says every answer is optional, and pauses after three unless more was asked for", () => {
    expect(progressLine(0, 0)).toContain("Every answer is optional");
    expect(progressLine(1, 4)).toContain("1 group today, 4 groups this week");
    expect(pausedForToday(3, false)).toBe(true);
    expect(pausedForToday(3, true)).toBe(false);
    expect(pausedForToday(2, false)).toBe(false);
  });
});
