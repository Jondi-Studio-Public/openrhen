import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./data-flow.module.css", import.meta.url), "utf8");

/** The focus and selection ring must beat the red and amber tone strokes: same specificity, so it has to come later. */
describe("data-flow map styles", () => {
  const at = (selector: string) => css.lastIndexOf(selector);

  it("puts the focus, hover and selected ring after every tone stroke", () => {
    const ring = at(".node:focus-visible rect.box");
    expect(ring).toBeGreaterThan(-1);
    for (const tone of ['[data-tone="red"]', '[data-tone="amber"]']) {
      expect(at(`.node${tone} rect.box`)).toBeGreaterThan(-1);
      expect(at(`.node${tone} rect.box`)).toBeLessThan(ring);
    }
    expect(at('.node[data-selected="true"] rect.box')).toBeGreaterThan(at('.node[data-tone="amber"] rect.box'));
  });

  it("gives the ring the focus colour and a heavier stroke than the nodes' own", () => {
    const block = css.slice(css.lastIndexOf(".node:hover rect.box"));
    expect(block).toMatch(/stroke:\s*var\(--focus-ring\)/);
    expect(block).toMatch(/stroke-width:\s*3/);
  });

  it("keeps pass-through text at full strength so it stays readable", () => {
    expect(css).not.toMatch(/data-pass="true"\]\s*text\s*\{[^}]*opacity/);
  });
});
