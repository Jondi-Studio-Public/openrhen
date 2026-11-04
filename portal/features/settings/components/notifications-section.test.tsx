// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/test/render";
import { createSeedState } from "@/state/portal-state";
import { NotificationsSection } from "@/features/settings/components/notifications-section";

const seed = createSeedState(new Date("2026-08-18T10:00:00.000Z"));
const context = { state: seed as typeof seed, ready: true, saving: false, saveEntityCommand: vi.fn() };
vi.mock("@/state/portal-provider", () => ({ usePortal: () => context }));

const unsubscribe = vi.fn(() => Promise.resolve(true));
const device = {
  id: "dev-1",
  label: "iPhone",
  createdAt: "2026-08-10T10:00:00.000Z",
  lastSuccessAt: null,
  lastFailureAt: null
};

function json(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  );
}

function stubPush(deleteStatus: number) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") return json({ error: "server broke" }, deleteStatus);
    return json({ available: true, subscriptions: [device] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.stubGlobal("PushManager", class {});
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
  });
  vi.stubGlobal("Notification", { permission: "granted" });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      getRegistration: () =>
        Promise.resolve({
          pushManager: {
            getSubscription: () => Promise.resolve({ endpoint: "https://push.example/1", unsubscribe })
          }
        })
    }
  });
});

afterEach(() => {
  context.ready = true;
  context.state = seed;
  context.saveEntityCommand.mockReset();
  unsubscribe.mockClear();
  vi.unstubAllGlobals();
});

describe("NotificationsSection failure handling", () => {
  it("keeps the device and shows an alert when removing it fails", async () => {
    stubPush(500);
    render(<NotificationsSection />);
    await act(async () => {});
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not be removed/i);
    expect(screen.getByText("iPhone")).toBeTruthy();
  });

  it("does not unsubscribe locally and shows an alert when Turn off fails on the server", async () => {
    stubPush(500);
    render(<NotificationsSection />);
    await act(async () => {});
    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not be removed/i);
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it("rejects an emptied lead-time field instead of saving 0", async () => {
    stubPush(200);
    render(<NotificationsSection />);
    await act(async () => {});
    const input = screen.getByLabelText(/Remind me before leaving/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => {});
    expect(context.saveEntityCommand).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/whole number of minutes/i);
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("shows the error and not Saved when saving the lead time rejects", async () => {
    stubPush(200);
    context.saveEntityCommand.mockRejectedValue(new Error("Version conflict"));
    render(<NotificationsSection />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toContain("Version conflict");
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("shows the stored lead time once the state loads, and rejects 61 with the alert", async () => {
    stubPush(200);
    const loaded = { ...seed.settings, leaveByLeadMinutes: 25 };
    const loading = { ...seed.settings, leaveByLeadMinutes: 10 };
    context.ready = false;
    context.state = { ...seed, settings: loading };
    const view = render(<NotificationsSection />);
    await act(async () => {});
    context.ready = true;
    context.state = { ...seed, settings: loaded };
    view.rerender(<NotificationsSection />);
    await act(async () => {});
    const input = screen.getByLabelText(/Remind me before leaving/) as HTMLInputElement;
    expect(input.value).toBe("25");
    fireEvent.change(input, { target: { value: "61" } });
    fireEvent.submit(input.closest("form")!);
    await act(async () => {});
    expect(context.saveEntityCommand).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/whole number of minutes/i);
  });
});
