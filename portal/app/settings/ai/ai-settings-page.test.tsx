// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { act, fireEvent, render, screen } from "@/test/render";
import { createSeedState } from "@/state/portal-state";

const seed = createSeedState(new Date("2026-08-18T10:00:00.000Z"));
const context = { state: seed, ready: true, saving: false, saveEntityCommand: vi.fn() };
vi.mock("@/state/portal-provider", () => ({ usePortal: () => context }));

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === "/api/plan-map"
        ? Response.json({ links: [], findings: [], switches: [{ addon: "email_needs_reply", mode: "on" }] })
        : Response.json({ tokens: [] })
    )
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  context.state = seed;
  context.saveEntityCommand.mockReset();
});

describe("AI settings page", () => {
  it("is the AI and add-ons row, holding the models, the map add-on switches and agent tokens", async () => {
    const { default: AiSettingsPage } = await import("./page");
    render(<AiSettingsPage />);
    expect(screen.getByRole("heading", { level: 1, name: "AI and add-ons" })).toBeTruthy();
    const needsReply = (await screen.findByLabelText("Needs-reply list mode")) as HTMLSelectElement;
    await waitFor(() => expect(needsReply.value).toBe("on"));
    expect(Array.from(needsReply.options).map((option) => option.value)).toEqual(["off", "on"]);
    expect(screen.queryByLabelText("Email reply drafts mode")).toBeNull();
  });

  it("saves only the two model fields it owns, not sleep or planning", async () => {
    context.saveEntityCommand.mockResolvedValue(undefined);
    const { default: AiSettingsPage } = await import("./page");
    render(<AiSettingsPage />);
    fireEvent.change(screen.getByLabelText(/^Deliverable workspace chat/), { target: { value: "gpt-5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save AI models" }));
    await act(async () => {});
    expect(context.saveEntityCommand).toHaveBeenCalledTimes(1);
    const [command] = context.saveEntityCommand.mock.calls[0] as [
      { entityType: string; entity: Record<string, unknown> }
    ];
    expect(command.entityType).toBe("settings");
    expect(command.entity).toEqual({
      deliverableChatModel: "gpt-5",
      importExtractorModel: ""
    });
  });

  it("sends an empty string to clear a tool back to default", async () => {
    context.state = {
      ...seed,
      settings: { ...seed.settings, deliverableChatModel: "gpt-5", version: seed.settings.version }
    };
    context.saveEntityCommand.mockResolvedValue(undefined);
    const { default: AiSettingsPage } = await import("./page");
    render(<AiSettingsPage />);
    fireEvent.change(screen.getByLabelText(/^Deliverable workspace chat/), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save AI models" }));
    await act(async () => {});
    const [command] = context.saveEntityCommand.mock.calls[0] as [{ entity: Record<string, unknown> }];
    expect(command.entity.deliverableChatModel).toBe("");
  });

  it("saves a custom model id typed into the free-text field", async () => {
    context.saveEntityCommand.mockResolvedValue(undefined);
    const { default: AiSettingsPage } = await import("./page");
    render(<AiSettingsPage />);
    fireEvent.change(screen.getByLabelText(/^Import extraction/), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("Custom model id for Import extraction"), {
      target: { value: "gpt-4.1-mini" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save AI models" }));
    await act(async () => {});
    const [command] = context.saveEntityCommand.mock.calls[0] as [{ entity: Record<string, unknown> }];
    expect(command.entity.importExtractorModel).toBe("gpt-4.1-mini");
  });
});
