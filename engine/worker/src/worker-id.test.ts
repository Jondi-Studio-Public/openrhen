import { describe, expect, it } from "vitest";
import { createWorkerId } from "./worker-id";

describe("createWorkerId", () => {
  it("differs between two containers that both run as PID 1", () => {
    expect(createWorkerId(1, "container-a", "aaaaaaaa")).not.toBe(createWorkerId(1, "container-b", "aaaaaaaa"));
  });
  it("differs between restarts of the same container and pid", () => {
    expect(createWorkerId(1, "container-a")).not.toBe(createWorkerId(1, "container-a"));
  });
  it("keeps the prefix the logs and lease checks recognise", () => {
    expect(createWorkerId(7, "h", "abc")).toBe("plan-forecast-worker-h-7-abc");
  });
});
