// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/test/render";
import { closeReply, conflictReply, jsonResponse, resultFor } from "@/test/close-fixtures";
import { stubCloseServer } from "@/test/close-server";
import { createSeedState } from "@/state/portal-state";
import { PortalProvider } from "@/state/portal-provider";
import { closeCommandFor } from "../close-commands";
import { closeToasts } from "../close-toast-store";
import { CloseToastRegion } from "./close-toast";

/** The toast after a close: Undo restores at the version the close left, waits while hovered, and keeps its words on a failed Undo. */
const ID = "5f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
const closedProject = (extra = {}) =>
  resultFor(closeCommandFor({ type: "project", id: "p1", version: 4 }, "archive", { commandId: ID }), {
    version: 4,
    ...extra
  });

/** The provider shows a loading page until its first read answers, so wait for the region. */
const mount = async () => {
  render(
    <PortalProvider>
      <CloseToastRegion />
    </PortalProvider>
  );
  await screen.findByRole("status", { name: "Archive and cancel results" });
};

beforeEach(() => {
  closeToasts.clear();
  stubCloseServer((command) => closeReply(createSeedState(), resultFor(command, { version: 5 })));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CloseToastRegion", () => {
  it("is a polite live region that stays mounted, empty until there is a toast", async () => {
    await mount();
    const region = screen.getByRole("status", { name: "Archive and cancel results" });
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");
  });

  it("shows what closed with an Undo and a dismiss button", async () => {
    await mount();
    act(() => closeToasts.show({ kind: "closed", title: "Quarterly report", closed: closedProject() }));
    expect(screen.getByRole("status", { name: "Archive and cancel results" }).textContent).toContain(
      "Quarterly report archived."
    );
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(closeToasts.get()).toBeNull();
  });

  it("Undo posts a restore at the version the close left, then says it is back", async () => {
    const { posts } = stubCloseServer((command) =>
      closeReply(createSeedState(), resultFor(command, { version: 5, closedFrom: "paused" }))
    );
    await mount();
    act(() => closeToasts.show({ kind: "closed", title: "Quarterly report", closed: closedProject() }));
    const undo = await screen.findByRole("button", { name: "Undo" });
    await act(async () => {
      fireEvent.click(undo);
    });
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Archive and cancel results" }).textContent).toContain(
        "Restored Quarterly report as paused."
      )
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ type: "project", id: "p1", verb: "archive", do: "restore", expectedVersion: 5 });
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("Undo of a close that took children asks for them back too", async () => {
    const { posts } = stubCloseServer((command) =>
      closeReply(createSeedState(), resultFor(command, { version: 5, closedFrom: "active" }))
    );
    await mount();
    const closed = {
      ...closedProject({ cascaded: [{ type: "action", id: "a1", from: "planned", version: 2 }] }),
      type: "outcome"
    };
    act(() => closeToasts.show({ kind: "closed", title: "Garden", closed }));
    const undo = await screen.findByRole("button", { name: "Undo" });
    await act(async () => {
      fireEvent.click(undo);
    });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ type: "outcome", includeChildren: true });
  });

  it("stays on screen with the reason when the Undo fails, and does not time out", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubCloseServer((command) => conflictReply(command, 9));
    await mount();
    act(() => closeToasts.show({ kind: "closed", title: "Quarterly report", closed: closedProject() }));
    const undo = await screen.findByRole("button", { name: "Undo" });
    await act(async () => {
      fireEvent.click(undo);
    });
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Archive and cancel results" }).textContent).toContain(
        "Changed since you closed it, so it was not restored. Open Review > Closed to restore it."
      )
    );
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(closeToasts.get()).not.toBeNull();
    // and Undo can be tried again
    expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the server's sentence when a parent was closed meanwhile", async () => {
    stubCloseServer(() =>
      jsonResponse(
        { error: 'Project "p1" cannot be restored while outcome "o1" above it is cancelled. Restore that first.' },
        400
      )
    );
    await mount();
    act(() => closeToasts.show({ kind: "closed", title: "Quarterly report", closed: closedProject() }));
    const undo = await screen.findByRole("button", { name: "Undo" });
    await act(async () => {
      fireEvent.click(undo);
    });
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Archive and cancel results" }).textContent).toContain(
        "Restore that first."
      )
    );
  });

  it("goes after ten seconds, but not while the pointer or focus is on it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await mount();
    act(() => closeToasts.show({ kind: "closed", title: "Quarterly report", closed: closedProject() }));
    const card = screen.getByRole("button", { name: "Undo" }).parentElement!;
    act(() => {
      vi.advanceTimersByTime(9_000);
    });
    expect(closeToasts.get()).not.toBeNull();
    fireEvent.pointerEnter(card);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(closeToasts.get()).not.toBeNull();
    fireEvent.pointerLeave(card);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(closeToasts.get()).toBeNull();
  });

  it("is replaced by the next toast", async () => {
    await mount();
    act(() => closeToasts.show({ kind: "closed", title: "First", closed: closedProject() }));
    act(() => closeToasts.show({ kind: "notice", text: "Restored Second as active." }));
    expect(screen.getByRole("status", { name: "Archive and cancel results" }).textContent).toContain(
      "Restored Second as active."
    );
    expect(screen.getByRole("status", { name: "Archive and cancel results" }).textContent).not.toContain("First");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("puts keyboard focus on Undo when the button that closed the row has gone", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await mount();
    act(() => closeToasts.show({ kind: "closed", title: "Quarterly report", closed: closedProject() }));
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Undo" }));
  });
});
