// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { ImportLocationPickerSheet } from "./import-location-picker-sheet";

const matches = [{ label: "Harbor Mart, Riverside", latitude: -36.1, longitude: 146.9 }];

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubGeocode() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ matches }) }));
}

async function search() {
  fireEvent.change(screen.getByPlaceholderText("Type a place, e.g. City Library"), {
    target: { value: "Harbor Mart Riverside" }
  });
  fireEvent.click(screen.getByRole("button", { name: "Find" }));
  await vi.waitFor(() => expect(screen.getByText("Harbor Mart, Riverside")).toBeTruthy());
}

describe("ImportLocationPickerSheet", () => {
  it("renders nothing while closed", () => {
    render(<ImportLocationPickerSheet open={false} onClose={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.queryByText("Custom location")).toBeNull();
  });

  it("creates a one-off place the moment a match is picked, with the toggle off by default", async () => {
    stubGeocode();
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<ImportLocationPickerSheet open onClose={onClose} onCreate={onCreate} />);
    await search();
    expect(screen.queryByLabelText("Name")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Harbor Mart, Riverside" }));
    await vi.waitFor(() => expect(onCreate).toHaveBeenCalledWith(matches[0], { oneOff: true }));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("expands to a name field when toggled permanent, and waits for an explicit save", async () => {
    stubGeocode();
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<ImportLocationPickerSheet open onClose={vi.fn()} onCreate={onCreate} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /permanent location/i }));
    await search();
    fireEvent.click(screen.getByRole("button", { name: "Harbor Mart, Riverside" }));
    // Picking a match while permanent only selects it; nothing is created yet.
    expect(onCreate).not.toHaveBeenCalled();
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    expect(name.value).toBe("Harbor Mart, Riverside");
    fireEvent.change(name, { target: { value: "Mum's place" } });
    fireEvent.click(screen.getByRole("button", { name: "Save location" }));
    await vi.waitFor(() => expect(onCreate).toHaveBeenCalledWith(matches[0], { oneOff: false, name: "Mum's place" }));
  });

  it("offers a reference photo only when photo check-ins are on, and passes it with the save", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(url.includes("/mode") ? { mode: "on" } : { matches })
        })
      )
    );
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<ImportLocationPickerSheet open onClose={vi.fn()} onCreate={onCreate} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /permanent location/i }));
    await search();
    fireEvent.click(screen.getByRole("button", { name: "Harbor Mart, Riverside" }));
    const input = (await screen.findByLabelText("Reference photo (optional)")) as HTMLInputElement;
    const photo = new File([new Uint8Array([1, 2])], "harbor-mart.jpg", { type: "image/jpeg" });
    fireEvent.change(input, { target: { files: [photo] } });
    fireEvent.click(screen.getByRole("button", { name: "Save location" }));
    await vi.waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(matches[0], { oneOff: false, name: "Harbor Mart, Riverside", photo })
    );
  });

  it("shows a failed save instead of closing", async () => {
    stubGeocode();
    const onCreate = vi.fn().mockRejectedValue(new Error("That name is already taken."));
    const onClose = vi.fn();
    render(<ImportLocationPickerSheet open onClose={onClose} onCreate={onCreate} />);
    await search();
    fireEvent.click(screen.getByRole("button", { name: "Harbor Mart, Riverside" }));
    await vi.waitFor(() => expect(screen.getByText("That name is already taken.")).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
  });
});
