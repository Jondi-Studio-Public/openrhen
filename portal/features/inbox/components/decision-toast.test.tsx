// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { RECENTLY_HANDLED_ID } from "@/components/recently-handled";
import type { DecisionToast as Toast } from "../use-inbox-decisions";
import { DecisionToast, toastMessage } from "./decision-toast";

const toast = (overrides: Partial<Toast> = {}): Toast => ({
  key: 1,
  exit: "ignore",
  ids: ["a"],
  action: { kind: "view" },
  ...overrides
});

describe("toastMessage", () => {
  it.each([
    ["confirm", ["a"], "Confirmed"],
    ["ignore", ["a"], "Ignored"],
    ["confirm", ["a", "b", "c"], "Confirmed 3 changes"],
    ["ignore", ["a", "b"], "Ignored 2 changes"]
  ] as const)("%s of %j reads %s", (exit, ids, expected) => {
    expect(toastMessage({ exit, ids: [...ids] })).toBe(expected);
  });

  it("uses the button's own word when the decision had one", () => {
    expect(toastMessage({ exit: "ignore", ids: ["a"], verb: "Dropped" })).toBe("Dropped");
    expect(toastMessage({ exit: "ignore", ids: ["a", "b"], attempted: 3 })).toBe("Ignored 2 of 3 changes");
    expect(toastMessage({ exit: "ignore", ids: ["a", "b"], verb: "Dropped" })).toBe("Dropped 2 items");
  });

  it("names what was added when the decision carries a subject, and counts several without one", () => {
    expect(toastMessage({ exit: "confirm", ids: ["a"], subject: "Added to Family: Buy printer ink" })).toBe(
      "Added to Family: Buy printer ink"
    );
    expect(toastMessage({ exit: "confirm", ids: ["a", "b"], subject: "Added: x" })).toBe("Confirmed 2 changes");
  });

  it("names what was decided on when the decision had a noun", () => {
    expect(toastMessage({ exit: "confirm", ids: ["a"], verb: "Confirmed", noun: "link" })).toBe("Link confirmed");
    expect(toastMessage({ exit: "ignore", ids: ["a"], verb: "Dismissed", noun: "finding" })).toBe("Finding dismissed");
    expect(toastMessage({ exit: "confirm", ids: ["a", "b", "c"], verb: "Confirmed", noun: "link" })).toBe(
      "Confirmed 3 links"
    );
    expect(toastMessage({ exit: "ignore", ids: ["a", "b"], verb: "Dismissed", noun: "finding" })).toBe(
      "Dismissed 2 findings"
    );
  });
});

describe("DecisionToast", () => {
  it("keeps its live region mounted when there is no toast", () => {
    render(<DecisionToast toast={null} onDismiss={() => {}} />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says what was decided", () => {
    render(<DecisionToast toast={toast({ exit: "ignore", ids: ["a", "b"] })} onDismiss={() => {}} />);
    expect(screen.getByRole("status").textContent).toContain("Ignored 2 changes");
  });

  it("runs the undo, then dismisses", async () => {
    const order: string[] = [];
    const run = vi.fn(async () => void order.push("run"));
    const onDismiss = vi.fn(() => void order.push("dismiss"));
    render(<DecisionToast toast={toast({ action: { kind: "undo", run } })} onDismiss={onDismiss} />);
    expect(screen.queryByRole("button", { name: "View in Recently handled" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await vi.waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
    expect(run).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["run", "dismiss"]);
  });

  it("shows the reason when the undo is refused, and stays", async () => {
    const run = vi.fn(async () => {
      throw new Error("This proposal is no longer ignored.");
    });
    const onDismiss = vi.fn();
    render(<DecisionToast toast={toast({ action: { kind: "undo", run } })} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await vi.waitFor(() => expect(screen.getByRole("status").textContent).toContain("no longer ignored"));
    expect(onDismiss).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("falls back to a plain sentence when the undo throws something that is not an error", async () => {
    const run = vi.fn(() => Promise.reject("nope"));
    render(<DecisionToast toast={toast({ action: { kind: "undo", run } })} onDismiss={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await vi.waitFor(() => expect(screen.getByRole("status").textContent).toContain("could not be undone"));
  });

  it("opens the room's Recently handled list, then dismisses", () => {
    const onDismiss = vi.fn();
    render(
      <>
        <details id={RECENTLY_HANDLED_ID}>
          <summary>Recently handled</summary>
        </details>
        <DecisionToast toast={toast({ exit: "confirm" })} onDismiss={onDismiss} />
      </>
    );
    const list = document.getElementById(RECENTLY_HANDLED_ID) as HTMLDetailsElement;
    expect(list.open).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "View in Recently handled" }));
    expect(list.open).toBe(true);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("still dismisses when the room has no Recently handled list", () => {
    const onDismiss = vi.fn();
    render(<DecisionToast toast={toast()} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "View in Recently handled" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("dismisses from its close button", () => {
    const onDismiss = vi.fn();
    render(<DecisionToast toast={toast()} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
