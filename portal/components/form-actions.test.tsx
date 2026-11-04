// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/test/render";
import { renderHook } from "@testing-library/react";
import { FormActions, useDraftId, useSubmitGuard } from "@/components/form-actions";

describe("FormActions", () => {
  it("offers only an add button while nothing is being edited", () => {
    render(<FormActions editing={false} cancel={() => {}} />);
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("switches to saving changes and lets the edit be abandoned", () => {
    const cancel = vi.fn();
    render(<FormActions editing cancel={cancel} />);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("disables the submit button while a save is pending", () => {
    render(<FormActions editing={false} cancel={() => {}} pending />);
    expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

function GuardedForm({ onSave }: { onSave: () => Promise<void> }) {
  const guard = useSubmitGuard(() => onSave());
  return (
    <form onSubmit={guard.onSubmit} aria-label="draft">
      <FormActions editing={false} cancel={() => {}} pending={guard.pending} />
    </form>
  );
}

const addDisabled = () => (screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled;

describe("useSubmitGuard", () => {
  it("swallows a second submit and disables the button until the first settles", async () => {
    let release: () => void = () => {};
    const onSave = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    render(<GuardedForm onSave={onSave} />);
    const form = screen.getByRole("form", { name: "draft" });
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(addDisabled()).toBe(true);
    await act(async () => release());
    await act(async () => {});
    expect(addDisabled()).toBe(false);
    fireEvent.submit(form);
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it("re-enables after a save that throws", async () => {
    const onSave = vi.fn(() => Promise.reject(new Error("nope")));
    render(<GuardedForm onSave={() => onSave().catch(() => {})} />);
    fireEvent.submit(screen.getByRole("form", { name: "draft" }));
    await act(async () => {});
    expect(addDisabled()).toBe(false);
  });

  it("releases the guard when the handler itself rejects, and the rejection reaches the caller", async () => {
    const handler = vi.fn(() => Promise.reject(new Error("nope")));
    const { result } = renderHook(() => useSubmitGuard(handler));
    const event = { preventDefault: () => {} } as never;
    await act(async () => {
      await expect(result.current.onSubmit(event)).rejects.toThrow("nope");
    });
    expect(result.current.pending).toBe(false);
    await act(async () => {
      await expect(result.current.onSubmit(event)).rejects.toThrow("nope");
    });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("shares the guard with run(): a run during a submit is swallowed", async () => {
    let release: () => void = () => {};
    const { result } = renderHook(() => useSubmitGuard(() => new Promise<void>((r) => (release = r))));
    const event = { preventDefault: () => {} } as never;
    let first: Promise<unknown> = Promise.resolve();
    act(() => {
      first = result.current.onSubmit(event);
    });
    const other = vi.fn();
    await act(async () => void (await result.current.run(other)));
    expect(other).not.toHaveBeenCalled();
    await act(async () => {
      release();
      await first;
    });
  });
});

describe("useDraftId", () => {
  it("returns one id until reset, then a new one", () => {
    const { result } = renderHook(() => useDraftId());
    const first = result.current.current();
    expect(first).toBeTruthy();
    expect(result.current.current()).toBe(first);
    result.current.reset();
    expect(result.current.current()).not.toBe(first);
  });
});
