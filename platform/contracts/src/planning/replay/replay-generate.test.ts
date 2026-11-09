import { describe, expect, it } from "vitest";
import { parseReplayCase } from "./replay-case.js";
import {
  createRng,
  DEFAULT_SEED,
  FIRST_NAMES,
  GENERATOR_WORDS,
  generateCases,
  generatePlan,
  KINDS,
  NOUNS,
  PLAN_SIZES,
  SHAPE_COUNTS,
  SIZE_NAMES,
  VERBS
} from "./replay-generate.js";
import { fixtureProblems } from "./replay-guard.js";
import { lexicon } from "./replay-suite.js";

const recordsOf = (plan: ReturnType<typeof generatePlan>["plan"]) =>
  plan.commitments.length + plan.actions.length + plan.projects.length + plan.contacts.length + plan.openFacts.length;

describe("replay generator", () => {
  it("draws the same numbers for the same seed, and different ones for another", () => {
    const [a, b, c] = [createRng("x"), createRng("x"), createRng("y")];
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect([c(), c(), c()]).not.toEqual(first);
    expect(first.every((n) => n >= 0 && n < 1)).toBe(true);
    // Pinned, so a change to the generator's stream shows up as a diff rather than as quiet new cases.
    expect(first[0]).toBeCloseTo(0.4801, 3);
  });

  it("builds a 1x plan of about 411 records, and 5x and 20x plans that are multiples of it", () => {
    const sizes = SIZE_NAMES.map((size) => recordsOf(generatePlan(DEFAULT_SEED, size).plan));
    expect(sizes[0]).toBeGreaterThanOrEqual(400);
    expect(sizes[0]).toBeLessThanOrEqual(420);
    const per = sizes[0]! - SHAPE_COUNTS.contacts;
    expect(sizes[1]! - SHAPE_COUNTS.contacts).toBe(per * 5);
    expect(sizes[2]! - SHAPE_COUNTS.contacts).toBe(per * 20);
    expect(SIZE_NAMES.map((s) => PLAN_SIZES[s])).toEqual([1, 5, 20]);
  });

  it("gives every record a unique id, and every title but a deliberate twin a unique name", () => {
    const { plan } = generatePlan(DEFAULT_SEED, "5x");
    const ids = [...plan.commitments, ...plan.actions, ...plan.projects, ...plan.contacts, ...plan.openFacts].map(
      (r) => r.id
    );
    expect(new Set(ids).size).toBe(ids.length);
    const titles = new Map<string, number>();
    for (const c of plan.commitments) titles.set(c.title, (titles.get(c.title) ?? 0) + 1);
    const repeated = [...titles.values()].filter((n) => n > 1);
    expect(repeated.every((n) => n === 2)).toBe(true);
    // Twins (same time), recurring neighbours (a week apart) and contact twins: the only repeats.
    expect(repeated.length).toBe(
      (SHAPE_COUNTS.twinPairs + SHAPE_COUNTS.neighbourPairs + SHAPE_COUNTS.contactTwins) * PLAN_SIZES["5x"]
    );
  });

  it("keeps the plan stable when more cases are asked for", () => {
    const short = generateCases({ size: "1x", count: 50 });
    const long = generateCases({ size: "1x", count: 120 });
    expect(long.slice(0, 50)).toEqual(short);
    expect(long[0]!.input.plan).toBe(long[119]!.input.plan);
  });

  it("changes with the seed, and only with the seed", () => {
    const a = generateCases({ size: "1x", count: 40 });
    expect(generateCases({ size: "1x", count: 40 })).toEqual(a);
    expect(generateCases({ seed: "another", size: "1x", count: 40 })).not.toEqual(a);
  });

  it("freezes the shared plan so no reconciler can change it", () => {
    const [first] = generateCases({ size: "1x", count: 1 });
    expect(Object.isFrozen(first!.input.plan)).toBe(true);
    expect(() => first!.input.plan.commitments.push(first!.input.plan.commitments[0]!)).toThrow();
  });

  it("covers every mutation kind in a 1x run, with ids and size tags", () => {
    const cases = generateCases({ size: "1x", count: KINDS.length * 3 });
    for (const kind of KINDS) expect(cases.filter((c) => c.tags[1] === kind).length).toBe(3);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect(cases.every((c) => c.tags.includes("1x") && c.tags[0] === "generated")).toBe(true);
  });

  it("makes cases the case schema accepts, with a gold target that is on the plan", () => {
    for (const size of SIZE_NAMES) {
      const cases = generateCases({ size, count: size === "1x" ? KINDS.length * 2 : KINDS.length });
      for (const testCase of cases) {
        expect(() => parseReplayCase(testCase), testCase.id).not.toThrow();
        const { plan } = testCase.input;
        const known = new Set(
          [...plan.commitments, ...plan.actions, ...plan.projects, ...plan.openFacts].map((r) => r.id)
        );
        for (const target of [testCase.gold.target, ...(testCase.gold.acceptableTargets ?? [])]) {
          if (target) expect(known.has(target.id), `${testCase.id} -> ${target.id}`).toBe(true);
        }
      }
    }
  });

  it("sends a contact-twin message from the owner of the twin it means", () => {
    const cases = generateCases({ size: "1x", count: KINDS.length * 3 }).filter((c) => c.tags[1] === "twin-contact");
    expect(cases.length).toBe(3);
    for (const testCase of cases) {
      const { plan, message } = testCase.input;
      const target = plan.commitments.find((c) => c.id === testCase.gold.target!.id)!;
      expect(plan.contacts.find((k) => k.id === target.contactId)!.email).toBe(message.from);
    }
  });

  it("uses only words, names and addresses the privacy guard accepts", () => {
    expect(GENERATOR_WORDS.filter((word) => !lexicon.words.includes(word))).toEqual([]);
    expect(new Set([...NOUNS, ...VERBS, ...FIRST_NAMES]).size).toBe(NOUNS.length + VERBS.length + FIRST_NAMES.length);
    for (const size of SIZE_NAMES) {
      const cases = generateCases({ size, count: size === "1x" ? 400 : 60 });
      expect(fixtureProblems(cases[0]!.input.plan, lexicon, `${size} plan`)).toEqual([]);
      expect(
        fixtureProblems(
          cases.map((c) => c.input.message),
          lexicon,
          `${size} messages`
        )
      ).toEqual([]);
      expect(
        fixtureProblems(
          cases.map((c) => c.gold),
          lexicon,
          `${size} gold`
        )
      ).toEqual([]);
    }
  });
});
