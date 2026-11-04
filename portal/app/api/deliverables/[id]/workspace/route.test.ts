import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSeedState, type PortalState, type StoredDeliverable } from "@/state/portal-state";
import { criterion, deliverable, step } from "@/features/deliverables/test-fixtures";
import {
  CommandConflictError,
  CommandIdReusedError,
  CommittedReadFailedError
} from "@/server/persistence/postgres/command-errors";

const holder = vi.hoisted(() => ({
  current: null as PortalState | null,
  saveEntity: vi.fn(),
  hasSnapshot: vi.fn(async (_commandId: string) => true),
  hasCommandReceiptFor: vi.fn(async (_receipt: object) => false)
}));

vi.mock("@/server/persistence/state-store", () => ({
  getStateStore: () => ({
    get: async () => holder.current,
    saveEntity: holder.saveEntity,
    hasSnapshot: holder.hasSnapshot,
    hasCommandReceiptFor: holder.hasCommandReceiptFor
  })
}));

import { AGENT_HEADER } from "@/server/agent-actor";
import { POST } from "./route";

function post(id: string, call: unknown, commandId?: string, headers: Record<string, string> = {}) {
  return POST(new Request("http://x", { method: "POST", headers, body: JSON.stringify({ call, commandId }) }), {
    params: Promise.resolve({ id })
  });
}

describe("POST /api/deliverables/[id]/workspace", () => {
  beforeEach(() => {
    holder.saveEntity.mockReset();
    holder.saveEntity.mockImplementation(async (command: { entity: StoredDeliverable }) => {
      const previous = holder.current!.deliverables.find((item) => item.id === command.entity.id)!;
      const saved = { ...command.entity, version: (previous.version ?? 0) + 1 };
      holder.current = {
        ...holder.current!,
        deliverables: holder.current!.deliverables.map((item) => (item.id === saved.id ? saved : item))
      };
      return holder.current;
    });
    const plannedStep = step("model", { title: "Create three part models" });
    const completionCriterion = criterion("models", {
      title: "Three required models completed",
      stepIds: [plannedStep.id]
    });
    const fixture = deliverable({ status: "needs_breakdown", criteria: [completionCriterion], steps: [plannedStep] });
    const { contractApprovedAt: _contract, planApprovedAt: _plan, ...breakdown } = fixture;
    holder.current = { ...createSeedState(new Date("2026-08-25T00:00:00.000Z")), deliverables: [breakdown] };
  });

  it("applies a move without requiring a running session and reports applied:true", async () => {
    const response = await post("assessment-2", { name: "start_carry_out", approvalNote: null });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ applied: true, summary: expect.stringContaining("the work can start") });
    expect(body.deliverable).toMatchObject({ status: "ready" });
  });

  it("saves under the caller's command id and answers revertible for an agent", async () => {
    const response = await post("assessment-2", { name: "start_carry_out", approvalNote: null }, "move-1", {
      [AGENT_HEADER]: "claude"
    });
    expect(holder.saveEntity).toHaveBeenCalledWith(expect.objectContaining({ commandId: "move-1" }));
    expect((await response.json()).revertible).toBe("move-1");
  });

  it("replays a move whose command id already has a receipt, instead of calling it stale", async () => {
    holder.hasCommandReceiptFor.mockResolvedValueOnce(true);
    const response = await post("assessment-2", { name: "begin_review" }, "move-3", { [AGENT_HEADER]: "claude" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ applied: true, replayed: true, revertible: "move-3" });
    expect(holder.hasCommandReceiptFor).toHaveBeenCalledWith(
      expect.objectContaining({ id: "move-3", commandType: "deliverable", requestHash: expect.any(String) })
    );
    expect(holder.saveEntity).not.toHaveBeenCalled();
  });

  it("answers 409 when the command id belongs to a different write, and applies nothing", async () => {
    holder.hasCommandReceiptFor.mockRejectedValueOnce(new CommandIdReusedError("used"));
    const response = await post("assessment-2", { name: "begin_review" }, "move-6");
    expect(response.status).toBe(409);
    expect(holder.saveEntity).not.toHaveBeenCalled();
  });

  it("lets a reused command id answer 409 and a lost read-back answer 503 committed, not a plain 400", async () => {
    const call = { name: "start_carry_out", approvalNote: null };
    holder.saveEntity.mockRejectedValueOnce(new CommandIdReusedError("used"));
    expect((await post("assessment-2", call, "move-4")).status).toBe(409);
    holder.saveEntity.mockRejectedValueOnce(new CommittedReadFailedError());
    const lost = await post("assessment-2", call, "move-5");
    expect(lost.status).toBe(503);
    expect(await lost.json()).toMatchObject({ committed: true, retryable: true });
  });

  it("answers no revertible for the person's own move", async () => {
    const response = await post("assessment-2", { name: "start_carry_out", approvalNote: null }, "move-2");
    expect(holder.saveEntity).toHaveBeenCalledWith(expect.objectContaining({ commandId: "move-2" }));
    expect((await response.json()).revertible).toBeUndefined();
  });

  it("reports applied:false when the same blocker is recorded twice", async () => {
    const call = {
      name: "record_blocker",
      report: { description: "Waiting for the teacher.", category: "waiting_on_someone", stepTitles: [] }
    };
    await post("assessment-2", call);
    const response = await post("assessment-2", call);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.applied).toBe(false);
  });

  it("400s with the business error message for a stale-phase call", async () => {
    // The fixture is still in Breakdown (no contractApprovedAt/planApprovedAt), so begin_review — which
    // is only valid in Carry out — is refused as stale.
    const response = await post("assessment-2", { name: "begin_review" });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("nothing was changed");
  });

  it("400s summarising a schema validation failure for an unknown move name", async () => {
    const response = await post("assessment-2", { name: "not_a_real_move" });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });

  it("404s for an unknown deliverable", async () => {
    const response = await post("missing", { name: "begin_review" });
    expect(response.status).toBe(404);
  });

  it("applies submit_for_result once the required step is done, moving the deliverable to awaiting_result", async () => {
    holder.current!.deliverables[0] = {
      ...holder.current!.deliverables[0]!,
      contractApprovedAt: "2026-08-17T00:00:00.000Z",
      planApprovedAt: "2026-08-17T00:00:00.000Z",
      status: "in_progress",
      steps: holder.current!.deliverables[0]!.steps.map((item) => ({ ...item, status: "done" as const }))
    };
    const response = await post("assessment-2", {
      name: "submit_for_result",
      submission: { waitingFor: "the teacher to mark it", category: "waiting_on_someone" }
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.applied).toBe(true);
    expect(body.deliverable).toMatchObject({ status: "awaiting_result" });
    expect(body.deliverable.submittedAt).toBeTruthy();
    expect(body.deliverable.blockers[0]).toMatchObject({ stepIds: [] });
  });

  it("maps a version conflict from the underlying save to 409", async () => {
    holder.current!.deliverables[0] = {
      ...holder.current!.deliverables[0]!,
      contractApprovedAt: "2026-08-17T00:00:00.000Z",
      planApprovedAt: "2026-08-17T00:00:00.000Z",
      status: "in_progress"
    };
    holder.saveEntity.mockImplementationOnce(async () => {
      throw new CommandConflictError("This record changed elsewhere. Reload before saving.");
    });
    const response = await post("assessment-2", {
      name: "mark_steps_complete",
      completion: { stepTitles: ["Create three part models"], evidenceNote: "Done." }
    });
    expect(response.status).toBe(409);
  });
});
