// The example add-on's contracts extension. This file replaces the empty single-slot stub core ships; a real
// deployment lists every extension it has here. Fake data only.
import { registerContractsExtension } from "../extensions.js";

registerContractsExtension({
  id: "example-addon",
  knownScopes: ["read:example-addon"],
  routes: { readRules: { "/api/example-addon/hello": "read:example-addon" } }
});
