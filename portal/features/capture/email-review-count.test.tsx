// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { render, screen } from "@/test/render";
import {
  describeEmailReviewCount,
  refreshEmailReviewCount,
  resetEmailReviewCount,
  useEmailReviewCount,
  useEmailReviewCountRefresh
} from "./email-review-count";
import { registerFakeMailSource } from "@/test/fake-mail-source";

// The core count only: the seam is stubbed empty, as it is in the OpenRhen export, and a stand-in mail source is registered.
vi.mock("@/state/private/index", () => ({}));
registerFakeMailSource();

const respond = (body: unknown, ok = true) => vi.fn(() => Promise.resolve({ ok, json: () => Promise.resolve(body) }));

function Probe() {
  useEmailReviewCountRefresh();
  const count = useEmailReviewCount();
  return <p>{`waiting ${count.waiting} review ${count.toReview}`}</p>;
}

beforeEach(() => resetEmailReviewCount());
afterEach(() => vi.unstubAllGlobals());

describe("email review count", () => {
  it("reads both numbers", async () => {
    vi.stubGlobal("fetch", respond({ waiting: 3, toReview: 12 }));
    render(<Probe />);
    expect(await screen.findByText("waiting 3 review 12")).toBeTruthy();
  });

  it("keeps the last known count when a refresh fails or the body is junk", async () => {
    vi.stubGlobal("fetch", respond({ waiting: 2, toReview: 1 }));
    render(<Probe />);
    await screen.findByText("waiting 2 review 1");
    vi.stubGlobal("fetch", respond({ error: "down" }, false));
    await refreshEmailReviewCount();
    expect(screen.getByText("waiting 2 review 1")).toBeTruthy();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline")))
    );
    await refreshEmailReviewCount();
    expect(screen.getByText("waiting 2 review 1")).toBeTruthy();
  });

  it("queues exactly one follow-up read when a refresh is requested while one is in flight", async () => {
    const reads: Array<(body: unknown) => void> = [];
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          reads.push((body) => resolve({ ok: true, json: () => Promise.resolve(body) }));
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<Probe />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Three requests while the first read (a snapshot from before the change) is still out.
    const settled = Promise.all([refreshEmailReviewCount(), refreshEmailReviewCount(), refreshEmailReviewCount()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    reads[0]!({ waiting: 0, toReview: 0 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    reads[1]!({ waiting: 0, toReview: 3 });
    await settled;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("waiting 0 review 3")).toBeTruthy();
  });

  it("treats negative and non-numeric values as zero", async () => {
    vi.stubGlobal("fetch", respond({ waiting: -4, toReview: "many" }));
    render(<Probe />);
    expect(await screen.findByText("waiting 0 review 0")).toBeTruthy();
  });

  it("describes both counts, leaving out a zero part", () => {
    expect(describeEmailReviewCount({ waiting: 3, toReview: 12 })).toBe("3 waiting · 12 to review");
    expect(describeEmailReviewCount({ waiting: 0, toReview: 12 })).toBe("12 to review");
    expect(describeEmailReviewCount({ waiting: 3, toReview: 0 })).toBe("3 waiting");
    expect(describeEmailReviewCount({ waiting: 0, toReview: 0 })).toBe("");
  });
});
