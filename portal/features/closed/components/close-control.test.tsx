// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/test/render";
import type { CloseType } from "@openrhen/contracts";
import { ancestorRefusalReply, childrenRefusalReply, closeReply, conflictReply, resultFor } from "@/test/close-fixtures";
import { stubCloseServer } from "@/test/close-server";
import { createSeedState, type PortalState } from "@/state/portal-state";
import { PortalProvider } from "@/state/portal-provider";
import { closeToasts } from "../close-toast-store";
import { CloseControl } from "./close-control";
import { CloseToastRegion } from "./close-toast";

/**
 * The one Archive / Cancel / Restore control every editor carries. Real provider, stand-in server: each posted body
 * must parse with the close route's schema, and replies are built from the real helpers.
 */
function stateWith(rows: Partial<PortalState>): PortalState {
  return { ...createSeedState(), ...rows } as PortalState;
}
const row = (extra: object) => ({ id: "r1", version: 4, ...extra });

async function mount(type: CloseType, state: PortalState, props: { id?: string; dirty?: boolean; onDone?: () => void } = {}) {
  render(
    <PortalProvider>
      <CloseControl type={type} id={props.id ?? "r1"} dirty={props.dirty ?? false} onDone={props.onDone} />
      <CloseToastRegion />
    </PortalProvider>
  );
  await screen.findByRole("status", { name: "Archive and cancel results" });
  return state;
}

beforeEach(() => closeToasts.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ok = (command: Parameters<typeof resultFor>[0]) => closeReply(createSeedState(), resultFor(command, { version: 4 }));

describe("which button each row gets", () => {
  const cases: [CloseType, Partial<PortalState>, string][] = [
    ["action", { actions: [row({ title: "Draft", status: "planned" })] as never }, "Cancel action"],
    ["action", { actions: [row({ title: "Draft", status: "done" })] as never }, "Archive action"],
    ["deliverable", { deliverables: [row({ title: "Report", status: "ready" })] as never }, "Cancel deliverable"],
    ["deliverable", { deliverables: [row({ title: "Report", status: "completed" })] as never }, "Archive deliverable"],
    ["area", { areas: [row({ name: "Finance", status: "active" })] as never }, "Archive area"],
    ["commitment", { commitments: [row({ title: "Dentist", status: "confirmed" })] as never }, "Cancel commitment"],
    ["commitment", { commitments: [row({ title: "Dentist", status: "tentative" })] as never }, "Cancel commitment"],
    ["routine_preset", { routinePresets: [row({ name: "Morning", status: "active", steps: [] })] as never }, "Archive routine"],
    ["condition_definition", { conditionDefinitions: [row({ name: "Office", status: "active" })] as never }, "Archive context"],
    // finished work can only be archived, even for the types that otherwise take either verb
    ["outcome", { outcomes: [row({ title: "Garden", status: "done" })] as never }, "Archive outcome"],
    ["project", { projects: [row({ title: "Beds", status: "done" })] as never }, "Archive project"]
  ];
  it.each(cases)("%s in this status shows %s", async (type, rows, label) => {
    stubCloseServer(ok, { state: stateWith(rows) });
    await mount(type, stateWith(rows));
    const button = await screen.findByRole("button", { name: new RegExp(`^${label}`) });
    expect(button.textContent).toBe(label);
    expect(button.getAttribute("type")).toBe("button");
    expect(screen.queryByRole("button", { name: /^Restore/ })).toBeNull();
  });

  it("gives an active outcome or project one 'Close' button that offers Archive or Cancel", async () => {
    const rows = { outcomes: [row({ title: "Garden", status: "active" })] as never };
    stubCloseServer(ok, { state: stateWith(rows) });
    await mount("outcome", stateWith(rows));
    fireEvent.click(await screen.findByRole("button", { name: /^Close outcome/ }));
    expect(screen.getByRole("button", { name: /^Archive \(finished or retired\)/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Cancel \(abandoned\)/ })).toBeTruthy();
  });

  it.each([
    ["area", "archived", "areas", "name"],
    ["action", "cancelled", "actions", "title"],
    ["commitment", "cancelled", "commitments", "title"]
  ] as const)("a closed %s (%s) shows Restore and no close button", async (type, status, key, nameKey) => {
    const rows = { [key]: [row({ [nameKey]: "Thing", status })] } as unknown as Partial<PortalState>;
    stubCloseServer(ok, { state: stateWith(rows) });
    await mount(type, stateWith(rows));
    expect(await screen.findByRole("button", { name: /^Restore/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^(Archive|Cancel|Close)/ })).toBeNull();
  });

  it("shows nothing for a row that is open in a status the close rules do not know (never a Restore on an open row)", async () => {
    const rows = { projects: [row({ title: "Odd", status: "mystery" })] as never };
    stubCloseServer(ok, { state: stateWith(rows) });
    await mount("project", stateWith(rows));
    expect(screen.queryByRole("button", { name: /^(Archive|Cancel|Close|Restore)/ })).toBeNull();
  });

  it("shows nothing for a record that is not saved yet", async () => {
    stubCloseServer(ok, { state: stateWith({}) });
    await mount("action", stateWith({}), { id: "" });
    expect(screen.queryByRole("button", { name: /^(Archive|Cancel|Close|Restore)/ })).toBeNull();
  });

  it("names the row for a screen reader and keeps the visible words in the name", async () => {
    const rows = { projects: [row({ title: "Quarterly report", status: "done" })] as never };
    stubCloseServer(ok, { state: stateWith(rows) });
    await mount("project", stateWith(rows));
    const button = await screen.findByRole("button", { name: 'Archive project "Quarterly report"' });
    expect(button.textContent).toBe("Archive project");
  });
});

describe("closing", () => {
  const actionRows = { actions: [row({ title: "Draft citations", status: "planned" })] as never };

  it("posts to the close route (not the entity route) with the stored version, shows the toast and tells the editor", async () => {
    const { posts, fetchMock } = stubCloseServer(ok, { state: stateWith(actionRows) });
    const onDone = vi.fn();
    await mount("action", stateWith(actionRows), { onDone });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /^Cancel action/ }));
    });
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(posts).toEqual([
      expect.objectContaining({ type: "action", id: "r1", verb: "cancel", do: "close", expectedVersion: 4 })
    ]);
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/commands/entity")).toBe(false);
    expect(screen.getByRole("status", { name: "Archive and cancel results" }).textContent).toContain(
      "Draft citations cancelled."
    );
  });

  it("an outcome's Archive choice posts the archive verb, its Cancel choice the cancel verb", async () => {
    const rows = { outcomes: [row({ title: "Garden", status: "active" })] as never };
    const { posts } = stubCloseServer(ok, { state: stateWith(rows) });
    await mount("outcome", stateWith(rows));
    fireEvent.click(await screen.findByRole("button", { name: /^Close outcome/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Cancel \(abandoned\)/ }));
    });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ type: "outcome", verb: "cancel" });
  });

  it("is disabled while the editor has unsaved changes, and says why", async () => {
    stubCloseServer(ok, { state: stateWith(actionRows) });
    await mount("action", stateWith(actionRows), { dirty: true });
    const button = (await screen.findByRole("button", { name: /^Cancel action/ })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText("Save or discard your changes first.")).toBeTruthy();
    expect(button.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("asks before closing a parent with open children and closes them all on Close all", async () => {
    const rows = { outcomes: [row({ title: "Garden", status: "active" })] as never };
    const { posts } = stubCloseServer(
      (command) =>
        command.includeChildren
          ? closeReply(
              createSeedState(),
              resultFor(command, { version: 4, cascaded: [{ type: "project", id: "p9", from: "active", version: 2 }] })
            )
          : childrenRefusalReply(command, 1, ["Tax return"]),
      { state: stateWith(rows) }
    );
    await mount("outcome", stateWith(rows));
    fireEvent.click(await screen.findByRole("button", { name: /^Close outcome/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Cancel \(abandoned\)/ }));
    });
    expect(await screen.findByText(/still has 1 open item under it/)).toBeTruthy();
    expect(screen.getByText(/with deadlines: "Tax return"/)).toBeTruthy();
    // declining keeps everything open
    fireEvent.click(screen.getByRole("button", { name: "Keep open" }));
    expect(screen.queryByText(/still has 1 open item/)).toBeNull();
    expect(posts).toHaveLength(1);
    // asking again, then Close all resends with includeChildren
    fireEvent.click(screen.getByRole("button", { name: /^Close outcome/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Cancel \(abandoned\)/ }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Close all" }));
    });
    await waitFor(() => expect(posts.at(-1)?.includeChildren).toBe(true));
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Archive and cancel results" }).textContent).toContain(
        "Garden cancelled and 1 under it."
      )
    );
  });

  it("shows a stale version as a plain sentence beside the button, not the server's agent-facing text", async () => {
    const { posts } = stubCloseServer((command) => conflictReply(command, 9), { state: stateWith(actionRows) });
    await mount("action", stateWith(actionRows));
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /^Cancel action/ }));
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Changed since you opened it, so nothing was closed. The page is up to date; try again.");
    expect(posts).toHaveLength(1);
    expect(((await screen.findByRole("button", { name: /^Cancel action/ })) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("restoring a closed row", () => {
  it("posts a restore with the verb its closed status takes, at the stored version", async () => {
    const rows = { projects: [row({ title: "Beds", status: "archived", version: 7 })] as never };
    const { posts } = stubCloseServer(
      (command) => closeReply(createSeedState(), resultFor(command, { version: 7, closedFrom: "active" })),
      { state: stateWith(rows) }
    );
    const onDone = vi.fn();
    await mount("project", stateWith(rows), { onDone });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: 'Restore project "Beds"' }));
    });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(posts[0]).toMatchObject({ type: "project", verb: "archive", do: "restore", expectedVersion: 7 });
    expect(screen.getByRole("status", { name: "Archive and cancel results" }).textContent).toContain(
      "Restored Beds as active."
    );
  });

  it("shows the server's sentence when a parent is closed", async () => {
    const rows = { actions: [row({ title: "Dig", status: "cancelled" })] as never };
    stubCloseServer(
      (command) => ancestorRefusalReply(command, { type: "project", id: "p9", status: "cancelled", version: 3 }),
      { state: stateWith(rows) }
    );
    await mount("action", stateWith(rows));
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /^Restore/ }));
    });
    expect((await screen.findByRole("alert")).textContent).toMatch(/cannot be restored while project "p9" above it is cancelled\. Restore that first\.$/);
  });
});
