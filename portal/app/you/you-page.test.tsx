// @vitest-environment jsdom
import "@/test/example-calendar-sources";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { act, fireEvent, render, screen, within } from "@/test/render";
import { createSeedState } from "@/state/portal-state";
import { closeGoTo, useGoToOpen } from "@/shared/use-go-to";
import type { ConnectionSummary } from "@/features/connections/connection-summaries";
import { hoursLabel, lastNightMinutes } from "@/features/you/use-you-overview";

const seed = createSeedState(new Date("2026-10-27T10:00:00.000Z"));
const context = { state: seed };
vi.mock("@/state/portal-provider", () => ({ usePortal: () => context }));

const summaries: ConnectionSummary[] = [
  { id: "planner", title: "Planner", state: "on", meta: "Recalculated 8:33 am" },
  {
    id: "example_shared",
    title: "Example Shared family calendar",
    state: "setup",
    meta: "Needs a setting on the server"
  }
];
vi.mock("@/features/connections/connection-summaries", async (original) => ({
  ...(await original<typeof import("@/features/connections/connection-summaries")>()),
  useRecordedConnectionSummaries: () => summaries
}));

const night = {
  id: "n1",
  plannedStartAt: "2026-10-26T12:40:00.000Z",
  plannedWakeAt: "2026-10-26T20:20:00.000Z",
  actualStartAt: "2026-10-26T12:50:00.000Z",
  actualWakeAt: "2026-10-26T20:20:00.000Z",
  desiredMinutes: 460,
  allowedMinutes: 460,
  sleepDeficitMinutes: 0,
  anchorDeviationMinutes: 0,
  hardErrors: [],
  explanation: "",
  status: "completed"
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith("/api/sleep-log")) return Response.json({ sleepPlans: [night] });
      if (url.startsWith("/api/photo-checkins")) return Response.json({ mode: "off", photos: [] });
      if (url === "/api/snapshots") return Response.json({ snapshots: [{ reviewedAt: null }, { reviewedAt: "x" }] });
      return Response.json({});
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  act(() => closeGoTo());
});

function Probe() {
  return <p>{useGoToOpen() ? "open" : "closed"}</p>;
}

describe("You", () => {
  it("answers with the connections, and lists records, connections and settings", async () => {
    const { default: YouPage } = await import("./page");
    render(<YouPage />);
    expect(screen.getByRole("heading", { level: 1, name: "You" })).toBeTruthy();
    expect(
      screen.getByText(
        "Everything is connected except Example Shared family calendar, which needs a setting on the server."
      )
    ).toBeTruthy();
    for (const name of ["Records", "Connections"]) expect(screen.getByRole("heading", { level: 2, name })).toBeTruthy();

    const records = screen.getByRole("heading", { level: 2, name: "Records" }).closest("section")!;
    await waitFor(() =>
      expect(within(records).getByRole("link", { name: /Sleep log/ }).textContent).toContain("Last night 7 h 30 m")
    );
    expect(within(records).getByRole("link", { name: /Photo check-ins/ }).textContent).toContain("None yet");
    expect(within(records).getByRole("link", { name: /Reported issues/ }).textContent).toContain("1 to look at");

    const connections = screen.getByRole("heading", { level: 2, name: "Connections" }).closest("section")!;
    const example_shared = within(connections).getByRole("link", { name: /Example Shared/ });
    expect(example_shared.getAttribute("href")).toBe("/connections#example_shared");
    expect(example_shared.textContent).toContain("Setup");

    const settings = screen.getByRole("heading", { level: 2, name: "Settings" }).closest("section")!;
    expect(
      within(settings)
        .getByRole("link", { name: /Sign-in and devices/ })
        .getAttribute("href")
    ).toBe("/settings/advanced");
  });

  it("folds Records into a sheet on a phone, and Connections into one row each", async () => {
    const { default: YouPage } = await import("./page");
    render(<YouPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Records/ }));
    const sheet = await screen.findByRole("dialog", { name: "Records" });
    expect(
      within(sheet)
        .getByRole("link", { name: /History/ })
        .getAttribute("href")
    ).toBe("/history");
    const connections = screen.getAllByRole("link", { name: /^Connections/ })[0]!;
    expect(connections.getAttribute("href")).toBe("/connections");
    expect(connections.textContent).toContain("1 on · 1 needs setup");
  });

  it("shows an unconfigured optional connection as Optional, not as needing setup", async () => {
    const original = [...summaries];
    summaries.push({
      id: "openai",
      title: "OpenAI",
      state: "setup",
      meta: "Not connected (optional)",
      optional: true
    });
    try {
      const { default: YouPage } = await import("./page");
      render(<YouPage />);
      const connections = screen.getByRole("heading", { level: 2, name: "Connections" }).closest("section")!;
      const row = within(connections).getByRole("link", { name: /OpenAI/ });
      expect(row.textContent).toContain("Optional");
      expect(row.textContent).not.toContain("Setup");
      expect(screen.getAllByRole("link", { name: /^Connections/ })[0]!.textContent).toContain("1 on · 1 needs setup");
    } finally {
      summaries.splice(0, summaries.length, ...original);
    }
  });

  it("opens Go to from its search row, for a phone with no Ctrl K", async () => {
    const { default: YouPage } = await import("./page");
    render(
      <>
        <YouPage />
        <Probe />
      </>
    );
    fireEvent.click(screen.getByRole("button", { name: /Go to a page or setting/ }));
    expect(screen.getByText("open")).toBeTruthy();
  });
});

describe("You overview helpers", () => {
  it("measures the latest night that has ended", () => {
    expect(lastNightMinutes([night] as never, new Date("2026-10-27T00:00:00.000Z"))).toBe(450);
    expect(lastNightMinutes([night] as never, new Date("2026-10-26T15:00:00.000Z"))).toBeNull();
  });

  it("writes hours and minutes the way the mockups do", () => {
    expect(hoursLabel(450)).toBe("7 h 30 m");
    expect(hoursLabel(480)).toBe("8 h");
    expect(hoursLabel(40)).toBe("40 m");
  });
});
