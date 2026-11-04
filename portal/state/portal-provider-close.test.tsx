// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import type { CloseEntityCommand } from "@openrhen/contracts";
import "@/test/render";
import { CommandRefusal } from "@/shared/command-refusal";
import {
  ancestorRefusalReply,
  childrenRefusalReply,
  closeReply,
  conflictReply,
  jsonResponse,
  parseCloseBody,
  resultFor
} from "@/test/close-fixtures";
import { createSeedState } from "./portal-state";
import { PortalProvider, usePortal } from "./portal-provider";

/**
 * `closeEntityCommand` is the close and restore buttons' only way to the server. The stand-in server parses every posted
 * body with `closeEntityCommandSchema` and answers with the real helpers' bodies (test/close-fixtures.ts).
 */
/** Every banner text the page showed, since the provider's own plan refresh clears it again soon after a refusal. */
const banners = new Set<string>();

function mount() {
  let latest!: ReturnType<typeof usePortal>;
  banners.clear();
  function Probe() {
    latest = usePortal();
    banners.add(latest.bannerText);
    return null;
  }
  render(
    <PortalProvider>
      <Probe />
    </PortalProvider>
  );
  return () => latest;
}

/**
 * The stand-in server: `/api/commands/close` goes to `onClose` with the body already parsed by the route's schema;
 * every other request (the state read, the plan refresh the provider asks for after a command) gets a harmless reply.
 */
function server(onClose: (command: CloseEntityCommand) => Response) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) =>
    // The state read answers no state, as an empty database does, so the provider's own freshness check (a
    // recalculation after a state refetch) does not run and clear the banner this suite is looking at.
    Promise.resolve(
      url === "/api/commands/close"
        ? onClose(parseCloseBody(init))
        : jsonResponse({ state: init?.method === "POST" ? createSeedState() : null })
    )
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const close = { type: "project", id: "p1", verb: "cancel", do: "close", expectedVersion: 4 } as const;

describe("PortalProvider closeEntityCommand", () => {
  it("posts a body the close route accepts and resolves with the result, not the whole response", async () => {
    const posted: unknown[] = [];
    server((command) => {
      posted.push(command);
      return closeReply(createSeedState(), resultFor(command, { version: 4 }));
    });
    const portal = mount();
    let result!: Awaited<ReturnType<ReturnType<typeof portal>["closeEntityCommand"]>>;
    await act(async () => {
      result = await portal().closeEntityCommand({ ...close, commandId: crypto.randomUUID() });
    });
    expect(posted).toHaveLength(1);
    expect(result).toMatchObject({ type: "project", do: "close", status: "cancelled", version: 5 });
    expect(result.restore).toMatchObject({ tool: "rhen_cancel", arguments: { do: "restore", "expected-version": 5 } });
    expect([...banners].filter(Boolean)).toEqual([]);
  });

  it("rejects a refusal as a CommandRefusal that keeps the server's sentence, status and next call", async () => {
    server((command) => childrenRefusalReply(command, 3, ["Tax return"]));
    const portal = mount();
    let caught: unknown;
    await act(async () => {
      caught = await portal()
        .closeEntityCommand({ ...close, type: "outcome", id: "o1" })
        .catch((error: unknown) => error);
    });
    expect(caught).toBeInstanceOf(CommandRefusal);
    const refusal = caught as CommandRefusal;
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal.status).toBe(400);
    expect(refusal.message).toMatch(/still has 3 open items under it, with deadlines: "Tax return"/);
    expect(refusal.nextCall).toMatchObject({ tool: "rhen_cancel", arguments: { "include-children": true } });
    // the unhandled refusal is the red banner, as for every other command
    expect(banners.has(refusal.message)).toBe(true);
  });

  it("does not light the global banner for a refusal the caller says it handles", async () => {
    server((command) => childrenRefusalReply(command, 2));
    const portal = mount();
    await act(async () => {
      await portal()
        .closeEntityCommand(
          { ...close, type: "outcome", id: "o1" },
          { handles: (refusal) => refusal.nextCall?.arguments["include-children"] === true }
        )
        .catch(() => undefined);
    });
    expect([...banners].filter(Boolean)).toEqual([]);
  });

  it("carries the current version of a stale close and still refetches the state", async () => {
    const fetchMock = server((command) => conflictReply(command, 9));
    const portal = mount();
    let caught: unknown;
    await act(async () => {
      caught = await portal()
        .closeEntityCommand({ ...close, type: "action", id: "a1" })
        .catch((error: unknown) => error);
    });
    expect(caught).toMatchObject({ status: 409, currentVersion: 9 });
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/state").length).toBeGreaterThan(0);
  });

  it("carries a restore refusal's next call (the closed ancestor)", async () => {
    server((command) => ancestorRefusalReply(command, { type: "project", id: "p9", status: "cancelled", version: 3 }));
    const portal = mount();
    let caught: unknown;
    await act(async () => {
      caught = await portal()
        .closeEntityCommand({ type: "action", id: "a1", verb: "cancel", do: "restore", expectedVersion: 2 })
        .catch((error: unknown) => error);
    });
    expect((caught as CommandRefusal).nextCall).toMatchObject({
      tool: "rhen_cancel",
      arguments: { type: "project", id: "p9", do: "restore" }
    });
  });

  it("keeps the plain unreachable-server message when the network fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        init?.method === "POST" ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve(jsonResponse({ state: null }))
      )
    );
    const portal = mount();
    let caught: unknown;
    await act(async () => {
      caught = await portal()
        .closeEntityCommand(close)
        .catch((error: unknown) => error);
    });
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(CommandRefusal);
  });
});
