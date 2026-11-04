import { connectionManifestSchema } from "@openrhen/contracts";

/** A manifest for host tests; not a registry member. */
export function fakeManifest(id = "fake_conn", secrets: string[][] = [["FAKE_KEY"]]) {
  return connectionManifestSchema.parse({
    id,
    label: "Fake",
    capabilities: ["travel_time"],
    secrets: { anyOf: secrets },
    config: {}
  });
}
