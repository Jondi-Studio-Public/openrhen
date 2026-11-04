// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useServerDraft } from "./use-server-draft";

describe("useServerDraft", () => {
  it("seeds from the server value once ready", () => {
    const { result, rerender } = renderHook(({ value, ready }) => useServerDraft(value, ready), {
      initialProps: { value: { name: "" }, ready: false }
    });
    expect(result.current.draft).toEqual({ name: "" });
    rerender({ value: { name: "Ada" }, ready: true });
    expect(result.current.draft).toEqual({ name: "Ada" });
  });

  it("reseeds on a later server value while the draft is untouched", () => {
    const { result, rerender } = renderHook(({ value }) => useServerDraft(value, true), {
      initialProps: { value: { name: "Ada" } }
    });
    rerender({ value: { name: "Grace" } });
    expect(result.current.draft).toEqual({ name: "Grace" });
  });

  it("stops reseeding once the draft has been edited", () => {
    const { result, rerender } = renderHook(({ value }) => useServerDraft(value, true), {
      initialProps: { value: { name: "Ada" } }
    });
    act(() => result.current.setDraft({ name: "Ada (editing)" }));
    expect(result.current.draft).toEqual({ name: "Ada (editing)" });
    // A reload lands mid-edit — normalizePortalState's fresh object must not overwrite the typing.
    rerender({ value: { name: "Grace" } });
    expect(result.current.draft).toEqual({ name: "Ada (editing)" });
  });

  it("resumes reseeding once a save marks the draft pristine again", () => {
    const { result, rerender } = renderHook(({ value }) => useServerDraft(value, true), {
      initialProps: { value: { name: "Ada" } }
    });
    act(() => result.current.setDraft({ name: "Ada (editing)" }));
    act(() => result.current.markPristine());
    // The save's own response already reflects the edit; a later, unrelated reload can resync freely.
    rerender({ value: { name: "Ada (editing)" } });
    rerender({ value: { name: "Grace" } });
    expect(result.current.draft).toEqual({ name: "Grace" });
  });

  it("resetDraft replaces the value and marks it pristine in one step", () => {
    const { result, rerender } = renderHook(({ value }) => useServerDraft(value, true), {
      initialProps: { value: { name: "Ada" } }
    });
    act(() => result.current.setDraft({ name: "half-typed" }));
    act(() => result.current.resetDraft({ name: "" }));
    expect(result.current.draft).toEqual({ name: "" });
    // Pristine again, so the next server value is free to seed it.
    rerender({ value: { name: "Grace" } });
    expect(result.current.draft).toEqual({ name: "Grace" });
  });

  it("never reseeds before ready, even across server value changes", () => {
    const { result, rerender } = renderHook(({ value, ready }) => useServerDraft(value, ready), {
      initialProps: { value: { name: "seed" }, ready: false }
    });
    rerender({ value: { name: "changed while loading" }, ready: false });
    expect(result.current.draft).toEqual({ name: "seed" });
  });

  it("keeps seededVersion fixed while dirty and updates it on markPristine", () => {
    const { result, rerender } = renderHook(({ value, version }) => useServerDraft(value, true, version), {
      initialProps: { value: { name: "Ada" }, version: 1 }
    });
    expect(result.current.seededVersion).toBe(1);

    // Editing marks the draft dirty, so it stops reseeding — seededVersion must stay put too, even
    // once the live version has moved on from something else, or a later save would send a stale
    // expectedVersion that happens to look "current" only by coincidence.
    act(() => result.current.setDraft({ name: "editing" }));
    rerender({ value: { name: "Ada" }, version: 2 });
    expect(result.current.seededVersion).toBe(1);
    expect(result.current.draft).toEqual({ name: "editing" });

    // A caller marks the draft pristine once its edit is settled (ordinarily after a successful
    // save) — seededVersion should pick up the version this hook has most recently seen.
    act(() => result.current.markPristine());
    expect(result.current.seededVersion).toBe(2);

    // Pristine again, so the next server value and version are free to reseed it.
    rerender({ value: { name: "Grace" }, version: 3 });
    expect(result.current.draft).toEqual({ name: "Grace" });
    expect(result.current.seededVersion).toBe(3);
  });

  it("resetDraft seeds the given version, defaulting to the latest one seen", () => {
    const { result, rerender } = renderHook(({ value, version }) => useServerDraft(value, true, version), {
      initialProps: { value: { name: "Ada" }, version: 1 }
    });
    act(() => result.current.setDraft({ name: "editing" }));
    rerender({ value: { name: "Ada" }, version: 2 });
    act(() => result.current.resetDraft({ name: "" }));
    expect(result.current.seededVersion).toBe(2);

    act(() => result.current.setDraft({ name: "editing again" }));
    act(() => result.current.resetDraft({ name: "reset" }, 9));
    expect(result.current.seededVersion).toBe(9);
  });
});
