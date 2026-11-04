// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import "@/test/render";
import { closeCaptureSheet, openCaptureSheet, setCaptureSheetMode, useCaptureSheet } from "./use-capture-sheet";

/**
 * `disruptionPreset` is only ever meant to survive from the offer that set it to the one render
 * where the sheet reads it (the commitment contacts design note, Risks: a preset must not leak onto
 * some later, unrelated open of the sheet). Both ways of leaving that render — switching halves, or
 * closing the sheet outright — have to actually clear it, not just stop showing it.
 */
describe("useCaptureSheet preset lifecycle", () => {
  it("clears the preset when the segmented control switches back to capture", () => {
    const { result } = renderHook(() => useCaptureSheet());
    act(() => openCaptureSheet("disruption", { contactId: "sam", about: "Dentist at 10:00" }));
    expect(result.current.disruptionPreset).toEqual({ contactId: "sam", about: "Dentist at 10:00" });

    act(() => setCaptureSheetMode("capture"));
    expect(result.current.disruptionPreset).toBeUndefined();

    act(() => closeCaptureSheet());
  });

  it("clears the preset when the sheet is closed outright", () => {
    const { result } = renderHook(() => useCaptureSheet());
    act(() => openCaptureSheet("disruption", { contactId: "sam", about: "Dentist at 10:00" }));
    expect(result.current.disruptionPreset).toEqual({ contactId: "sam", about: "Dentist at 10:00" });

    act(() => closeCaptureSheet());
    expect(result.current.disruptionPreset).toBeUndefined();
  });

  it("does not resurrect a preset on a later open that names none", () => {
    const { result } = renderHook(() => useCaptureSheet());
    act(() => openCaptureSheet("disruption", { contactId: "sam", about: "Dentist at 10:00" }));
    act(() => closeCaptureSheet());

    act(() => openCaptureSheet("disruption"));
    expect(result.current.disruptionPreset).toBeUndefined();

    act(() => closeCaptureSheet());
  });
});
