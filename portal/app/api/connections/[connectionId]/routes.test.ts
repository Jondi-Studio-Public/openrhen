import "@/test/example-calendar-sources";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/connections/route-handlers", () => {
  const make = (name: string) => vi.fn(async (id: string) => Response.json({ name, id }));
  return {
    syncPostHandler: make("syncPost"),
    syncGetHandler: make("syncGet"),
    proofGetHandler: make("proofGet"),
    calendarsGetHandler: make("calendarsGet"),
    calendarsPutHandler: make("calendarsPut"),
    publishPostHandler: make("publishPost"),
    publishGetHandler: make("publishGet"),
    publishRemoveHandler: make("publishRemove"),
    writeProofPostHandler: make("writeProof"),
    importPreviewHandler: make("importPreview")
  };
});

const ctx = (connectionId: string) => ({ params: Promise.resolve({ connectionId }) });
const req = () => new Request("http://portal.test/x", { method: "POST" });

describe("the dynamic connection routes answer through the shared handlers", () => {
  it("sync, proof and calendars", async () => {
    const sync = await import("./sync/route");
    const proof = await import("./proof/route");
    const calendars = await import("./calendars/route");
    const body = async (r: Response) => r.json();
    expect(await body(await sync.POST(req(), ctx("example_shared")))).toEqual({
      name: "syncPost",
      id: "example_shared"
    });
    expect(await body(await sync.GET(req(), ctx("example_daily")))).toEqual({ name: "syncGet", id: "example_daily" });
    expect(await body(await proof.GET(req(), ctx("google_calendar")))).toEqual({
      name: "proofGet",
      id: "google_calendar"
    });
    expect(await body(await calendars.PUT(req(), ctx("google_calendar")))).toEqual({
      name: "calendarsPut",
      id: "google_calendar"
    });
  });

  it("publish, publish/remove, write-proof and import/preview", async () => {
    const publish = await import("./publish/route");
    const remove = await import("./publish/remove/route");
    const writeProof = await import("./write-proof/route");
    const preview = await import("./import/preview/route");
    const body = async (r: Response) => r.json();
    const pairs: [Response, string][] = [
      [await publish.POST(req(), ctx("example_shared")), "publishPost"],
      [await publish.GET(req(), ctx("example_shared")), "publishGet"],
      [await remove.POST(req(), ctx("example_shared")), "publishRemove"],
      [await writeProof.POST(req(), ctx("example_shared")), "writeProof"],
      [await preview.POST(req(), ctx("example_shared")), "importPreview"]
    ];
    for (const [fresh, name] of pairs) {
      expect(await body(fresh)).toEqual({ name, id: "example_shared" });
    }
  });
});
