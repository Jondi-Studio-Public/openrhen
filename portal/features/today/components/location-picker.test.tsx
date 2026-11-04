// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConditionDefinition } from "@/features/settings/context-summary";
import { fireEvent, render, screen } from "@/test/render";
import { LocationPicker, type GeocodeMatch } from "./location-picker";

const definitions = [
  { id: "campus", name: "Campus", kind: "location", status: "active", travelMinutes: 18 },
  { id: "house", name: "Home", kind: "location", status: "active" },
  { id: "shed", name: "Old shed", kind: "location", status: "archived" },
  { id: "dentist", name: "Dentist, Riverside", kind: "location", status: "active", oneOff: true },
  { id: "laptop", name: "Laptop", kind: "capability", status: "active" }
] as unknown as ConditionDefinition[];

const noCreate = () => Promise.reject(new Error("not expected"));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Location picker", () => {
  it("offers the active saved places, without one-off or archived ones, and reports a choice", () => {
    const onSelect = vi.fn();
    render(
      <LocationPicker definitions={definitions} locationId="" onSelect={onSelect} onCreateFromSearch={noCreate} />
    );
    const place = screen.getByLabelText("Place") as HTMLSelectElement;
    expect([...place.options].map((option) => option.textContent)).toEqual(["— none —", "Campus", "Home"]);
    fireEvent.change(place, { target: { value: "campus" } });
    expect(onSelect).toHaveBeenCalledWith("campus", "Campus");
  });

  it("keeps the chosen one-off place visible, says what the trip costs, and can clear to none", () => {
    const onSelect = vi.fn();
    render(
      <LocationPicker
        definitions={definitions}
        locationId="dentist"
        onSelect={onSelect}
        onCreateFromSearch={noCreate}
      />
    );
    const place = screen.getByLabelText("Place") as HTMLSelectElement;
    expect(place.value).toBe("dentist");
    expect([...place.options].some((option) => option.textContent === "Dentist, Riverside")).toBe(true);
    fireEvent.change(place, { target: { value: "" } });
    expect(onSelect).toHaveBeenCalledWith("", "");
  });

  it("says what the journey to the chosen place is assumed to cost", () => {
    render(
      <LocationPicker definitions={definitions} locationId="campus" onSelect={() => {}} onCreateFromSearch={noCreate} />
    );
    expect(screen.getByText("~18 min from home")).toBeTruthy();
  });

  it("searches the geocoder, stores the picked match as a place, and selects it", async () => {
    const matches: GeocodeMatch[] = [{ label: "Harbor Mart, Riverside", latitude: -36.1, longitude: 146.9 }];
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ matches }) });
    vi.stubGlobal("fetch", fetchMock);
    const onSelect = vi.fn();
    const onCreateFromSearch = vi.fn().mockResolvedValue({ id: "created-place", name: "Harbor Mart, Riverside" });
    render(
      <LocationPicker
        definitions={definitions}
        locationId=""
        onSelect={onSelect}
        onCreateFromSearch={onCreateFromSearch}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Search for a place…" }));
    fireEvent.change(screen.getByLabelText("Search for a place"), { target: { value: "Harbor Mart Riverside" } });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    await vi.waitFor(() => expect(screen.getByText("Harbor Mart, Riverside")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/travel/geocode",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ query: "Harbor Mart Riverside" }) })
    );
    fireEvent.click(screen.getByRole("button", { name: "Harbor Mart, Riverside" }));
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith("created-place", "Harbor Mart, Riverside"));
    expect(onCreateFromSearch).toHaveBeenCalledWith(matches[0]);
  });

  it("shows the geocoder's failure instead of silently offering nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({ error: "Geocoding failed." }) })
    );
    render(
      <LocationPicker definitions={definitions} locationId="" onSelect={() => {}} onCreateFromSearch={noCreate} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Search for a place…" }));
    fireEvent.change(screen.getByLabelText("Search for a place"), { target: { value: "nowhere" } });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    await vi.waitFor(() => expect(screen.getByText("Geocoding failed.")).toBeTruthy());
  });
});
