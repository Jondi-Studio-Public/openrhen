import { withRoute } from "@/server/logging";

/** An API route the example add-on serves at /api/example-addon/hello. Fake data only. */
export const GET = withRoute("/api/example-addon/hello", () =>
  Response.json({ greeting: "hello", source: "example-addon" })
);
