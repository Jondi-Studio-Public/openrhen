// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { fireEvent, render, screen } from "@/test/render";
import { allDirectWritesOn } from "@openrhen/contracts";
import { AgentTokensCard, tokenState } from "./agent-tokens-card";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const session = (mode: string) => Response.json({ mode, signedIn: true, via: "cookie", canManage: true });
/** Answers the card's two reads: the session mode and the token list. */
const read =
  (tokens: unknown[], mode = "off") =>
  async (url: string) =>
    url === "/api/owner/session" ? session(mode) : Response.json({ tokens });

const token = (extra: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: "companion",
  scopes: ["read:plan", "propose:capture"],
  directWrites: {},
  expiresAt: "2999-01-01T00:00:00.000Z",
  createdAt: "2026-10-18T00:00:00.000Z",
  lastUsedAt: "2026-10-18T09:00:00.000Z",
  revokedAt: null,
  ...extra
});

describe("tokenState", () => {
  it("is revoked, expired or active", () => {
    const now = new Date("2026-10-18T00:00:00Z").getTime();
    expect(tokenState(token({ revokedAt: "2026-10-01T00:00:00.000Z" }) as never, now)).toBe("revoked");
    expect(tokenState(token({ expiresAt: "2026-10-17T00:00:00.000Z" }) as never, now)).toBe("expired");
    expect(tokenState(token() as never, now)).toBe("active");
  });
});

describe("AgentTokensCard", () => {
  it("lists a token with its scopes and last use, and revokes it", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === "DELETE"
        ? Response.json({ agentToken: token({ revokedAt: "2026-10-18T10:00:00.000Z" }) })
        : read([token()])(url)
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentTokensCard />);
    expect(await screen.findByText("companion")).toBeTruthy();
    expect(
      await screen.findByText(/Sign-in is off on this server, so tokens do not bind a hostile or buggy agent/)
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("OPENRHEN_OWNER_AUTH");
    expect(screen.getByText("read:plan, propose:capture")).toBeTruthy();
    expect(screen.getByText(/Last used 2026-10-18/)).toBeTruthy();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Revoke companion" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/agent-tokens/11111111-1111-4111-8111-111111111111",
        expect.objectContaining({ method: "DELETE" })
      )
    );
  });

  it("asks before revoking and sends nothing when the answer is no", async () => {
    const fetchMock = vi.fn(read([token()]));
    vi.stubGlobal("fetch", fetchMock);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<AgentTokensCard />);
    await screen.findByText("companion");
    fireEvent.click(screen.getByRole("button", { name: "Revoke companion" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("companion"));
    expect(
      fetchMock.mock.calls.some((call) => ((call as unknown[])[1] as RequestInit | undefined)?.method === "DELETE")
    ).toBe(false);
  });

  it("leaves out the tokens-do-not-bind line when sign-in is required, and says so when it is only logged", async () => {
    vi.stubGlobal("fetch", vi.fn(read([token()], "require")));
    const { unmount } = render(<AgentTokensCard />);
    await screen.findByText("companion");
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/owner/session")).toBe(true));
    expect(screen.queryByText(/do not bind a hostile or buggy agent/)).toBeNull();
    unmount();
    vi.stubGlobal("fetch", vi.fn(read([token()], "shadow")));
    render(<AgentTokensCard />);
    expect(await screen.findByText(/Sign-in is not enforced on this server, so tokens do not bind/)).toBeTruthy();
  });

  it("shows the switch off for a token with no direct writes, and turns every class on with one PATCH", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === "PATCH"
        ? Response.json({ agentToken: token({ directWrites: allDirectWritesOn() }) })
        : read([token()])(url)
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentTokensCard />);
    const toggle = (await screen.findByRole("switch", {
      name: "Writes apply directly for companion"
    })) as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(patch[0]).toBe("/api/agent-tokens/11111111-1111-4111-8111-111111111111");
    expect(JSON.parse(String(patch[1]?.body))).toEqual({ directWrites: allDirectWritesOn() });
  });

  it("shows the switch on only when every class is on, and clears the map when it is turned off", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === "PATCH"
        ? Response.json({ agentToken: token() })
        : read([token({ directWrites: allDirectWritesOn() })])(url)
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentTokensCard />);
    const toggle = (await screen.findByRole("switch", {
      name: "Writes apply directly for companion"
    })) as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(JSON.parse(String(patch[1]?.body))).toEqual({ directWrites: {} });
  });

  it("shows a partial map as off, and offers no switch on a revoked token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        read([
          token({ directWrites: { action: "on" } }),
          token({ id: "22222222-2222-4222-8222-222222222222", name: "old", revokedAt: "2026-10-01T00:00:00.000Z" })
        ])
      )
    );
    render(<AgentTokensCard />);
    const toggle = (await screen.findByRole("switch", {
      name: "Writes apply directly for companion"
    })) as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("switch", { name: /for old/ })).toBeNull();
  });

  it("says so when a switch change fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) =>
        init?.method === "PATCH" ? new Response("no", { status: 500 }) : read([token()])(url)
      )
    );
    render(<AgentTokensCard />);
    fireEvent.click(await screen.findByRole("switch", { name: "Writes apply directly for companion" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not change companion");
  });

  it("says so when there are none, and when the list cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(read([])));
    const { unmount } = render(<AgentTokensCard />);
    expect(await screen.findByText("No agent tokens yet.")).toBeTruthy();
    unmount();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 503 }))
    );
    render(<AgentTokensCard />);
    expect((await screen.findByRole("alert")).textContent).toContain("could not be read");
  });
});
