// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeEntityCommandSchema,
  type ClosedPage,
  type ClosedRow,
  type CloseEntityCommand
} from "@openrhen/contracts";
import { fireEvent, render, screen, waitFor, within } from "@/test/render";
import { resultFor } from "@/test/close-fixtures";
import { createSeedState } from "@/state/portal-state";
import { CommandRefusal } from "@/shared/command-refusal";

vi.mock("@/components/place-tabs", () => ({ PlaceTabs: () => null }));

const seed = createSeedState(new Date("2026-11-04T00:00:00.000Z"));
const closeEntityCommand = vi.fn();
const context = { state: seed, closeEntityCommand };
vi.mock("@/state/portal-provider", () => ({ usePortal: () => context }));

import ClosedPageRoute from "./page";

const row = (extra: Partial<ClosedRow> = {}): ClosedRow => ({
  type: "action",
  id: "a1",
  title: "Write the intro",
  parent: "Quarterly report",
  status: "cancelled",
  version: 3,
  closedAt: "2026-11-03T10:00:00.000Z",
  closedBy: "person",
  reason: null,
  fromStatus: "active",
  batchSize: 0,
  blockedBy: null,
  restoreVerb: "cancel",
  ...extra
});

const page = (rows: ClosedRow[], extra: Partial<ClosedPage> = {}): ClosedPage => ({
  rows,
  nextCursor: null,
  counts: { archived: 1, cancelled: rows.length },
  ...extra
});

let answers: Array<() => Response>;
const urls: string[] = [];
const ok = (body: ClosedPage) => () => new Response(JSON.stringify(body), { status: 200 });

beforeEach(() => {
  urls.length = 0;
  closeEntityCommand.mockReset();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/review/closed");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      const next = answers.length > 1 ? answers.shift()! : answers[0]!;
      return next();
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("Closed page", () => {
  it("lists a closed row with who closed it, when, why and how many closed with it", async () => {
    answers = [
      ok(
        page([
          row({
            closedBy: "agent:codex",
            reason: "Duplicate of another",
            type: "project",
            title: "Old plan",
            batchSize: 3
          })
        ])
      )
    ];
    render(<ClosedPageRoute />);
    expect(await screen.findByText("Old plan")).toBeTruthy();
    expect(screen.getByText(/Agent codex, /)).toBeTruthy();
    expect(screen.getByText(/Reason: Duplicate of another/)).toBeTruthy();
    expect(screen.getByText("Closed with 2 others.")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Cancelled (1)" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Archived (1)" })).toBeTruthy();
  });

  it("opens the tab the link names, and marks the page as looked at", async () => {
    window.history.replaceState(null, "", "/review/closed?tab=cancelled");
    answers = [ok(page([row()]))];
    render(<ClosedPageRoute />);
    await screen.findByText("Write the intro");
    expect(urls[0]).toContain("tab=cancelled");
    expect(screen.getByRole("tab", { name: /Cancelled/ }).getAttribute("aria-selected")).toBe("true");
    expect(window.localStorage.getItem("openrhen.closed.lookedAt")).not.toBeNull();
  });

  it("labels each closer in words", async () => {
    answers = [
      ok(
        page([
          row({ id: "1", title: "A", closedBy: "person" }),
          row({ id: "2", title: "B", closedBy: "agent:codex:confirmed" }),
          row({ id: "3", title: "C", closedBy: "system" }),
          row({ id: "4", title: "D", closedBy: null })
        ])
      )
    ];
    render(<ClosedPageRoute />);
    await screen.findByText("A");
    expect(screen.getByText(/^You, /)).toBeTruthy();
    expect(screen.getByText(/Agent codex, confirmed by you/)).toBeTruthy();
    expect(screen.getByText(/Imported or synced/)).toBeTruthy();
    expect(screen.getByText(/Earlier \(unknown\)/)).toBeTruthy();
  });

  it("restores through the close route with a schema-valid body, then reads the list again", async () => {
    answers = [ok(page([row()])), ok(page([], { counts: { archived: 1, cancelled: 0 } }))];
    closeEntityCommand.mockImplementation(async (command: CloseEntityCommand) => {
      const parsed = closeEntityCommandSchema.parse(command);
      return resultFor(parsed, { version: 4 });
    });
    render(<ClosedPageRoute />);
    fireEvent.click(await screen.findByRole("button", { name: 'Restore action "Write the intro"' }));
    await screen.findByText("Nothing is archived.");
    const sent = closeEntityCommand.mock.calls[0]![0] as CloseEntityCommand;
    expect(sent).toMatchObject({ type: "action", id: "a1", verb: "cancel", do: "restore", expectedVersion: 3 });
    expect(sent.includeChildren).toBeUndefined();
  });

  it("offers restoring with what closed with it, or only the row, for a parent", async () => {
    answers = [ok(page([row({ type: "outcome", id: "o1", title: "Ship it", batchSize: 4, restoreVerb: "archive" })]))];
    closeEntityCommand.mockImplementation(async (command: CloseEntityCommand) => resultFor(command, { version: 5 }));
    render(<ClosedPageRoute />);
    fireEvent.click(await screen.findByRole("button", { name: "Restore with the 3 closed with it" }));
    await waitFor(() => expect(closeEntityCommand).toHaveBeenCalled());
    expect((closeEntityCommand.mock.calls[0]![0] as CloseEntityCommand).includeChildren).toBe(true);
    expect(screen.getByRole("button", { name: "Restore only this" })).toBeTruthy();
  });

  it("disables Restore under a closed parent and names it, switching to its tab", async () => {
    answers = [
      ok(page([row({ blockedBy: { type: "project", id: "p1", title: "Parent project", status: "archived" } })])),
      ok(page([], { counts: { archived: 1, cancelled: 1 } }))
    ];
    render(<ClosedPageRoute />);
    const restore = await screen.findByRole("button", {
      name: /Restore action "Write the intro" \(restore Parent project first\)/
    });
    expect((restore as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Restore Parent project first" }));
    await waitFor(() => expect(urls.some((url) => url.includes("tab=archived"))).toBe(true));
    expect(window.location.search).toBe("?tab=archived");
  });

  async function failRestore(error: Error, expected: string) {
    answers = [ok(page([row()])), ok(page([row({ version: 5 })]))];
    closeEntityCommand.mockRejectedValue(error);
    render(<ClosedPageRoute />);
    fireEvent.click(await screen.findByRole("button", { name: 'Restore action "Write the intro"' }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(expected);
    // The list is read again whatever went wrong.
    await waitFor(() => expect(urls.length).toBe(2));
  }

  it("reads the list again after a stale restore and says the list changed, not the server's sentence", async () => {
    await failRestore(
      new CommandRefusal("Version 3 is stale; the current version is 5.", { status: 409, currentVersion: 5 }),
      "Changed since the list was loaded; it has been refreshed."
    );
  });

  it("still says why a restore failed when the re-read list no longer has the row", async () => {
    answers = [ok(page([row()])), ok(page([], { counts: { archived: 1, cancelled: 0 } }))];
    closeEntityCommand.mockRejectedValue(
      new CommandRefusal("Version 3 is stale; the current version is 5.", { status: 409, currentVersion: 5 })
    );
    render(<ClosedPageRoute />);
    fireEvent.click(await screen.findByRole("button", { name: 'Restore action "Write the intro"' }));
    await screen.findByText("Nothing is archived.");
    expect(screen.getByText(/Write the intro/)).toBeTruthy();
    expect(screen.getByText(/Changed since the list was loaded/)).toBeTruthy();
  });

  it("says the server could not be reached, not that the item changed, after a network error", async () => {
    await failRestore(
      new TypeError("Failed to fetch"),
      "The server could not be reached; the change may not have been saved. Check and try again."
    );
  });

  it("shows the closed-parent sentence when another tab closed the parent meanwhile", async () => {
    const sentence = 'Action "a1" cannot be restored while project "p1" above it is cancelled. Restore that first.';
    await failRestore(new CommandRefusal(sentence, { status: 400 }), sentence);
  });

  it("moves between the tabs with the arrow keys, Home and End, keeping one tab in the tab order", async () => {
    answers = [ok(page([row()]))];
    render(<ClosedPageRoute />);
    const archived = await screen.findByRole("tab", { name: /Archived/ });
    const cancelled = screen.getByRole("tab", { name: /Cancelled/ });
    expect(archived.getAttribute("tabindex")).toBe("0");
    expect(cancelled.getAttribute("tabindex")).toBe("-1");
    fireEvent.keyDown(archived, { key: "ArrowRight" });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /Cancelled/ }).getAttribute("aria-selected")).toBe("true")
    );
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /Cancelled/ }));
    expect(screen.getByRole("tab", { name: /Archived/ }).getAttribute("tabindex")).toBe("-1");
    fireEvent.keyDown(screen.getByRole("tab", { name: /Cancelled/ }), { key: "ArrowRight" });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /Archived/ }).getAttribute("aria-selected")).toBe("true")
    );
    fireEvent.keyDown(screen.getByRole("tab", { name: /Archived/ }), { key: "End" });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /Cancelled/ }).getAttribute("aria-selected")).toBe("true")
    );
    fireEvent.keyDown(screen.getByRole("tab", { name: /Cancelled/ }), { key: "Home" });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /Archived/ }).getAttribute("aria-selected")).toBe("true")
    );
    fireEvent.keyDown(screen.getByRole("tab", { name: /Archived/ }), { key: "ArrowLeft" });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /Cancelled/ }).getAttribute("aria-selected")).toBe("true")
    );
  });

  it("keeps the rows 'Show older' loaded when the list is read again", async () => {
    const second = page([row({ id: "2", title: "Second" })], { counts: { archived: 0, cancelled: 2 } });
    const firstPage = page([row({ id: "1", title: "First" })], {
      nextCursor: "2026-11-01T00:00:00.000000Z|action:1",
      counts: { archived: 0, cancelled: 2 }
    });
    answers = [ok(firstPage), ok(second), ok(firstPage), ok(second)];
    closeEntityCommand.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<ClosedPageRoute />);
    fireEvent.click(await screen.findByRole("button", { name: "Show older" }));
    await screen.findByText("Second");
    // A failed restore reads the list again; both rows must still be there afterwards.
    fireEvent.click(screen.getAllByRole("button", { name: /^Restore action/ })[0]!);
    await waitFor(() => expect(urls.length).toBeGreaterThanOrEqual(4));
    expect(screen.getByText("Second")).toBeTruthy();
    expect(screen.getByText("First")).toBeTruthy();
  });

  it("says so when the list cannot be read and tries again", async () => {
    answers = [() => new Response("{}", { status: 500 }), ok(page([row()]))];
    render(<ClosedPageRoute />);
    expect(await screen.findByText("The closed list could not be read.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Write the intro")).toBeTruthy();
    expect(screen.queryByText("The closed list could not be read.")).toBeNull();
  });

  it("shows an empty state, and a different one when nothing was ever closed", async () => {
    answers = [ok(page([], { counts: { archived: 0, cancelled: 0 } }))];
    render(<ClosedPageRoute />);
    expect(await screen.findByText("Nothing has been archived or cancelled.")).toBeTruthy();
  });

  it("pages older rows in and moves focus to the first new one", async () => {
    answers = [
      ok(page([row({ id: "1", title: "First" })], { nextCursor: "2026-11-01T00:00:00.000000Z|action:1" })),
      ok(page([row({ id: "2", title: "Second" })], { counts: { archived: 0, cancelled: 2 } }))
    ];
    render(<ClosedPageRoute />);
    fireEvent.click(await screen.findByRole("button", { name: "Show older" }));
    const second = await screen.findByText("Second");
    expect(urls[1]).toContain("before=");
    await waitFor(() => expect(document.activeElement).toBe(second.closest("li")));
    expect(within(second.closest("ul")!).getAllByRole("listitem")).toHaveLength(2);
  });
});
