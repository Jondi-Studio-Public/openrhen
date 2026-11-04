// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@/test/render";
import { createSeedState } from "@/state/portal-state";
import { freezeClock } from "@/shared/clock";
import ConnectionsPage from "./page";

const now = new Date("2026-08-18T10:00:00.000Z");
const state = createSeedState(now);
freezeClock(now);

const context = {
  state,
  ready: true,
  saving: false
};
// The core connections only: the seam is stubbed empty, as it is in the OpenRhen export (an extension's connections
// are pinned by its own tests).
vi.mock("@/state/private/index", () => ({}));
vi.mock("@/state/portal-provider", () => ({ usePortal: () => context }));

beforeEach(() => {
  // Reduced motion, so a closed sheet leaves the document at once instead of sliding away.
  window.matchMedia = ((query: string) =>
    ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
  window.history.replaceState(null, "", "/connections");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const answer = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

/** The row for one connection, found by its title (rows are buttons that open the details). */
async function row(title: string) {
  return screen.findByRole("button", { name: new RegExp(`^${title}`) });
}

async function openRow(title: string) {
  fireEvent.click(await row(title));
  return screen.findByRole("dialog");
}

describe("Connections page — database line", () => {
  it("shows the database line, the one page that carries it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/health/database"))
          return answer({ provider: "postgresql", connected: true, version: "PostgreSQL 16.4, x", latencyMs: 3 });
        if (url.includes("/api/connections/status")) return answer({ providers: [] });
        return new Promise(() => {});
      })
    );

    render(<ConnectionsPage />);

    expect(await screen.findByText("PostgreSQL connected")).toBeTruthy();
    expect(screen.getByText(/PostgreSQL 16\.4 · 3 ms/)).toBeTruthy();
  });
});

const providerStatus = (provider: string, overrides: Record<string, unknown> = {}) => ({
  provider,
  reachable: null,
  source: "not_configured",
  checkedAt: null,
  detail: "The outbound-proxy sidecar is not set up.",
  rateLimited: false,
  avgFirstByteMs: null,
  firstByteSampleCount: 0,
  avgTotalMs: null,
  totalSampleCount: 0,
  lastCallAt: null,
  lastCallOk: null,
  lastCallOperation: null,
  callCountsByOperation: [],
  inputTokens24h: null,
  outputTokens24h: null,
  ...overrides
});

describe("Connections page — an integration that is not set up", () => {
  function stubNothingConfigured() {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/health/engine")) return answer({ reachable: false, configured: false });
        if (url.includes("/api/connections/status"))
          return answer({
            providers: [
              ...["openai", "google_calendar"].map((provider) => providerStatus(provider)),
              providerStatus("google", { source: "skipped", detail: "No travel lookup has been made yet." })
            ]
          });
        if (url.includes("/api/connections/google_calendar/proof"))
          return answer({ status: "not_configured", missing: ["OUTBOUND_PROXY_URL", "OUTBOUND_PROXY_TOKEN"] });
        if (url.includes("/api/connections/google_calendar/calendars"))
          return answer({ calendars: [], notConfigured: true });
        return answer({ lastRun: null });
      })
    );
  }

  it("lists four rows, marks the Planner Setup and the unset optional ones Optional", async () => {
    stubNothingConfigured();
    render(<ConnectionsPage />);
    await vi.waitFor(() => expect(screen.getAllByText("Setup")).toHaveLength(1));
    for (const title of ["Planner", "Google Calendar", "OpenAI", "Google Maps"]) expect(await row(title)).toBeTruthy();
    expect(screen.getAllByText("Needs a setting on the server")).toHaveLength(1);
    expect(screen.getAllByText("Not connected (optional)")).toHaveLength(2);
    expect(screen.getAllByText("Optional")).toHaveLength(2);
    expect(screen.getByText("Planner needs a setting on the server.")).toBeTruthy();
    // Google Maps had nothing to refresh: it is fine.
    expect(within(await row("Google Maps")).getByText("On")).toBeTruthy();
    expect(screen.queryByText("Off")).toBeNull();
    expect(screen.queryByText(/OUTBOUND_PROXY|PLAN_FORECAST|_URL|_TOKEN/)).toBeNull();
    expect(screen.getByText(/Each row opens its details/)).toBeTruthy();
  });

  it("says Not set up yet once, on OpenAI, instead of a red unreachable chip", async () => {
    stubNothingConfigured();
    render(<ConnectionsPage />);
    await vi.waitFor(() => expect(screen.getAllByText("Setup")).toHaveLength(1));
    await openRow("OpenAI");
    expect(await screen.findAllByText("Not set up yet")).toHaveLength(1);
    expect(screen.queryByText(/Unreachable/i)).toBeNull();
    expect(screen.queryByText(/Reused a recent check/)).toBeNull();
    // The hint is the probe's own detail, so it names what is actually missing.
    expect(screen.getByText("The outbound-proxy sidecar is not set up. Once it is set up, check again.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Check now" })).toHaveLength(1);
  });

  it("drops the health block on Google Calendar and keeps it on Google Maps", async () => {
    stubNothingConfigured();
    render(<ConnectionsPage />);
    await vi.waitFor(() => expect(screen.getAllByText("Setup")).toHaveLength(1));
    for (const title of ["Google Calendar"]) {
      await openRow(title);
      expect(screen.queryByText("Not set up yet")).toBeNull();
      expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /^Close/ }));
    }
    await openRow("Google Maps");
    expect(await screen.findByText(/No calls recorded in the last 24h/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check now" })).toBeTruthy();
  });

  it("disables Google Calendar sync while it is not set up", async () => {
    stubNothingConfigured();
    render(<ConnectionsPage />);
    await vi.waitFor(() => expect(screen.getAllByText("Setup")).toHaveLength(1));
    await openRow("Google Calendar");
    expect((await screen.findByRole("button", { name: "Sync now" })) as HTMLButtonElement).toHaveProperty(
      "disabled",
      true
    );
    expect(screen.getByText(/Not set up yet, so there is nothing to sync/)).toBeTruthy();
  });

  it("tells the planner row to set the server up when the engine address is missing", async () => {
    stubNothingConfigured();
    render(<ConnectionsPage />);
    await vi.waitFor(() => expect(screen.getAllByText("Setup")).toHaveLength(1));
    await openRow("Planner");
    expect(await screen.findByText("PLAN_FORECAST_SERVICE_URL")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Test again" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps the red failure for a configured provider that is genuinely unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/connections/status"))
          return answer({
            providers: [
              providerStatus("openai", {
                reachable: false,
                source: "probe",
                checkedAt: now.toISOString(),
                detail: "OpenAI probe returned 503."
              })
            ]
          });
        return answer({});
      })
    );
    render(<ConnectionsPage />);
    await vi.waitFor(() =>
      expect(within(screen.getByRole("button", { name: /^OpenAI/ })).getByText("Off")).toBeTruthy()
    );
    expect(screen.getByText(/connections need attention:.*OpenAI/)).toBeTruthy();
    await openRow("OpenAI");
    expect(await screen.findByText(/Unreachable — failed/)).toBeTruthy();
    expect(screen.getByText("OpenAI probe returned 503.")).toBeTruthy();
  });
});

describe("Connections page — everything connected", () => {
  it("says everything is connected and gives each row a plain one-line meta", async () => {
    context.state = { ...state, planning: { status: "current", lastSuccessfulAt: "2026-08-18T09:33:00.000Z" } };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/health/engine"))
          return answer({ reachable: true, configured: true, latencyMs: 4, status: "ok" });
        if (url.includes("/api/connections/status"))
          return answer({
            providers: ["openai", "google"].map((provider) =>
              providerStatus(provider, { reachable: true, source: "probe", checkedAt: "2026-08-18T09:30:00.000Z" })
            )
          });
        if (url.includes("/api/connections/google_calendar/proof"))
          return answer({ status: "connected", checkedAt: now.toISOString(), calendarCount: 2 });
        if (url.includes("/api/connections/google_calendar/sync"))
          return answer({
            lastRun: {
              startedAt: "2026-08-18T09:30:00.000Z",
              finishedAt: "2026-08-18T09:30:05.000Z",
              trigger: "scheduled",
              status: "synced",
              summary: null
            }
          });
        return answer({ lastRun: null });
      })
    );
    try {
      render(<ConnectionsPage />);
      expect(await screen.findByText("Everything is connected.")).toBeTruthy();
      expect(screen.getAllByText("On")).toHaveLength(4);
      expect(screen.getByText("Recalculated 7:33 pm")).toBeTruthy();
      expect(screen.getByText("Synced 7:30 pm")).toBeTruthy();
    } finally {
      context.state = state;
    }
  });
});

describe("Connections page — opening details", () => {
  it("opens the details for the row named in the address and closes back to the plain page", async () => {
    window.history.replaceState(null, "", "/connections#google-calendar");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => answer({}))
    );
    render(<ConnectionsPage />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Google Calendar" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close Google Calendar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.location.hash).toBe("");
  });

  it("puts the row's id in the address when it opens, and ignores an unknown one", async () => {
    window.history.replaceState(null, "", "/connections#nonsense");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => answer({}))
    );
    render(<ConnectionsPage />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await openRow("Google Calendar");
    expect(window.location.hash).toBe("#google-calendar");
  });
});
