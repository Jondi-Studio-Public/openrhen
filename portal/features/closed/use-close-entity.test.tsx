// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import "@/test/render";
import { closeReply, childrenRefusalReply, conflictReply, jsonResponse, resultFor } from "@/test/close-fixtures";
import { stubCloseServer } from "@/test/close-server";
import { createSeedState } from "@/state/portal-state";
import { PortalProvider } from "@/state/portal-provider";
import { closeToasts } from "./close-toast-store";
import { useCloseEntity } from "./use-close-entity";

/**
 * The hook behind every Archive, Cancel and Restore button. The stand-in server parses each posted body with
 * `closeEntityCommandSchema` and answers with the real helpers' bodies, so a body the route would refuse fails here.
 */
let hook!: ReturnType<typeof useCloseEntity>;
function Harness() {
  hook = useCloseEntity();
  return null;
}
const mount = () =>
  render(
    <PortalProvider>
      <Harness />
    </PortalProvider>
  );

const project = { type: "project", id: "p1", title: "Quarterly report", version: 4 } as const;
const outcome = { type: "outcome", id: "o1", title: "Garden", version: 3 } as const;

beforeEach(() => closeToasts.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("close", () => {
  it("closes with the row's version, shows the toast, and the Undo it carries restores at the version the close left", async () => {
    const { posts } = stubCloseServer((command) => closeReply(createSeedState(), resultFor(command, { version: 4 })));
    mount();
    let outcomeResult!: Awaited<ReturnType<typeof hook.close>>;
    await act(async () => {
      outcomeResult = await hook.close(project, "archive");
    });
    expect(outcomeResult.ok).toBe(true);
    expect(posts[0]).toMatchObject({ type: "project", id: "p1", verb: "archive", do: "close", expectedVersion: 4 });
    expect(posts[0]).not.toHaveProperty("reason");
    const toast = closeToasts.get();
    expect(toast).toMatchObject({ kind: "closed", title: "Quarterly report" });
    if (toast?.kind !== "closed") throw new Error("expected a close toast");
    expect(toast.closed.version).toBe(5);
    expect(hook.busy).toBe(false);
  });

  it("asks before closing a parent that has open children, then resends with includeChildren and the same command id", async () => {
    const { posts } = stubCloseServer((command) =>
      command.includeChildren
        ? closeReply(
            createSeedState(),
            resultFor(command, { version: 3, cascaded: [{ type: "project", id: "p9", from: "active", version: 2 }] })
          )
        : childrenRefusalReply(command, 1, ["Tax return"])
    );
    mount();
    await act(async () => {
      const first = await hook.close(outcome, "cancel");
      expect(first).toEqual({ ok: false, needsConfirm: true });
    });
    expect(closeToasts.get()).toBeNull();
    expect(hook.pending?.message).toMatch(/still has 1 open item under it, with deadlines: "Tax return"/);
    await act(async () => {
      await hook.confirmChildren();
    });
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({ includeChildren: true, expectedVersion: 3 });
    expect(posts[1]!.commandId).toBe(posts[0]!.commandId);
    expect(hook.pending).toBeNull();
    expect(closeToasts.get()).toMatchObject({ kind: "closed" });
  });

  it("keeps everything open when the child question is declined", async () => {
    const { posts } = stubCloseServer((command) => childrenRefusalReply(command, 2));
    mount();
    await act(async () => {
      await hook.close(outcome, "cancel");
    });
    act(() => hook.dismissChildren());
    expect(hook.pending).toBeNull();
    expect(posts).toHaveLength(1);
  });

  it("says what happened on a stale version and leaves the button usable", async () => {
    stubCloseServer((command) => conflictReply(command, 8));
    mount();
    let result!: Awaited<ReturnType<typeof hook.close>>;
    await act(async () => {
      result = await hook.close(project, "archive");
    });
    expect(result).toEqual({
      ok: false,
      message: "Changed since you opened it, so nothing was closed. The page is up to date; try again."
    });
    expect(hook.error).toBe(result.ok === false && "message" in result ? result.message : "");
    expect(hook.busy).toBe(false);
  });

  it("ignores a second click while the first is in flight", async () => {
    let release!: (response: Response) => void;
    const { posts } = stubCloseServer(
      () => new Promise<Response>((resolve) => (release = resolve))
    );
    mount();
    let first!: Promise<unknown>;
    await act(async () => {
      first = hook.close(project, "archive");
      await Promise.resolve();
    });
    expect(hook.busy).toBe(true);
    await act(async () => {
      expect(await hook.close(project, "archive")).toEqual({ ok: false, busy: true });
    });
    expect(posts).toHaveLength(1);
    await act(async () => {
      release(closeReply(createSeedState(), resultFor(posts[0]!, { version: 4 })));
      await first;
    });
    expect(hook.busy).toBe(false);
  });

  it("retries a close whose answer was lost with the same command id", async () => {
    let calls = 0;
    const { posts } = stubCloseServer((command) => {
      calls += 1;
      if (calls === 1) throw new TypeError("Failed to fetch");
      return closeReply(createSeedState(), resultFor(command, { version: 4 }));
    });
    mount();
    await act(async () => {
      const lost = await hook.close(project, "archive");
      expect(lost.ok).toBe(false);
      expect("message" in lost && lost.message).toMatch(/could not be reached|Failed to fetch/);
    });
    await act(async () => {
      expect((await hook.close(project, "archive")).ok).toBe(true);
    });
    expect(posts).toHaveLength(2);
    expect(posts[1]!.commandId).toBe(posts[0]!.commandId);
  });

  it("replaces the toast of the previous close", async () => {
    stubCloseServer((command) => closeReply(createSeedState(), resultFor(command, { version: 4 })));
    mount();
    await act(async () => {
      await hook.close(project, "archive");
      await hook.close({ ...project, id: "p2", title: "Second" }, "archive");
    });
    expect(closeToasts.get()).toMatchObject({ kind: "closed", title: "Second" });
  });
});

describe("restore", () => {
  const row = { type: "action", id: "a1", restoreVerb: "cancel", version: 6, title: "Draft" } as const;

  it("restores using only the row's own fields and shows where it landed", async () => {
    const { posts } = stubCloseServer((command) =>
      closeReply(createSeedState(), resultFor(command, { version: 6, closedFrom: "planned" }))
    );
    mount();
    await act(async () => {
      expect((await hook.restore(row)).ok).toBe(true);
    });
    expect(posts[0]).toMatchObject({ type: "action", id: "a1", verb: "cancel", do: "restore", expectedVersion: 6 });
    expect(closeToasts.get()).toMatchObject({ kind: "notice", text: "Restored Draft as planned." });
  });

  it("asks for the rows closed with it only when told to", async () => {
    const { posts } = stubCloseServer((command) =>
      closeReply(createSeedState(), resultFor(command, { version: 6, closedFrom: "active" }))
    );
    mount();
    await act(async () => {
      await hook.restore({ ...row, type: "outcome", id: "o1" }, { includeChildren: true });
    });
    expect(posts[0]).toMatchObject({ includeChildren: true });
  });

  it("reports a stale restore as such, with the status so the page can refetch", async () => {
    stubCloseServer((command) => conflictReply(command, 9));
    mount();
    await act(async () => {
      expect(await hook.restore(row)).toEqual({
        ok: false,
        status: 409,
        message: "Changed since the list was loaded; it has been refreshed."
      });
    });
  });

  it("passes the server's sentence for a closed parent through", async () => {
    stubCloseServer(() =>
      jsonResponse(
        { error: 'Action "a1" cannot be restored while project "p9" above it is cancelled. Restore that first.' },
        400
      )
    );
    mount();
    await act(async () => {
      const result = await hook.restore(row);
      expect(result).toMatchObject({ ok: false, status: 400 });
      expect("message" in result && result.message).toMatch(/Restore that first\.$/);
    });
  });
});
