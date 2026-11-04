// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ImportBatch } from "@openrhen/contracts";
import type { PortalState } from "@/state/portal-state";
import type { ImportStatus } from "./use-import-status";

const commitImportBatch = vi.fn();
vi.mock("@/features/imports/import-requests", () => ({
  commitImportBatch: (batch: ImportBatch) => commitImportBatch(batch),
  commitReadyImportBatch: vi.fn(),
  saveImportDraft: vi.fn()
}));

import { useImportCommit } from "./use-import-commit";

describe("useImportCommit", () => {
  it("says the recalculation is under way, not finished, once a commit lands (S10-11)", async () => {
    const batch = { records: [{ removed: false, operation: "create" }] } as unknown as ImportBatch;
    commitImportBatch.mockResolvedValue({ state: {} as PortalState, batch });
    const setSuccess = vi.fn();
    const status = {
      run: async (_failure: string, action: () => Promise<void>) => action(),
      setSuccess,
      setNotice: vi.fn()
    } as unknown as ImportStatus;
    const acceptServerState = vi.fn();
    const { result } = renderHook(() =>
      useImportCommit({
        batch,
        status,
        acceptServerState,
        receiveBatch: vi.fn(),
        reconcileQueue: vi.fn(),
        afterCommit: vi.fn()
      })
    );
    await result.current.commit();
    expect(acceptServerState).toHaveBeenCalledTimes(1);
    const { message } = setSuccess.mock.calls[0]![0] as { message: string };
    expect(message).toMatch(/being recalculated/);
    expect(message).not.toMatch(/have been recalculated/);
  });
});
