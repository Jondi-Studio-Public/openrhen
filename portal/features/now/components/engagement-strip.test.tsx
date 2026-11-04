// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { fireEvent, render, screen } from "@/test/render";
import type { NowOpenAnchor } from "@/features/now/now-model";
import { EngagementStrip } from "./engagement-strip";

const now = new Date("2026-08-18T10:00:00.000Z");
const state = createSeedState(now);
const openAnchor: NowOpenAnchor = {
  id: "carnival",
  title: "Swimming carnival",
  phase: "active",
  startsAt: new Date(now.getTime() - 30 * 60_000),
  endsAt: new Date(now.getTime() + 90 * 60_000),
  protectedStartAt: new Date(now.getTime() - 45 * 60_000),
  protectedEndAt: new Date(now.getTime() + 105 * 60_000),
  phaseStartsAt: new Date(now.getTime() - 30 * 60_000),
  phaseEndsAt: new Date(now.getTime() + 90 * 60_000)
};

describe("EngagementStrip", () => {
  it("names where you are and offers to record being engaged in it", () => {
    const runActivityCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <EngagementStrip
        openAnchor={openAnchor}
        storedOpenAnchor={{ ...state.commitments[0]!, id: "carnival", version: 4 }}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        runActivityCommand={runActivityCommand}
      />
    );
    expect(screen.getByText("Swimming carnival")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "I’m engaged in Swimming carnival" }));
    // Engagement runs to the end of the commitment itself, not to the end of its protection: the
    // transition buffer afterwards is time you are getting home, not time you are at the thing.
    // The engine validates a fixed_commitment session against the anchor's own phase (report: the
    // validation only ever checked `protectedCommitment`, so an open anchor's id lookup failed and
    // this button never worked) — the client must send it, not just the id.
    expect(runActivityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "start_activity",
        targetType: "fixed_commitment",
        targetId: "carnival",
        phase: "active",
        expectedVersion: 4,
        plannedMinutes: 90
      })
    );
  });

  it("stays quiet about a version it has no stored row for", () => {
    const runActivityCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <EngagementStrip
        openAnchor={openAnchor}
        storedOpenAnchor={undefined}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        runActivityCommand={runActivityCommand}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "I’m engaged in Swimming carnival" }));
    expect(runActivityCommand).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: null }));
  });
});
