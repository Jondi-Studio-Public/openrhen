// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/test/render";
import { createSeedState } from "@/state/portal-state";
import { TimeBandsSection } from "@/features/settings/components/time-bands-section";

const seed = createSeedState(new Date("2026-08-18T10:00:00.000Z"));
const context = { state: seed, ready: true, saving: false, saveEntityCommand: vi.fn() };
vi.mock("@/state/portal-provider", () => ({ usePortal: () => context }));

afterEach(() => {
  context.state = seed;
  context.saveEntityCommand.mockReset();
});

function saveButton() {
  return screen.getByRole("button", { name: "Save time bands" });
}

describe("TimeBandsSection", () => {
  it("renders the three default bands", () => {
    render(<TimeBandsSection />);
    expect((screen.getByLabelText("Band 1 name") as HTMLInputElement).value).toBe("Morning");
    expect((screen.getByLabelText("Band 1 start") as HTMLInputElement).value).toBe("06:00");
    expect((screen.getByLabelText("Band 1 end") as HTMLInputElement).value).toBe("12:00");
    expect((screen.getByLabelText("Band 2 name") as HTMLInputElement).value).toBe("Afternoon");
    expect((screen.getByLabelText("Band 3 name") as HTMLInputElement).value).toBe("Evening");
  });

  it("rejects an end before start, and sends nothing", async () => {
    context.saveEntityCommand.mockResolvedValue(undefined);
    render(<TimeBandsSection />);
    fireEvent.change(screen.getByLabelText("Band 1 end"), { target: { value: "05:00" } });
    fireEvent.click(saveButton());
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toBe("Each band's end must be after its start.");
    expect(context.saveEntityCommand).not.toHaveBeenCalled();
  });

  it("saves an edited band, keeping its id and every other band", async () => {
    context.saveEntityCommand.mockResolvedValue(undefined);
    render(<TimeBandsSection />);
    const originalId = seed.settings.timeBands![0]!.id;
    fireEvent.change(screen.getByLabelText("Band 1 name"), { target: { value: "Early morning" } });
    fireEvent.click(saveButton());
    await act(async () => {});
    expect(context.saveEntityCommand).toHaveBeenCalledTimes(1);
    const [command] = context.saveEntityCommand.mock.calls[0] as [
      { entityType: string; entity: { timeBands: { id: string; name: string }[] } }
    ];
    expect(command.entityType).toBe("settings");
    expect(command.entity.timeBands).toHaveLength(3);
    expect(command.entity.timeBands[0]!.id).toBe(originalId);
    expect(command.entity.timeBands[0]!.name).toBe("Early morning");
    expect(screen.getByRole("status").textContent).toBe("Time bands saved.");
  });

  it("adds a band and deletes a band", async () => {
    context.saveEntityCommand.mockResolvedValue(undefined);
    render(<TimeBandsSection />);
    fireEvent.click(screen.getByRole("button", { name: "Add band" }));
    expect(screen.getByLabelText("Band 4 name")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Band 4 name"), { target: { value: "Late night" } });

    fireEvent.click(screen.getByRole("button", { name: "Delete band 2" }));
    expect(screen.queryByLabelText("Band 4 name")).toBeNull();

    fireEvent.click(saveButton());
    await act(async () => {});
    expect(context.saveEntityCommand).toHaveBeenCalledTimes(1);
    const [command] = context.saveEntityCommand.mock.calls[0] as [{ entity: { timeBands: { name: string }[] } }];
    expect(command.entity.timeBands.map((band) => band.name)).toEqual(["Morning", "Evening", "Late night"]);
  });
});
