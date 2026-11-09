import { describe, expect, it } from "vitest";
import type { ReplayGold } from "./replay-case.js";
import { adversarial, never, noisy, oracle } from "./replay-stubs.js";

const cards = [
  { label: "c1", id: "x1", title: "One" },
  { label: "c2", id: "x2", title: "Two" }
];
const gold = (overrides: Partial<ReplayGold>): ReplayGold => ({ endState: "duplicate", ...overrides });

describe("chooser stubs", () => {
  it("never throws and says it is unavailable", () => {
    expect(never.unavailable).toBe(true);
    expect(() => never({ quote: "q", cards })).toThrow();
  });

  it("oracle picks the gold card, none when absent, unsure when gold is a question", () => {
    expect(oracle(gold({ target: { kind: "commitment", id: "x2" } }))({ quote: "q", cards })).toBe("c2");
    expect(oracle(gold({ acceptableTargets: [{ kind: "commitment", id: "x1" }] }))({ quote: "q", cards })).toBe("c1");
    expect(oracle(gold({ target: { kind: "commitment", id: "zz" } }))({ quote: "q", cards })).toBe("none");
    expect(oracle(gold({ endState: "asked" }))({ quote: "q", cards })).toBe("unsure");
  });

  it("adversarial takes the first card, or is unsure with none", () => {
    expect(adversarial({ quote: "q", cards })).toBe("c1");
    expect(adversarial({ quote: "q", cards: [] })).toBe("unsure");
  });

  it("noisy is the oracle at p=1, adversarial at p=0, and does not depend on call order", () => {
    const g = gold({ target: { kind: "commitment", id: "x2" } });
    expect(noisy(1, "s", "case", g)({ quote: "q", cards })).toBe("c2");
    expect(noisy(0, "s", "case", g)({ quote: "q", cards })).toBe("c1");
    const a = noisy(0.5, "s", "case-a", g);
    const first = a({ quote: "q", cards });
    expect(a({ quote: "q", cards })).toBe(first);
  });
});
