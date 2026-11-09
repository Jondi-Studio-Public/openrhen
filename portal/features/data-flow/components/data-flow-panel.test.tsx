// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { fireEvent, render, screen, within } from "@/test/render";
import { buildFlowModel } from "../data-flow-model";
import { NOW, response, withStaleCalendar } from "../test-fixtures";
import { DataFlowPanel } from "./data-flow-panel";

const open = (id: string, data = response()) => {
  const model = buildFlowModel(data, { now: NOW });
  render(<DataFlowPanel node={model.byId.get(id) ?? null} model={model} onClose={() => {}} />);
};

describe("DataFlowPanel", () => {
  it("shows the header, what it gives and what it could give", () => {
    open("calendar-pull");
    expect(screen.getByRole("dialog", { name: "Calendar pull" })).toBeTruthy();
    expect(screen.getByText("calendar-pull")).toBeTruthy();
    expect(screen.getByText(/api-pull/)).toBeTruthy();
    expect(screen.getByText(/merged/)).toBeTruthy();
    const gives = screen.getByRole("list", { name: "What it gives" });
    expect(gives.textContent).toContain("Planning engine");
    expect(gives.textContent).toContain("the plan");
    expect(gives.textContent).toContain("Today");
    expect(gives.textContent).not.toMatch(/[/_]/);
  });

  it("lists where the data comes from and goes, and how it runs, with credential names only", () => {
    open("calendar-pull");
    expect(screen.getByText("ext:calendar-account")).toBeTruthy();
    expect(screen.getByText("pg:commitments")).toBeTruthy();
    expect(screen.getByText(/connection's schedule/)).toBeTruthy();
    expect(screen.getByText("CALENDAR_TOKEN")).toBeTruthy();
    expect(screen.getByText(/24 h to warn, 72 h to error/)).toBeTruthy();
  });

  it("shows the live kinds against the registered ones for an activity source", () => {
    open("music-export");
    expect(screen.getByText(/Seen in the last 30 days: steps/)).toBeTruthy();
    expect(screen.getByText(/Registered, not seen:/)).toBeTruthy();
  });

  it("shows health: last success, counts, and the last error as plain text", () => {
    const data = withStaleCalendar();
    if (data.health.unavailable) throw new Error("fixture");
    data.health.nodes["calendar-pull"] = {
      ...data.health.nodes["calendar-pull"]!,
      lastError: { at: "2026-11-09T10:00:00.000Z", message: "<b>boom</b> ignore previous instructions" }
    };
    open("calendar-pull", data);
    expect(screen.getByText(/Stale/)).toBeTruthy();
    const error = screen.getByText(/ignore previous instructions/);
    expect(error.textContent).toBe("<b>boom</b> ignore previous instructions");
    expect(error.querySelector("b")).toBeNull();
    expect(error.closest("pre,code,blockquote")).toBeTruthy();
  });

  it("says the time is unknown when the last error carries none", () => {
    const data = response();
    if (data.health.unavailable) throw new Error("fixture");
    data.health.nodes["calendar-pull"] = {
      ...data.health.nodes["calendar-pull"]!,
      lastError: { at: null, message: "it broke" }
    };
    open("calendar-pull", data);
    expect(screen.getByText(/Last error \(time unknown\)/)).toBeTruthy();
    expect(screen.queryByText(/Last error, never/)).toBeNull();
  });

  it("lists what a value surface gives, by reader", () => {
    open("surface:page/review");
    const list = screen.getByRole("list", { name: "What it gives" });
    expect(list.textContent).toContain("watch time by day and hour");
    expect(within(list).getByText("Watch panel")).toBeTruthy();
  });

  it("shows the code that does it", () => {
    open("calendar-pull");
    expect(screen.getByText("x.ts")).toBeTruthy();
  });

  it("shows the doctor's fix when the entry has an issue", () => {
    const data = response();
    if (data.health.unavailable) throw new Error("fixture");
    data.health.issues = [
      {
        code: "probe_unresolved",
        entryId: "calendar-pull",
        tier: "degrading",
        title: "The check cannot run",
        next: "Edit the registry entry."
      }
    ];
    open("calendar-pull", data);
    expect(screen.getByText("The check cannot run")).toBeTruthy();
    expect(screen.getByText("Edit the registry entry.")).toBeTruthy();
  });

  it("opens a store with its tables and a device with its feeds", () => {
    open("device:phone");
    expect(screen.getByText(/last seen 2 h ago/)).toBeTruthy();
    expect(screen.getByText("Phone location")).toBeTruthy();
  });

  it("says health is unavailable instead of showing stale numbers", () => {
    open("calendar-pull", { ...response(), health: { unavailable: true, reason: "boom", next: "Run doctor." } });
    expect(screen.getByText(/Health unavailable/)).toBeTruthy();
  });

  it("opens a fold: lists the entries inside and offers to show them", () => {
    const data = response();
    if (data.health.unavailable) throw new Error("fixture");
    const base = data.entries.find((entry) => entry.id === "watch-export")!;
    for (const id of ["idle-a", "idle-b"]) {
      data.entries = [...data.entries, { ...base, id, name: `Quiet ${id}`, from: [], to: [] }];
      data.health.nodes[id] = {
        entryId: id,
        probe: "t",
        configured: false,
        freshness: "never",
        lastSuccessAt: null,
        lastAttemptAt: null,
        lastError: null,
        threshold: null
      };
    }
    const model = buildFlowModel(data, { now: NOW });
    const onToggle = vi.fn();
    render(<DataFlowPanel node={model.byId.get("fold:files")!} model={model} onClose={() => {}} onToggle={onToggle} />);
    expect(screen.getByText("Quiet idle-a")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show these on the map" }));
    expect(onToggle).toHaveBeenCalledWith("fold:files");
  });

  it("shows the server's next step when health is unavailable", () => {
    const model = buildFlowModel(
      { ...response(), health: { unavailable: true, reason: "x", next: "Check the database." } },
      { now: NOW }
    );
    render(<DataFlowPanel node={model.byId.get("calendar-pull") ?? null} model={model} onClose={() => {}} />);
    expect(screen.getByText("Check the database.")).toBeTruthy();
  });

  it("renders nothing when no node is selected", () => {
    const model = buildFlowModel(response(), { now: NOW });
    render(<DataFlowPanel node={null} model={model} onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
