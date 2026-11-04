// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { link, planMap, titles } from "@/features/plan-map/test-fixtures";
import { ConnectionsFold, ConnectionsSection } from "./connections-section";

vi.mock("@/state/portal-provider", () => ({ usePortal: () => ({ state: titles }) }));

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const ok = (body: unknown) => ({ ok: true, json: () => Promise.resolve(body) });

describe("ConnectionsSection", () => {
  it("loads the map and adds a link, then reloads", async () => {
    fetchMock
      .mockResolvedValueOnce(ok(planMap()))
      .mockResolvedValueOnce(ok({ link: link() }))
      .mockResolvedValueOnce(ok(planMap({ links: [link({ status: "confirmed" })] })));
    render(<ConnectionsSection itemType="action" itemId="a1" />);
    await screen.findByRole("button", { name: "Add connection" });
    fireEvent.change(screen.getByLabelText("Connect to"), { target: { value: "subject:maths" } });
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
    await screen.findByText("is about Maths");
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/plan-map/links");
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toMatchObject({ fromId: "a1", toId: "maths", kind: "about" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("link", { name: "See it on the map" }).getAttribute("href")).toBe("/map?item=action%3Aa1");
  });

  it("links the series rule for an occurrence", async () => {
    fetchMock.mockResolvedValue(ok(planMap()));
    render(<ConnectionsSection itemType="commitment" itemId="c-occ" recurrenceRuleId="rule-squad" />);
    await screen.findByRole("button", { name: "Add connection" });
    expect(screen.getByText(/applies to every occurrence/)).toBeTruthy();
    fetchMock.mockResolvedValueOnce(ok({ link: link() })).mockResolvedValue(ok(planMap()));
    fireEvent.change(screen.getByLabelText("Connect to"), { target: { value: "subject:maths" } });
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
    await screen.findByText("Nothing is connected to this yet.");
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toMatchObject({
      fromType: "commitment",
      fromId: "rule-squad"
    });
  });

  it("shows a failed load without crashing", async () => {
    fetchMock.mockRejectedValue(new Error("Network down"));
    render(<ConnectionsSection itemType="action" itemId="a1" />);
    await screen.findByText("Network down");
  });
});

describe("ConnectionsFold", () => {
  it("fetches nothing until opened", async () => {
    fetchMock.mockResolvedValue(ok(planMap()));
    render(<ConnectionsFold itemType="project" itemId="p1" />);
    expect(fetchMock).not.toHaveBeenCalled();
    const details = document.querySelector("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await screen.findByText("Nothing is connected to this yet.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
