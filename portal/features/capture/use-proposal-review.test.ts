// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import "@/test/render";
import { createSeedState, type CaptureItem, type PortalState } from "@/state/portal-state";
import { useProposalReview } from "./use-proposal-review";

const addCapture = vi.fn().mockResolvedValue(undefined);
const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
let state: PortalState;

vi.mock("@/state/portal-provider", () => ({
  usePortal: () => ({ state, addCapture, saveEntityCommand })
}));

function capture(overrides: Partial<CaptureItem> & Pick<CaptureItem, "id">): CaptureItem {
  return {
    text: overrides.id,
    createdAt: "2026-08-01T00:00:00.000Z",
    status: "confirmed",
    proposalType: "unclassified",
    proposedFields: {},
    sourceType: "manual_capture",
    ...overrides
  } as CaptureItem;
}

beforeEach(() => {
  addCapture.mockClear();
  saveEntityCommand.mockClear();
  state = createSeedState(new Date("2026-08-18T09:00:00.000Z"));
});

describe("useProposalReview", () => {
  it("lists every kept Someday and Reference item, newest filing first, with no window", () => {
    const somedays = Array.from({ length: 10 }, (_, index) =>
      capture({
        id: `someday-${index}`,
        proposalType: "someday",
        reviewedAt: `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`
      })
    );
    state = {
      ...state,
      captures: [
        ...somedays,
        capture({ id: "ref", proposalType: "reference", reviewedAt: "2026-08-12T00:00:00.000Z" }),
        capture({ id: "dropped", proposalType: "someday", status: "ignored" }),
        capture({ id: "made-work", proposalType: "action" })
      ]
    };
    const { result } = renderHook(() => useProposalReview());
    expect(result.current.someday).toHaveLength(10);
    expect(result.current.someday[0]!.id).toBe("someday-9");
    expect(result.current.reference.map((item) => item.id)).toEqual(["ref"]);
  });

  it("reopens a kept item into the editor with no type chosen", async () => {
    state = {
      ...state,
      captures: [capture({ id: "cello", proposalType: "someday", proposedFields: { title: "Learn the cello" } })]
    };
    const { result } = renderHook(() => useProposalReview());
    await act(() => result.current.reopen("cello"));
    expect(saveEntityCommand).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "capture", entity: expect.objectContaining({ status: "pending" }) })
    );
    expect(result.current.reviewingId).toBe("cello");
    expect(result.current.draft).toMatchObject({ proposalType: "unclassified", title: "Learn the cello" });
  });

  it("shows a failed reopen or drop beside the kept lists, not in the closed editor", async () => {
    state = { ...state, captures: [capture({ id: "cello", proposalType: "someday" })] };
    saveEntityCommand.mockRejectedValueOnce(new Error("Offline"));
    const { result } = renderHook(() => useProposalReview());
    await act(() => result.current.reopen("cello"));
    expect(result.current.keptError).toBe("Offline");
    expect(result.current.reviewingId).toBeNull();
    expect(result.current.error).toBe("");
    saveEntityCommand.mockRejectedValueOnce(new Error("Still offline"));
    await act(() => result.current.drop("cello"));
    expect(result.current.keptError).toBe("Still offline");
    await act(() => result.current.drop("cello"));
    expect(result.current.keptError).toBe("");
  });

  it("drop settles true once saved, and keepAgain files the dropped item back as it was", async () => {
    const kept = capture({ id: "cello", proposalType: "someday", reviewedAt: "2026-08-02T00:00:00.000Z" });
    state = { ...state, captures: [kept] };
    const { result, rerender } = renderHook(() => useProposalReview());
    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.drop("cello");
    });
    expect(outcome).toBe(true);
    await expect(result.current.keepAgain(kept)).rejects.toThrow("already kept");
    state = { ...state, captures: [{ ...kept, status: "ignored" }] };
    rerender();
    saveEntityCommand.mockClear();
    await act(() => result.current.keepAgain(kept));
    expect(saveEntityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: expect.objectContaining({ status: "confirmed", proposalType: "someday", reviewedAt: kept.reviewedAt })
      })
    );
  });

  it("ignore settles true once saved and false when the write fails or there is nothing to ignore", async () => {
    state = { ...state, captures: [capture({ id: "idea", status: "pending", sourceType: "manual" })] };
    const { result } = renderHook(() => useProposalReview());
    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.ignore("idea");
    });
    expect(outcome).toBe(true);
    expect(saveEntityCommand).toHaveBeenCalledWith(
      expect.objectContaining({ entity: expect.objectContaining({ id: "idea", status: "ignored" }) })
    );

    saveEntityCommand.mockRejectedValueOnce(new Error("Offline"));
    await act(async () => {
      outcome = await result.current.ignore("idea");
    });
    expect(outcome).toBe(false);
    expect(result.current.error).toBe("Offline");

    saveEntityCommand.mockClear();
    await act(async () => {
      outcome = await result.current.ignore("missing");
    });
    expect(outcome).toBe(false);
    expect(saveEntityCommand).not.toHaveBeenCalled();
  });

  it("unignore puts each ignored proposal back to pending, and refuses one that is not ignored", async () => {
    state = {
      ...state,
      captures: [
        capture({ id: "a", status: "ignored", sourceType: "manual", version: 2 }),
        capture({ id: "b", status: "ignored", sourceType: "manual", version: 4 }),
        capture({ id: "c", status: "pending", sourceType: "manual" })
      ]
    };
    const { result } = renderHook(() => useProposalReview());
    await act(() => result.current.unignore(["a", "b"]));
    expect(saveEntityCommand).toHaveBeenCalledTimes(2);
    expect(saveEntityCommand).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ expectedVersion: 2, entity: expect.objectContaining({ id: "a", status: "pending" }) })
    );
    expect(saveEntityCommand).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ expectedVersion: 4, entity: expect.objectContaining({ id: "b", status: "pending" }) })
    );
    saveEntityCommand.mockClear();
    await expect(result.current.unignore(["c"])).rejects.toThrow("no longer ignored");
    expect(saveEntityCommand).not.toHaveBeenCalled();
  });

  describe("confirm", () => {
    const reviewable = () => {
      state = {
        ...state,
        captures: [
          capture({
            id: "cello",
            status: "pending",
            proposalType: "someday",
            proposedFields: { title: "Learn the cello" }
          })
        ]
      };
      return renderHook(() => useProposalReview());
    };

    it("hands the save to wrap after validation, and the save settles true", async () => {
      const { result } = reviewable();
      act(() => result.current.beginReview(state.captures[0]!));
      const wrap = vi.fn(async (_id: string, save: () => Promise<boolean>) => save());
      let outcome: boolean | undefined;
      await act(async () => {
        outcome = await result.current.confirm(false, wrap);
      });
      expect(wrap).toHaveBeenCalledWith("cello", expect.any(Function));
      expect(saveEntityCommand).toHaveBeenCalledTimes(1);
      expect(outcome).toBe(true);
      expect(result.current.reviewingId).toBeNull();
    });

    it("does not call wrap when nothing is open for review", async () => {
      const { result } = reviewable();
      const wrap = vi.fn(async (_id: string, save: () => Promise<boolean>) => save());
      let outcome: boolean | undefined;
      await act(async () => {
        outcome = await result.current.confirm(false, wrap);
      });
      expect(outcome).toBe(false);
      expect(wrap).not.toHaveBeenCalled();
    });

    it("drops a refusal's reason once the draft is edited", async () => {
      state = {
        ...state,
        projects: [],
        captures: [capture({ id: "loose", status: "pending", proposedFields: { title: "Loose thought" } })]
      };
      const { result } = renderHook(() => useProposalReview());
      act(() => result.current.beginReview(state.captures[0]!));
      await act(async () => {
        await result.current.confirm();
      });
      // With no project to preselect, the guessed task cannot go in until one is made.
      expect(result.current.error).toBe("Choose the project this action belongs to.");
      act(() => result.current.setDraft({ ...result.current.draft, proposalType: "someday" }));
      expect(result.current.error).toBe("");
    });

    it("opens an unsorted capture as a task in the last project used, so one confirm files it", async () => {
      const project = (id: string) => ({ ...state.projects[0]!, id, title: id, status: "active" as const });
      state = {
        ...state,
        projects: [project("old"), project("used")],
        captures: [
          capture({
            id: "earlier",
            proposedFields: { projectId: "used" },
            proposalType: "action",
            reviewedAt: "2026-08-10T00:00:00.000Z"
          }),
          capture({ id: "ink", status: "pending", text: "buy printer ink" })
        ]
      };
      const { result } = renderHook(() => useProposalReview());
      act(() => result.current.beginReview(state.captures[1]!));
      expect(result.current.draft).toMatchObject({
        proposalType: "action",
        projectId: "used",
        title: "buy printer ink"
      });
      await act(async () => {
        await result.current.confirm();
      });
      expect(saveEntityCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: expect.objectContaining({
            draft: expect.objectContaining({ proposalType: "action", projectId: "used" })
          })
        })
      );
    });

    it("opens a capture with a clock time as At a time", () => {
      state = { ...state, captures: [capture({ id: "dentist", status: "pending", text: "dentist tomorrow 9" })] };
      const { result } = renderHook(() => useProposalReview());
      act(() => result.current.beginReview(state.captures[0]!));
      expect(result.current.draft.proposalType).toBe("fixed_commitment");
    });

    it("refuses a capture left unsorted, naming what to choose", async () => {
      state = { ...state, captures: [capture({ id: "loose", status: "pending", text: "Loose thought" })] };
      const { result } = renderHook(() => useProposalReview());
      act(() => result.current.beginReview(state.captures[0]!));
      act(() => result.current.setDraft({ ...result.current.draft, proposalType: "unclassified" }));
      await act(async () => {
        await result.current.confirm();
      });
      expect(result.current.error).toBe("Choose what this item should become.");
      expect(saveEntityCommand).not.toHaveBeenCalled();
    });

    it("a refused save settles false and keeps the editor open with the reason", async () => {
      const { result } = reviewable();
      act(() => result.current.beginReview(state.captures[0]!));
      saveEntityCommand.mockRejectedValueOnce(new Error("Version changed"));
      let outcome: boolean | undefined;
      await act(async () => {
        outcome = await result.current.confirm(false, (_id, save) => save());
      });
      expect(outcome).toBe(false);
      expect(result.current.error).toBe("Version changed");
      expect(result.current.reviewingId).toBe("cello");
    });
  });
});
