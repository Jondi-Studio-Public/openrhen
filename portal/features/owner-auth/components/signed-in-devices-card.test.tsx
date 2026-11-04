// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { fireEvent, render, screen } from "@/test/render";
import { SignedInDevicesCard } from "./signed-in-devices-card";

afterEach(() => vi.unstubAllGlobals());

const credential = (extra: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  kind: "browser",
  label: "This browser",
  createdAt: "2026-10-19T00:00:00.000Z",
  lastUsedAt: "2026-10-19T09:00:00.000Z",
  expiresAt: "2026-11-18T00:00:00.000Z",
  revokedAt: null,
  current: true,
  ...extra
});

function portal(session: Record<string, unknown>, list: unknown[] = []) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
    url === "/api/owner/session"
      ? Response.json(session)
      : url === "/api/owner/credentials"
        ? Response.json({ credentials: list })
        : Response.json({ ok: true })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("SignedInDevicesCard", () => {
  it("has no enrol button, whatever the mode or sign-in state", async () => {
    for (const [mode, name] of [
      ["off", "off"],
      ["require", "required"]
    ] as const) {
      portal({ mode, signedIn: false, via: null, canManage: false });
      const { unmount } = render(<SignedInDevicesCard />);
      expect(await screen.findByText(name)).toBeTruthy();
      expect(screen.queryByText(/Enrol|Enroll/)).toBeNull();
      expect(screen.queryByLabelText(/token/i)).toBeNull();
      unmount();
    }
  });

  it("describes each mode in plain words, with no environment variable", async () => {
    for (const mode of ["off", "shadow", "require"]) {
      portal({ mode, signedIn: false, via: null, canManage: false });
      const { unmount } = render(<SignedInDevicesCard />);
      await screen.findByText(/Owner sign-in is/);
      await waitFor(() => expect(document.body.textContent).toMatch(/Every read|treated as you|still work as you/));
      expect(document.body.textContent).not.toContain("OPENRHEN_OWNER_AUTH");
      if (mode === "off")
        expect(
          screen.getByText(/Sign-in is off on this server, so anything without a token is treated as you\./)
        ).toBeTruthy();
      unmount();
    }
  });

  it("does not list credentials to a caller who cannot manage them", async () => {
    const fetchMock = portal({ mode: "require", signedIn: false, via: null, canManage: false });
    render(<SignedInDevicesCard />);
    await screen.findByText(/Owner sign-in is/);
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/owner/credentials")).toBe(false);
  });

  it("shows the signed-in browsers and tokens, signs out, and revokes", async () => {
    const other = credential({
      id: "22222222-2222-4222-8222-222222222222",
      kind: "token",
      label: "laptop",
      current: false,
      expiresAt: null
    });
    const fetchMock = portal({ mode: "require", signedIn: true, via: "cookie", canManage: true }, [
      credential(),
      other
    ]);
    render(<SignedInDevicesCard />);
    expect(await screen.findByText("laptop")).toBeTruthy();
    expect(screen.getByText(/This browser is signed in\./)).toBeTruthy();
    expect(screen.queryByText(/signed in as This browser/)).toBeNull();
    expect(screen.getAllByText(/Last used 19 Oct 2026/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByLabelText("Revoke laptop"));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.find(([url]) => url === "/api/owner/credentials/22222222-2222-4222-8222-222222222222")?.[1]
          ?.method
      ).toBe("DELETE")
    );
    fireEvent.click(screen.getByText("Sign out"));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/api/owner/signout")).toBe(true));
  });
});
