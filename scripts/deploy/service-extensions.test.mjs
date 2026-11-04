import assert from "node:assert/strict";
import { test } from "node:test";
import { deployServiceExtensions, registerDeployService } from "./service-extensions.mjs";

// This file never loads private/index.mjs, so it sees the registry as the OpenRhen export does: empty until a
// service registers itself.
test("a build with no extension has no extra deploy service", () => {
  assert.deepEqual(deployServiceExtensions(), []);
});

test("a registered service is listed once", () => {
  registerDeployService({ service: "demo", dependsOn: ["migrate"], secrets: ["DEMO_URL"], builds: true });
  registerDeployService({ service: "demo", dependsOn: [], secrets: [], builds: false });
  assert.deepEqual(
    deployServiceExtensions().map((entry) => entry.service),
    ["demo"]
  );
});
