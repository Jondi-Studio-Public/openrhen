import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// jsdom does not lay anything out, so these read the stylesheet for the rules the fixes rest on.
// The pill's rules sit in the Inbox's stylesheet, which `layout.tsx` imports after `styles.css`.
const css = readFileSync(new URL("../features/inbox/inbox.css", import.meta.url), "utf8");
const rule = (selector: string) => {
  const start = css.indexOf(`${selector} {`);
  expect(start, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
};

describe('"Updating plan…" pill', () => {
  it("rides above the Inbox toast on a phone and moves into the rail's foot on a desk", () => {
    expect(rule("body:has(.inbox-toast) .plan-updating-pill")).toContain("bottom: calc(var(--nav-clearance) + 76px)");
    const desk = css.slice(css.indexOf("@media (min-width: 1024px) {\n  .plan-updating-pill"));
    expect(desk.slice(0, desk.indexOf("\n}\n"))).toContain("left: 18px");
    expect(desk.slice(0, desk.indexOf("\n}\n"))).toContain("transform: none");
  });

  it("sits centred on a phone, kept clear of the floating Capture button in the corner", () => {
    const shared = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const start = shared.indexOf(".plan-updating-pill {");
    const pill = shared.slice(start, shared.indexOf("}", start));
    expect(pill).toContain("left: 50%");
    expect(pill).toContain("transform: translateX(-50%)");
    expect(pill).toContain("max-width: calc(100vw - 2 * (56px + var(--s4) * 2))");
  });

  it("steps aside where Now's own status line says it, and off the rail's own timestamp", () => {
    const shared = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    expect(shared).toContain("body:has([data-plan-status]) .plan-updating-pill {\n  display: none;");
    const nav = readFileSync(new URL("../components/app-nav.module.css", import.meta.url), "utf8");
    expect(nav).toContain(":global(body:has(.plan-updating-pill)) .updated {\n    visibility: hidden;");
  });

  it("rises clear of Now's docked action bar on a phone, with the Capture button", () => {
    const now = readFileSync(new URL("../features/now/now.css", import.meta.url), "utf8");
    const start = now.indexOf("body:has(.action-bar > .actions) .plan-updating-pill {");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(now.slice(start, now.indexOf("}", start))).toContain("var(--docked-actions-height)");
  });
});
