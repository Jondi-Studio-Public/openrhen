// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanMap } from "@openrhen/contracts";
import { act, render, screen } from "@/test/render";
import {
  publishPlanMapOpenCount,
  refreshPlanMapOpenCount,
  resetPlanMapOpenCount,
  usePlanMapOpenCount
} from "./plan-map-open-count";

const map = (links: number, findings: number) =>
  ({
    links: Array.from({ length: links }, () => ({ status: "suggested" })),
    findings: Array.from({ length: findings }, () => ({ status: "open" }))
  }) as unknown as PlanMap;

function Count() {
  return <p>{`open: ${usePlanMapOpenCount()}`}</p>;
}

afterEach(() => {
  act(() => resetPlanMapOpenCount());
  vi.unstubAllGlobals();
});

describe("plan map open count", () => {
  it("counts suggested links and open findings and moves when the map is published", () => {
    render(<Count />);
    expect(screen.getByText("open: 0")).toBeTruthy();
    act(() => publishPlanMapOpenCount(map(2, 1)));
    expect(screen.getByText("open: 3")).toBeTruthy();
    act(() => publishPlanMapOpenCount(null));
    expect(screen.getByText("open: 3")).toBeTruthy();
  });

  it("keeps the last known count when a read fails", async () => {
    render(<Count />);
    act(() => publishPlanMapOpenCount(map(1, 0)));
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline")))
    );
    await act(async () => {
      await refreshPlanMapOpenCount();
    });
    expect(screen.getByText("open: 1")).toBeTruthy();
  });
});
