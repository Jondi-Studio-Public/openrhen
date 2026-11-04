import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlace } from "./create-place";

const match = { label: "Riverside CC, College Avenue", latitude: -33.88, longitude: 151.19 };

afterEach(() => vi.unstubAllGlobals());

describe("createPlace", () => {
  it("files an optional reference photo for a permanent place, and a failed upload does not fail the place", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({ error: "off" }) });
    vi.stubGlobal("fetch", fetchMock);
    const photo = new File([new Uint8Array([1, 2, 3])], "desk.jpg", { type: "image/jpeg" });
    const place = await createPlace(match, vi.fn().mockResolvedValue(undefined), {
      oneOff: false,
      name: "Desk",
      photo
    });
    expect(place).toEqual({ id: "desk", name: "Desk" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/place-photos");
    expect((fetchMock.mock.calls[0]![1].body as FormData).get("placeId")).toBe("desk");
  });

  it("never uploads a photo for a one-off place", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await createPlace(match, vi.fn().mockResolvedValue(undefined), {
      oneOff: true,
      photo: new File([new Uint8Array([1])], "x.jpg")
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stores a one-off place under the match's own label", async () => {
    const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
    const place = await createPlace(match, saveEntityCommand, { oneOff: true });
    expect(place.name).toBe(match.label);
    expect(saveEntityCommand.mock.calls[0]![0]).toMatchObject({
      type: "save_entity",
      entityType: "condition_definition",
      expectedVersion: null,
      entity: {
        id: place.id,
        name: match.label,
        kind: "location",
        status: "active",
        oneOff: true,
        latitude: match.latitude,
        longitude: match.longitude,
        address: match.label
      }
    });
  });

  it("stores a permanent place under the given name, keyed by a slug of it", async () => {
    const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
    const place = await createPlace(match, saveEntityCommand, { oneOff: false, name: "Mum's place" });
    expect(place).toEqual({ id: "mum-s-place", name: "Mum's place" });
    expect(saveEntityCommand.mock.calls[0]![0].entity).toMatchObject({
      id: "mum-s-place",
      name: "Mum's place",
      oneOff: false,
      address: match.label
    });
  });

  it("falls back to the match's label when no name is given for a permanent place", async () => {
    const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
    const place = await createPlace(match, saveEntityCommand, { oneOff: false });
    expect(place.name).toBe(match.label);
  });
});
