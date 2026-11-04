import { describe, expect, it } from "vitest";
import { joinDashValues, parseCommandArgs, type CommandSpec } from "../src/command.js";

const spec: CommandSpec = {
  name: "probe",
  summary: "",
  description: "",
  positionals: [],
  options: {
    sort: { type: "string", description: "" },
    since: { type: "string", description: "" },
    verbose: { type: "boolean", short: "v", description: "" }
  },
  mutates: false,
  examples: [],
  run: async () => undefined
};

describe("joinDashValues", () => {
  const options = { sort: { type: "string" as const }, verbose: { type: "boolean" as const, short: "v" } };

  it("folds a dash-led value into the option that precedes it", () => {
    expect(joinDashValues(["--sort", "-deadlineAt", "x"], options)).toEqual(["--sort=-deadlineAt", "x"]);
  });

  it("leaves a following known option alone", () => {
    expect(joinDashValues(["--sort", "--verbose"], options)).toEqual(["--sort", "--verbose"]);
    expect(joinDashValues(["--sort", "-v"], options)).toEqual(["--sort", "-v"]);
  });

  it("does not fold values for boolean options or after the -- separator", () => {
    expect(joinDashValues(["--verbose", "-x"], options)).toEqual(["--verbose", "-x"]);
    expect(joinDashValues(["--", "--sort", "-x"], options)).toEqual(["--", "--sort", "-x"]);
  });
});

describe("parseCommandArgs", () => {
  it("accepts a negative sort and a negative relative time without an equals sign", () => {
    const parsed = parseCommandArgs(spec, ["actions", "--sort", "-deadlineAt", "--since", "-7d"]);
    expect(parsed.positionals).toEqual(["actions"]);
    expect(parsed.values.sort).toBe("-deadlineAt");
    expect(parsed.values.since).toBe("-7d");
  });

  it("still refuses an option nobody declared", () => {
    expect(() => parseCommandArgs(spec, ["--nope"])).toThrow(/help probe/);
  });
});
