// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import "@/test/render";

const requestImportBatch = vi.fn();
const markSaved = vi.fn();
const reconcile = vi.fn();
let review: { pendingEdits: boolean };
let receive: (batch: unknown) => void;
let closeFromReview: () => void;

vi.mock("@/state/portal-provider", () => ({
  usePortal: () => ({
    state: { settings: { timezone: "UTC" } },
    acceptServerState: vi.fn(),
    saveEntityCommand: vi.fn()
  })
}));
vi.mock("@/features/imports/import-requests", () => ({ requestImportBatch: (id: string) => requestImportBatch(id) }));
vi.mock("@/features/imports/import-downloads", () => ({ downloadImportErrors: vi.fn() }));
vi.mock("./use-import-status", () => ({ useImportStatus: () => ({ setError: vi.fn() }) }));
vi.mock("./use-import-review", () => ({
  useImportReview: (_state: unknown, _batch: unknown, setBatch: (batch: null) => void) => {
    closeFromReview = () => setBatch(null);
    return { ...review, markSaved, closeBatch: vi.fn() };
  }
}));
vi.mock("./use-import-queue", () => ({ useImportQueue: () => ({ reconcile, refreshQueue: vi.fn() }) }));
vi.mock("./use-import-commit", () => ({ useImportCommit: () => ({}) }));
vi.mock("./use-import-intake", () => ({
  useImportIntake: (options: { receiveBatch: (batch: unknown) => void }) => {
    receive = options.receiveBatch;
    return {};
  }
}));

const { useImportWorkflow } = await import("./use-import-workflow");

beforeEach(() => {
  requestImportBatch.mockReset();
  markSaved.mockReset();
  reconcile.mockReset();
  review = { pendingEdits: false };
});

describe("useImportWorkflow refreshOpenBatch", () => {
  it("reloads the batch kept open under review from the server", async () => {
    const { result } = renderHook(() => useImportWorkflow());
    act(() => receive({ id: "b1", version: 1 }));
    requestImportBatch.mockResolvedValue({ id: "b1", version: 2 });
    await act(async () => result.current.refreshOpenBatch());
    expect(requestImportBatch).toHaveBeenCalledWith("b1");
    expect(result.current.batch).toEqual({ id: "b1", version: 2 });
  });

  it("does nothing with no batch open, and keeps unsaved edits", async () => {
    const { result, rerender } = renderHook(() => useImportWorkflow());
    await act(async () => result.current.refreshOpenBatch());
    expect(requestImportBatch).not.toHaveBeenCalled();

    act(() => receive({ id: "b1", version: 1 }));
    review = { pendingEdits: true };
    rerender();
    await act(async () => result.current.refreshOpenBatch());
    expect(requestImportBatch).not.toHaveBeenCalled();
  });

  it("keeps what is on screen when the reload fails", async () => {
    const { result } = renderHook(() => useImportWorkflow());
    act(() => receive({ id: "b1", version: 1 }));
    requestImportBatch.mockRejectedValue(new Error("offline"));
    await act(async () => result.current.refreshOpenBatch());
    expect(result.current.batch).toEqual({ id: "b1", version: 1 });
  });

  it("does not bring a batch back that was closed while the reload was in flight", async () => {
    const { result } = renderHook(() => useImportWorkflow());
    act(() => receive({ id: "b1", version: 1 }));
    let answer: (batch: unknown) => void = () => {};
    requestImportBatch.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.refreshOpenBatch();
    });
    act(() => closeFromReview());
    expect(result.current.batch).toBeNull();
    await act(async () => {
      answer({ id: "b1", version: 2 });
      await pending;
    });
    expect(result.current.batch).toBeNull();
  });

  it("does not replace a different batch opened while the reload was in flight", async () => {
    const { result } = renderHook(() => useImportWorkflow());
    act(() => receive({ id: "b1", version: 1 }));
    let answer: (batch: unknown) => void = () => {};
    requestImportBatch.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.refreshOpenBatch();
    });
    act(() => receive({ id: "b2", version: 1 }));
    await act(async () => {
      answer({ id: "b1", version: 2 });
      await pending;
    });
    expect(result.current.batch).toEqual({ id: "b2", version: 1 });
  });

  it("does not overwrite edits made while the reload was in flight", async () => {
    const { result, rerender } = renderHook(() => useImportWorkflow());
    act(() => receive({ id: "b1", version: 1 }));
    let answer: (batch: unknown) => void = () => {};
    requestImportBatch.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.refreshOpenBatch();
    });
    review = { pendingEdits: true };
    rerender();
    await act(async () => {
      answer({ id: "b1", version: 2 });
      await pending;
    });
    expect(result.current.batch).toEqual({ id: "b1", version: 1 });
  });
});
