import { describe, expect, it } from "vitest";
import { energyLabel, parseEstimateBuckets } from "@/features/settings/settings-format";

describe("settings formatting", () => {
  it("names each energy level in the words the settings form uses", () => {
    expect(energyLabel("high")).toBe("High focus");
    expect(energyLabel("recovery")).toBe("Recovery");
  });

  it("reads estimate buckets typed with either commas or spaces", () => {
    expect(parseEstimateBuckets("5, 15  30,,60")).toEqual([5, 15, 30, 60]);
    expect(parseEstimateBuckets("   ")).toEqual([]);
  });
});
