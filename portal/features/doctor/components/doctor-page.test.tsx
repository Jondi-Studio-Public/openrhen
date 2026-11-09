// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { createSeedState } from "@/state/portal-state";
import { freezeClock } from "@/shared/clock";
import { fireEvent, render, screen } from "@/test/render";
import { DoctorPage } from "./doctor-page";

const now = new Date("2026-10-29T12:00:00.000Z");
freezeClock(now);
const seed = createSeedState(now);

vi.mock("@/state/portal-provider", () => ({ usePortal: () => ({ state: seed }) }));

const report = {
  generatedAt: now.toISOString(),
  healthy: false,
  counts: { blocking: 1, degrading: 1, tidy: 0 },
  byArea: { facts: 1, plan: 1 },
  notChecked: [{ check: "backups", reason: "Not recorded in the database." }],
  items: [
    {
      id: "stale_wake",
      check: "stale_wake",
      tier: "blocking",
      area: "facts",
      title: "Wake time is out of date",
      why: "Capacity is planned from the last wake.",
      handles: [],
      since: "2026-10-26T12:00:00.000Z",
      fix: { who: "person", question: "When did you wake up?", cli: "rhen wake --at <time>" }
    },
    {
      id: "no_estimate:a1",
      check: "no_estimate",
      tier: "degrading",
      area: "plan",
      title: "Write report has no estimate",
      why: "Capacity leans on a default.",
      handles: ["commitment:c1"],
      fix: { who: "agent", cli: "rhen save action --id a1 --set expectedMinutes=<minutes>" }
    }
  ]
};

function stub(body: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok, json: async () => body }))
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("DoctorPage", () => {
  it("shows the summary, tiers with their fixes, and the not-checked notes", async () => {
    stub(report);
    render(<DoctorPage />);
    expect(await screen.findByText("1 blocking, 1 degrading")).toBeTruthy();
    expect(screen.getByText(/Not checked: backups/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Blocking/ })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /Tidy/ })).toBeNull();
    expect(screen.getByText("When did you wake up?")).toBeTruthy();
    expect(screen.getByText("for 3 days")).toBeTruthy();
    expect(screen.getByText("An agent can fix this")).toBeTruthy();
    expect(screen.getByText("rhen save action --id a1 --set expectedMinutes=<minutes>")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open commitment" }).getAttribute("href")).toBe("/commitments/c1");
  });

  it("shows the data-source counts with a link to the Data page, and the agent's next step", async () => {
    stub({
      ...report,
      sources: {
        late: 4,
        failing: 0,
        deviceSilent: 1,
        collectedUnused: 11,
        nothingSends: 5,
        line: "4 late · 1 device silent"
      },
      items: [
        {
          ...report.items[1],
          fix: { who: "agent", cli: "rhen sources x", next: "Correct the health probe on entry x." }
        }
      ]
    });
    render(<DoctorPage />);
    expect(await screen.findByText(/4 late · 1 device silent/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "See the Data page" }).getAttribute("href")).toBe("/data");
    expect(screen.getByText("Correct the health probe on entry x.")).toBeTruthy();
    expect(screen.getByText("rhen sources x")).toBeTruthy();
  });

  it("draws no counts line when every source count is zero", async () => {
    stub({
      ...report,
      sources: { late: 0, deviceSilent: 0, collectedUnused: 0, nothingSends: 0, line: null }
    });
    render(<DoctorPage />);
    await screen.findByText("1 blocking, 1 degrading");
    expect(screen.queryByRole("link", { name: "See the Data page" })).toBeNull();
  });

  it("filters by area", async () => {
    stub(report);
    render(<DoctorPage />);
    await screen.findByText("Wake time is out of date");
    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    expect(screen.queryByText("Wake time is out of date")).toBeNull();
    expect(screen.getByText("Write report has no estimate")).toBeTruthy();
  });

  it("says Healthy and draws no tier when there is nothing", async () => {
    stub({ ...report, healthy: true, counts: { blocking: 0, degrading: 0, tidy: 0 }, items: [] });
    render(<DoctorPage />);
    expect(await screen.findByText("Healthy")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });

  it("shows an error with a way to retry", async () => {
    stub({}, false);
    render(<DoctorPage />);
    expect((await screen.findByRole("alert")).textContent).toContain("could not be loaded");
    stub(report);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("1 blocking, 1 degrading")).toBeTruthy());
  });
});
