// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@/test/render";
import { buildTitleResolver, connectionCandidates } from "@/features/plan-map/plan-map-model";
import { link, planMap, titles } from "@/features/plan-map/test-fixtures";
import { ConnectionsPanel } from "./connections-panel";

const map = planMap();
const resolver = buildTitleResolver(titles, map);
const candidates = connectionCandidates(titles, map);

function show(overrides: Partial<Parameters<typeof ConnectionsPanel>[0]> = {}) {
  const props = {
    item: { type: "action", id: "a1" } as const,
    map,
    status: "ready" as const,
    error: "",
    actionError: "",
    busy: false,
    resolver,
    candidates,
    onRetry: vi.fn(),
    onAdd: vi.fn().mockResolvedValue(true),
    onDecide: vi.fn(),
    ...overrides
  };
  render(<ConnectionsPanel {...props} />);
  return props;
}

describe("Connections panel", () => {
  it("says so when nothing is connected, and defaults the form to about with a subject", () => {
    show();
    expect(screen.getByText("Nothing is connected to this yet.")).toBeTruthy();
    expect((screen.getByLabelText("This item") as HTMLSelectElement).selectedOptions[0]!.textContent).toBe("is about");
    const target = screen.getByLabelText("Connect to") as HTMLSelectElement;
    expect([...target.options].map((option) => option.textContent)).toEqual(["Choose…", "Maths", "Meals"]);
  });

  it("waits for a target to be chosen, then adds the subject link", () => {
    const props = show();
    const add = screen.getByRole("button", { name: "Add connection" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.click(add);
    expect(props.onAdd).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Connect to"), { target: { value: "subject:maths" } });
    fireEvent.click(add);
    expect(props.onAdd).toHaveBeenCalledWith({
      kind: "about",
      fromType: "action",
      fromId: "a1",
      toType: "subject",
      toId: "maths"
    });
  });

  it("offers other items only for a kind the contract allows, and links to the one chosen", () => {
    const props = show();
    fireEvent.change(screen.getByLabelText("This item"), { target: { value: "prepares:out" } });
    const target = screen.getByLabelText("Connect to") as HTMLSelectElement;
    const labels = [...target.options].map((option) => option.textContent);
    expect(labels).toContain("Maths exam");
    expect(labels).not.toContain("Practice paper");
    fireEvent.change(target, { target: { value: "project:p2" } });
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
    expect(props.onAdd).toHaveBeenCalledWith({
      kind: "prepares",
      fromType: "action",
      fromId: "a1",
      toType: "project",
      toId: "p2"
    });
  });

  it("does not offer before or occurrence_of to an action", () => {
    show();
    const kinds = [...(screen.getByLabelText("This item") as HTMLSelectElement).options].map((o) => o.textContent);
    expect(kinds).not.toContain("comes before");
    expect(kinds).not.toContain("is an occurrence of");
  });

  it("lists a confirmed link with Remove and a suggested one dashed, marked, with Confirm and Reject", () => {
    const confirmed = link({ status: "confirmed", toId: "maths" });
    const suggested = link({ toType: "project", toId: "p1", kind: "prepares", evidence: ["Same week"] });
    const props = show({ map: planMap({ links: [confirmed, suggested] }) });
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]!.className).not.toContain("suggested");
    expect(within(rows[0]!).getByText("is about Maths")).toBeTruthy();
    fireEvent.click(within(rows[0]!).getByRole("button", { name: "Remove" }));
    expect(props.onDecide).toHaveBeenCalledWith(confirmed, "remove");
    expect(rows[1]!.className).toContain("suggested");
    expect(within(rows[1]!).getByText("suggested")).toBeTruthy();
    expect(within(rows[1]!).getByText(/Same week/)).toBeTruthy();
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Confirm" }));
    expect(props.onDecide).toHaveBeenCalledWith(suggested, "confirm");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Reject" }));
    expect(props.onDecide).toHaveBeenCalledWith(suggested, "reject");
  });

  it("drops a pair already linked from the choices", () => {
    show({ map: planMap({ links: [link({ status: "confirmed", toId: "maths" })] }) });
    const target = screen.getByLabelText("Connect to") as HTMLSelectElement;
    expect([...target.options].map((option) => option.textContent)).toEqual(["Choose…", "Meals"]);
  });

  it("notes that a series' link applies to every occurrence", () => {
    show({ item: { type: "commitment", id: "rule-squad" }, recurring: true });
    expect(screen.getByText(/applies to every occurrence/)).toBeTruthy();
  });

  it("shows loading, a load error with retry, and a failed save, without the form until loaded", () => {
    const loading = show({ map: null, status: "loading" });
    expect(screen.getByText("Loading connections...")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add connection" })).toBeNull();
    expect(loading.onRetry).not.toHaveBeenCalled();
  });

  it("offers a retry when the map cannot be read", () => {
    const props = show({ map: null, status: "error", error: "Offline" });
    expect(screen.getByText("Offline")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(props.onRetry).toHaveBeenCalled();
  });

  it("reports a failed change", () => {
    show({ actionError: "An item cannot link to itself." });
    expect(screen.getByRole("alert").textContent).toBe("An item cannot link to itself.");
  });
});
