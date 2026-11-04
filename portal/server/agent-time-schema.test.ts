import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { agentSessionJsonSchema } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";

describe("the published agent-sessions JSON Schema", () => {
  it("is the file in platform/contracts, so client authors and the portal validate the same thing", () => {
    const file = fileURLToPath(new URL("../../platform/contracts/agent-time-schema.v1.json", import.meta.url));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(JSON.parse(JSON.stringify(agentSessionJsonSchema())));
  });
});
