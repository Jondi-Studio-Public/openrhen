import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// jsdom does not lay anything out, so these read the stylesheets for the rules the fixes rest on.
// Feature rules live beside their feature; `layout.tsx` imports each after `styles.css`.
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const deliverablesCss = read("../features/deliverables/deliverables.css");
const historyCss = read("../features/history/history.css");
const rule = (css: string, selector: string) => {
  const start = `\n${css}`.indexOf(`\n${selector} {`);
  expect(start, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return `\n${css}`.slice(start, `\n${css}`.indexOf("}", start));
};

const queueCss = readFileSync(new URL("../features/inbox/components/inbox-queue.module.css", import.meta.url), "utf8");
const rowCss = readFileSync(new URL("../components/ui/list-row.module.css", import.meta.url), "utf8");
const moduleRule = (source: string, selector: string) => {
  const start = source.indexOf(`${selector} {`);
  expect(start, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf("}", start));
};

describe("deliverable workspace", () => {
  it("keeps clear space above its header, as other pages do", () => {
    expect(rule(deliverablesCss, ".deliverable-workspace")).toMatch(/padding: (2[4-9]|[3-9]\d)px 16px/);
  });

  it("starts the sheet's action list under its header, not a page section's margin below it", () => {
    expect(rule(deliverablesCss, ".deliverable-sheet .workspace-rail > section")).toContain("margin-top: 0");
  });
});

describe("Inbox", () => {
  it("starts the queue's list and detail at the page's own gap instead of the global section margin", () => {
    expect(moduleRule(queueCss, ".page .list,\n.page .detail")).toContain("margin: 0");
  });

  it("marks the open row beside the detail with a surface and an edge bar, not a hairline alone", () => {
    const open = moduleRule(rowCss, ".current,\na.current:hover,\nbutton.current:hover");
    expect(open).toContain("background: var(--surface-2)");
    expect(open).toContain("box-shadow: inset 3px 0 0");
  });
});

describe("desk nav rail", () => {
  it("starts under the status banner and fits the rest of the screen, so its foot stays reachable", () => {
    const nav = readFileSync(new URL("../components/app-nav.module.css", import.meta.url), "utf8");
    const start = nav.indexOf("\n  .rail {");
    const rail = nav.slice(start, nav.indexOf("}", start));
    expect(rail).toContain("top: var(--status-banner-height, 0px)");
    expect(rail).toContain("height: calc(100vh - var(--status-banner-height, 0px))");
  });
});

describe("History", () => {
  it("draws a session's figures on a phone as three plain columns, not five boxed tiles", () => {
    const phone = historyCss.slice(historyCss.indexOf("@media (max-width: 560px) {\n  .history-metrics {"));
    const block = phone.slice(0, phone.indexOf("\n}\n"));
    expect(block).toContain("grid-template-columns: repeat(3, minmax(0, 1fr))");
    expect(block).toMatch(/\.history-metrics > div \{[^}]*border: 0/);
  });
});

describe("Deliverable stages", () => {
  it("keeps each stage's name on a phone instead of hiding it behind a bare number", () => {
    const phone = deliverablesCss.slice(deliverablesCss.lastIndexOf("@media (max-width: 720px) {"));
    const block = phone.slice(0, phone.indexOf("\n}\n"));
    expect(block).not.toMatch(/\.bcr-strip small \{[^}]*display: none/);
    expect(block).toMatch(/\.bcr-strip \{[^}]*flex-basis: 100%/);
  });
});
