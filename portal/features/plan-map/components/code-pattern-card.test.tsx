// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/test/render";
import { createSeedState } from "@/state/portal-state";

const seed = createSeedState(new Date("2026-08-18T10:00:00.000Z"));
const context = { state: seed, ready: true, saving: false, saveEntityCommand: vi.fn() };
vi.mock("@/state/portal-provider", () => ({ usePortal: () => context }));

afterEach(() => {
  context.state = seed;
  context.saveEntityCommand.mockReset();
});

async function savedEntity(): Promise<Record<string, unknown>> {
  const [command] = context.saveEntityCommand.mock.calls[0] as [
    { entityType: string; entity: Record<string, unknown> }
  ];
  expect(command.entityType).toBe("settings");
  return command.entity;
}

describe("Reference codes card", () => {
  it("sends only the pattern, trimmed", async () => {
    context.saveEntityCommand.mockResolvedValue(undefined);
    const { CodePatternCard } = await import("./code-pattern-card");
    render(<CodePatternCard />);
    fireEvent.change(screen.getByLabelText("Code pattern"), { target: { value: " [A-Z]{3}\\d{4} " } });
    fireEvent.click(screen.getByRole("button", { name: "Save code pattern" }));
    await act(async () => {});
    expect(await savedEntity()).toEqual({ planCodePattern: "[A-Z]{3}\\d{4}" });
    expect(screen.getByRole("status").textContent).toBe("Code pattern saved.");
  });

  it("sends null for an empty field and shows the server's message when it refuses", async () => {
    context.state = { ...seed, settings: { ...seed.settings, planCodePattern: "[A-Z]{3}\\d{4}" } };
    context.saveEntityCommand.mockRejectedValue(new Error("The code pattern must not match empty text."));
    const { CodePatternCard } = await import("./code-pattern-card");
    render(<CodePatternCard />);
    fireEvent.change(screen.getByLabelText("Code pattern"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save code pattern" }));
    await act(async () => {});
    expect(await savedEntity()).toEqual({ planCodePattern: null });
    expect(screen.getByRole("alert").textContent).toBe("The code pattern must not match empty text.");
  });
});
