// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/test/render";
import { createSeedState } from "@/state/portal-state";
import { PulsePublishSection } from "@/features/settings/components/pulse-publish-section";

const seed = createSeedState(new Date("2026-08-18T10:00:00.000Z"));
const context = { state: seed, ready: true, saving: false, saveEntityCommand: vi.fn() };
vi.mock("@/state/portal-provider", () => ({ usePortal: () => context }));

function jsonResponse(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
}

afterEach(() => {
  context.state = seed;
  context.saveEntityCommand.mockReset();
  vi.unstubAllGlobals();
});

describe("PulsePublishSection", () => {
  it("shows the configured host and the preview's on-plan reading", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/api/pulse/config") return jsonResponse({ configured: true, host: "tracker.example.com" });
        return jsonResponse({
          pulse: {
            v: 1,
            seq: 3,
            generatedAt: "2026-09-26T14:00:00.000Z",
            state: "on",
            since: "2026-09-26T13:00:00.000Z",
            doing: { kind: "action", title: "Sort the bedroom floor" },
            private: false,
            shares: {
              today: { onPercent: 60, countedMinutes: 300 },
              days7: { onPercent: 55, countedMinutes: 2000 },
              days30: { onPercent: 50, countedMinutes: 8000 }
            }
          },
          lastPublishedAt: "2026-09-26T13:50:00.000Z",
          lastPublishOutcome: "delivered",
          lastPublishError: null
        });
      })
    );
    render(<PulsePublishSection />);
    await act(async () => {});
    expect(screen.getByText("Sending to tracker.example.com.")).toBeTruthy();
    expect(screen.getByText(/On plan · Sort the bedroom floor/)).toBeTruthy();
    expect(screen.getByText("60%")).toBeTruthy();
  });

  it("hides the title and shows 'private' when the reading is private", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/api/pulse/config") return jsonResponse({ configured: true, host: "tracker.example.com" });
        return jsonResponse({
          pulse: {
            v: 1,
            seq: 1,
            generatedAt: "2026-09-26T14:00:00.000Z",
            state: "on",
            since: "2026-09-26T13:00:00.000Z",
            private: true,
            shares: {
              today: { onPercent: 60, countedMinutes: 300 },
              days7: { onPercent: null, countedMinutes: 0 },
              days30: { onPercent: null, countedMinutes: 0 }
            }
          },
          lastPublishedAt: null,
          lastPublishOutcome: null,
          lastPublishError: null
        });
      })
    );
    render(<PulsePublishSection />);
    await act(async () => {});
    expect(screen.getByText(/On plan · private/)).toBeTruthy();
  });

  it("says no tracker URL is set when the proxy reports unconfigured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/api/pulse/config") return jsonResponse({ configured: false, host: null });
        return jsonResponse({ pulse: null, lastPublishedAt: null, lastPublishOutcome: null, lastPublishError: null });
      })
    );
    render(<PulsePublishSection />);
    await act(async () => {});
    expect(screen.getByText(/No tracker URL set/)).toBeTruthy();
    expect(screen.getByText("Not recorded yet.")).toBeTruthy();
  });

  it("saves the toggle through save_entity on settings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        jsonResponse({
          configured: false,
          host: null,
          pulse: null,
          lastPublishedAt: null,
          lastPublishOutcome: null,
          lastPublishError: null
        })
      )
    );
    context.saveEntityCommand.mockResolvedValue(undefined);
    render(<PulsePublishSection />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => {});
    expect(context.saveEntityCommand).toHaveBeenCalledTimes(1);
    const [command] = context.saveEntityCommand.mock.calls[0] as [
      { entityType: string; entity: { pulsePublishEnabled: boolean } }
    ];
    expect(command.entityType).toBe("settings");
    expect(command.entity.pulsePublishEnabled).toBe(true);
  });
});
