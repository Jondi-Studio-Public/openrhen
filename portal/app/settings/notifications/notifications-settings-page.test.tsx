// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/test/render";
import { createSeedState } from "@/state/portal-state";

const waitFor = vi.waitFor;

const seed = createSeedState(new Date("2026-08-18T10:00:00.000Z"));
const context = { state: seed, ready: true, saving: false, saveEntityCommand: vi.fn() };
vi.mock("@/state/portal-provider", () => ({ usePortal: () => context }));

/**
 * A fake `PushSubscription`: just enough of the real shape (`endpoint`, `toJSON`, `unsubscribe`) for
 * the section's own calls, never a real one -- no real device, browser push service or network call
 * is involved anywhere in this file (the leave by push design note's own testing rule).
 */
function fakeSubscription(endpoint = "https://push.example/abc") {
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: "p256dh-value", auth: "auth-value" } }),
    unsubscribe: vi.fn().mockResolvedValue(true)
  };
}

function mockServiceWorker(options: { subscription?: ReturnType<typeof fakeSubscription> | null } = {}) {
  const pushManager = {
    getSubscription: vi.fn().mockResolvedValue(options.subscription ?? null),
    subscribe: vi.fn().mockResolvedValue(fakeSubscription())
  };
  const registration = { pushManager };
  const serviceWorker = {
    getRegistration: vi.fn().mockResolvedValue(registration),
    register: vi.fn().mockResolvedValue(registration),
    ready: Promise.resolve(registration)
  };
  Object.defineProperty(navigator, "serviceWorker", { value: serviceWorker, configurable: true });
  return { pushManager, registration, serviceWorker };
}

function mockMatchMedia(matches = false) {
  Object.defineProperty(window, "matchMedia", {
    value: vi.fn().mockReturnValue({ matches }),
    configurable: true,
    writable: true
  });
}

function mockNotification(permission: NotificationPermission = "default") {
  const requestPermission = vi.fn().mockResolvedValue("granted");
  Object.defineProperty(window, "Notification", {
    value: class {
      static permission = permission;
      static requestPermission = requestPermission;
    },
    configurable: true,
    writable: true
  });
  return { requestPermission };
}

afterEach(() => {
  context.state = seed;
  context.saveEntityCommand.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Notifications settings page", () => {
  it("shows the Home Screen install prompt on iOS outside standalone", async () => {
    Object.defineProperty(navigator, "userAgent", { value: "iPhone", configurable: true });
    mockMatchMedia(false);
    mockNotification();
    mockServiceWorker();
    const { default: NotificationsSettingsPage } = await import("./page");
    render(<NotificationsSettingsPage />);
    await waitFor(() => expect(screen.getByText(/Add OpenRhen to your Home Screen/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Turn on for this device" })).toBeNull();
  });

  it("shows not-supported when the browser has no PushManager", async () => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Windows)", configurable: true });
    mockMatchMedia(false);
    mockNotification();
    const original = (window as unknown as { PushManager?: unknown }).PushManager;
    delete (window as unknown as { PushManager?: unknown }).PushManager;
    const { default: NotificationsSettingsPage } = await import("./page");
    render(<NotificationsSettingsPage />);
    await waitFor(() => expect(screen.getByText(/does not support push/)).toBeTruthy());
    (window as unknown as { PushManager?: unknown }).PushManager = original;
  });

  it("shows blocked when permission was denied", async () => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Windows)", configurable: true });
    mockMatchMedia(false);
    mockNotification("denied");
    (window as unknown as { PushManager?: unknown }).PushManager = class {};
    mockServiceWorker();
    const { default: NotificationsSettingsPage } = await import("./page");
    render(<NotificationsSettingsPage />);
    await waitFor(() => expect(screen.getByText(/blocked in this browser/)).toBeTruthy());
  });

  it("turns on: registers the service worker, subscribes, and posts the subscription", async () => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Windows)", configurable: true });
    mockMatchMedia(false);
    mockNotification();
    (window as unknown as { PushManager?: unknown }).PushManager = class {};
    const { registration, serviceWorker } = mockServiceWorker({ subscription: null });
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/push/subscriptions")
        return Promise.resolve({ ok: true, json: async () => ({ available: true, subscriptions: [] }) });
      if (url === "/api/push/config")
        return Promise.resolve({ ok: true, json: async () => ({ available: true, publicKey: "AAAA" }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { default: NotificationsSettingsPage } = await import("./page");
    render(<NotificationsSettingsPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Turn on for this device" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Turn on for this device" }));
    await waitFor(() => expect(serviceWorker.register).toHaveBeenCalledWith("/push-sw.js"));
    await waitFor(() => expect(registration.pushManager.subscribe).toHaveBeenCalled());
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/push/subscriptions", expect.objectContaining({ method: "POST" }))
    );
  });

  it("shows the portal's message when the device cap refuses a new device", async () => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Windows)", configurable: true });
    mockMatchMedia(false);
    mockNotification();
    (window as unknown as { PushManager?: unknown }).PushManager = class {};
    mockServiceWorker({ subscription: null });
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/push/config")
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ available: true, publicKey: "AAAA" }) });
      if (url === "/api/push/subscriptions" && init?.method === "POST")
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({ error: "This portal already has 5 notification devices. Remove one first." })
        });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ available: true, subscriptions: [] }) });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { default: NotificationsSettingsPage } = await import("./page");
    render(<NotificationsSettingsPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Turn on for this device" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Turn on for this device" }));
    await waitFor(() => expect(screen.getByText(/already has 5 notification devices/)).toBeTruthy());
  });

  it("shows when each device was added, so a look-alike row can be told apart", async () => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Windows)", configurable: true });
    mockMatchMedia(false);
    mockNotification("granted");
    (window as unknown as { PushManager?: unknown }).PushManager = class {};
    mockServiceWorker({ subscription: fakeSubscription() });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          available: true,
          subscriptions: [
            {
              id: "a",
              label: "iPhone",
              createdAt: "2026-09-01T02:00:00.000Z",
              lastSuccessAt: null,
              lastFailureAt: null
            },
            {
              id: "b",
              label: "iPhone",
              createdAt: "2026-10-17T21:30:00.000Z",
              lastSuccessAt: null,
              lastFailureAt: null
            }
          ]
        })
      })
    );

    const { default: NotificationsSettingsPage } = await import("./page");
    render(<NotificationsSettingsPage />);
    await waitFor(() => expect(screen.getAllByText(/^Added /)).toHaveLength(2));
    const [first, second] = screen.getAllByText(/^Added /);
    expect(first!.textContent).not.toBe(second!.textContent);
  });

  it("turns off: unsubscribes and deletes the subscription", async () => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Windows)", configurable: true });
    mockMatchMedia(false);
    mockNotification("granted");
    (window as unknown as { PushManager?: unknown }).PushManager = class {};
    const subscription = fakeSubscription();
    mockServiceWorker({ subscription });
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/push/subscriptions")
        return Promise.resolve({
          ok: true,
          json: async () => ({ available: true, subscriptions: [{ id: "sub-1", label: "iPhone" }] })
        });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { default: NotificationsSettingsPage } = await import("./page");
    render(<NotificationsSettingsPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Turn off" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(subscription.unsubscribe).toHaveBeenCalled());
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/push/subscriptions", expect.objectContaining({ method: "DELETE" }))
    );
  });

  it("saves the leave-by lead minutes through the settings command", async () => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Windows)", configurable: true });
    mockMatchMedia(false);
    mockNotification();
    (window as unknown as { PushManager?: unknown }).PushManager = class {};
    mockServiceWorker();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ available: true, subscriptions: [] }) })
    );
    context.saveEntityCommand.mockResolvedValue(undefined);

    const { default: NotificationsSettingsPage } = await import("./page");
    render(<NotificationsSettingsPage />);
    fireEvent.change(screen.getByLabelText("Remind me before leaving (minutes)"), { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => {});
    expect(context.saveEntityCommand).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "settings", entity: { leaveByLeadMinutes: 15 } })
    );
  });
});
