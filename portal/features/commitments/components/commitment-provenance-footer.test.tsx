// @vitest-environment jsdom
import "@/test/example-calendar-sources";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test/render";
import { registerPortalExtension } from "@/state/portal-extensions";
import type { StoredCommitment } from "@/state/portal-state";
import { CommitmentProvenanceFooter } from "./commitment-provenance-footer";

registerPortalExtension({
  id: "example-provenance",
  provenanceLabel: (sourceType, title) => (sourceType === "example" ? `Added by ${title} from the example` : undefined)
});

const base: StoredCommitment = {
  id: "c1",
  version: 1,
  title: "Specialist appointment",
  startsAt: "2026-09-10T04:00:00.000Z",
  endsAt: "2026-09-10T05:00:00.000Z",
  status: "confirmed",
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0,
  routineSource: "inherit",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z"
};

/** The ledger rows `/api/changes?entityId=` answers with, newest first. */
let ledger: Record<string, unknown>[] = [];
beforeEach(() => {
  ledger = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(Response.json({ changes: ledger, cursor: null })))
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("CommitmentProvenanceFooter", () => {
  it("names the agent that added and last changed a record instead of saying it was entered by hand", async () => {
    ledger = [
      { actor: "lane-d-agent", imageTable: "commitments", inserted: false, afterVersion: 1 },
      { actor: "openclaw", imageTable: "commitments", inserted: true, afterVersion: 1 }
    ];
    render(<CommitmentProvenanceFooter commitment={base} timezone="Australia/Sydney" />);
    expect(await screen.findByText(/Added by the agent openclaw; no import owns this record\./)).toBeTruthy();
    expect(screen.getByText(/by the agent lane-d-agent\./)).toBeTruthy();
    expect(screen.queryByText(/Entered by hand/)).toBeNull();
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe("/api/changes?entityId=c1&limit=200&images=1");
  });

  it("says a hand-entered commitment has no owning import once the ledger shows no agent wrote it", async () => {
    render(<CommitmentProvenanceFooter commitment={base} timezone="Australia/Sydney" />);
    expect(await screen.findByText(/Entered by hand; no import owns this record\./)).toBeTruthy();
  });

  it("says only that no import owns it when an agent wrote it but the ledger kept no insert image", async () => {
    ledger = [{ actor: "openclaw" }];
    render(<CommitmentProvenanceFooter commitment={base} timezone="Australia/Sydney" />);
    expect(await screen.findByText("No import owns this record.")).toBeTruthy();
    expect(screen.queryByText(/Entered by hand/)).toBeNull();
  });

  it("names who a registered extension says added a commitment, without the generic 'Imported from' wording", () => {
    render(
      <CommitmentProvenanceFooter
        commitment={{ ...base, sourceType: "example", sourceTitle: "Mum" }}
        timezone="Australia/Sydney"
      />
    );
    expect(screen.getByText(/Added by Mum from the example\./)).toBeTruthy();
    expect(screen.queryByText(/Imported from/)).toBeNull();
  });

  it("still reads 'Imported from' for every other source type", () => {
    render(
      <CommitmentProvenanceFooter
        commitment={{ ...base, sourceType: "example_daily", sourceTitle: "ST ASSIST JNR CASUAL" }}
        timezone="Australia/Sydney"
      />
    );
    expect(screen.getByText(/Imported from the Example Daily roster/)).toBeTruthy();
  });
});
