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

function portal(session: Record<string, unknown>, list: unknown[] = [], events: unknown[] = []) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
    url === "/api/owner/session"
      ? Response.json(session)
      : url === "/api/owner/credentials"
        ? Response.json({ credentials: list })
        : url === "/api/owner/credential-events"
          ? Response.json({ events })
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

  it("adds a phone: shows a QR with the host under it, from the pairing the server made", async () => {
    const fetchMock = portal({ mode: "require", signedIn: true, via: "cookie", canManage: true }, [credential()]);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/owner/devices/pairings" && init?.method === "POST")
        return Response.json(
          {
            payload: JSON.stringify({ v: 1, origin: "https://portal.example.com", secret: "pri_pair_x" }),
            host: "portal.example.com",
            expiresAt: "2026-11-10T09:10:00.000Z"
          },
          { status: 201 }
        );
      if (url === "/api/owner/session")
        return Response.json({ mode: "require", signedIn: true, via: "cookie", canManage: true });
      if (url === "/api/owner/credentials") return Response.json({ credentials: [credential()] });
      return Response.json({ events: [] });
    });
    render(<SignedInDevicesCard />);
    fireEvent.click(await screen.findByText("Add a phone"));
    expect(await screen.findByText("portal.example.com")).toBeTruthy();
    const qr = await screen.findByRole("img", { name: "QR code to add a phone" });
    expect(qr.innerHTML).toContain("<svg");
    expect(screen.getByText(/It works once/)).toBeTruthy();
  });

  it("asks for the https address when the server has no public address, and does not show a QR without one", async () => {
    let asked = 0;
    const fetchMock = portal({ mode: "require", signedIn: true, via: "cookie", canManage: true }, [credential()]);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/owner/devices/pairings" && init?.method === "POST") {
        asked += 1;
        return Response.json(
          { error: "Type the https address your phone will use to reach this portal.", needsOrigin: true },
          { status: 422 }
        );
      }
      if (url === "/api/owner/session")
        return Response.json({ mode: "require", signedIn: true, via: "cookie", canManage: true });
      if (url === "/api/owner/credentials") return Response.json({ credentials: [credential()] });
      return Response.json({ events: [] });
    });
    render(<SignedInDevicesCard />);
    fireEvent.click(await screen.findByText("Add a phone"));
    expect(await screen.findByPlaceholderText("https://portal.example.com")).toBeTruthy();
    expect(screen.getByText(/Type the https address/)).toBeTruthy();
    expect(screen.queryByRole("img", { name: "QR code to add a phone" })).toBeNull();
    expect(asked).toBe(1);
  });

  it("offers Enter a code, and neither button to a limited device", async () => {
    portal({ mode: "require", signedIn: true, via: "header", canManage: true }, [credential()]);
    const { unmount } = render(<SignedInDevicesCard />);
    expect(await screen.findByText("Enter a code")).toBeTruthy();
    expect(screen.getByText("Enter a code").closest("a")?.getAttribute("href")).toBe("/settings/advanced/approve");
    unmount();
    portal({ mode: "require", signedIn: true, via: "header", canManage: true, limited: true }, [credential()]);
    render(<SignedInDevicesCard />);
    await screen.findByText(/Owner sign-in is/);
    await waitFor(() => expect(screen.queryByText("Add a phone")).toBeNull());
    expect(screen.queryByText("Enter a code")).toBeNull();
  });

  it("lists a phone as its platform, hides its web view, and shows the record of pairings", async () => {
    const phone = credential({
      id: "33333333-3333-4333-8333-333333333333",
      kind: "token",
      label: "Phone",
      current: false,
      expiresAt: null,
      limited: true,
      lastUsedFrom: "203.0.113.5",
      device: { installId: "c0ffee00-1234-4abc-8def-0123456789ab", platform: "ios" }
    });
    const view = credential({
      id: "44444444-4444-4444-8444-444444444444",
      label: "Phone (web view)",
      current: false,
      parentCredentialId: phone.id
    });
    portal(
      { mode: "require", signedIn: true, via: "cookie", canManage: true },
      [credential(), phone, view],
      [
        {
          id: "55555555-5555-4555-8555-555555555555",
          occurredAt: "2026-11-10T09:00:00.000Z",
          event: "redeemed",
          label: "Phone",
          device: null,
          address: "203.0.113.5"
        }
      ]
    );
    render(<SignedInDevicesCard />);
    expect(await screen.findByText("ios")).toBeTruthy();
    expect(screen.getByText(/limited/)).toBeTruthy();
    expect(screen.getByText(/from 203\.0\.113\.5 ·/)).toBeTruthy();
    expect(screen.queryByText("Phone (web view)")).toBeNull();
    expect(await screen.findByText("Recent activity")).toBeTruthy();
    expect(screen.getByText("Phone · signed in")).toBeTruthy();
  });

  it("says plainly that a phone's limit protects nothing while sign-in is not required", async () => {
    portal({ mode: "off", signedIn: false, via: null, canManage: true }, []);
    render(<SignedInDevicesCard />);
    expect(await screen.findByText(/doesn.t require sign-in/)).toBeTruthy();
    expect(screen.getByText(/protects nothing until sign-in is required/)).toBeTruthy();
  });
});
