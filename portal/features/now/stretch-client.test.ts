import { afterEach, describe, expect, it, vi } from "vitest";
import { StretchRefusedError, postStretch } from "./stretch-client";

afterEach(() => vi.unstubAllGlobals());

const reply = (status: number, body: unknown) =>
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })));

describe("postStretch", () => {
  it("turns a refusal into a person-facing error, never the agent-directed text", async () => {
    reply(409, {
      error: "There is no stretch offer now. Nothing was changed. Next: call rhen_status; tell the person..."
    });
    const failure = await postStretch({ choice: "accept", actionId: "a" }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(StretchRefusedError);
    expect((failure as Error).message).toBe("That stretch is no longer on offer.");
  });

  it("keeps other failures short and free of server text", async () => {
    reply(500, { error: "The request failed." });
    const failure = await postStretch({ choice: "decline_all" }).catch((e: unknown) => e);
    expect(failure).not.toBeInstanceOf(StretchRefusedError);
    expect((failure as Error).message).toBe("That answer was not saved. Try again.");
  });
});
