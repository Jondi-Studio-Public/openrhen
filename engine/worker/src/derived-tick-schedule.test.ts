import { describe, expect, it } from "vitest";
import {
  DERIVED_TICK_BUSY_MS,
  DERIVED_TICK_FAILED_MS,
  DERIVED_TICK_IDLE_MS,
  DERIVED_TICK_MORE_MS,
  WORK_LABEL_TICK_IDLE_MS,
  derivedTickDelayMs,
  workLabelTickDelayMs
} from "./derived-tick-schedule.js";

describe("derivedTickDelayMs", () => {
  it("goes again at once when the last run filled a batch", () => {
    expect(derivedTickDelayMs({ ok: true, body: { status: "ok", more: true } })).toBe(DERIVED_TICK_MORE_MS);
  });

  it("waits the idle interval when the run finished everything", () => {
    expect(derivedTickDelayMs({ ok: true, body: { status: "ok", more: false } })).toBe(DERIVED_TICK_IDLE_MS);
  });

  it("looks again soon when another run held the lock", () => {
    expect(derivedTickDelayMs({ ok: true, body: { status: "busy" } })).toBe(DERIVED_TICK_BUSY_MS);
  });

  it("backs off after a failed request, whatever the body says", () => {
    expect(derivedTickDelayMs({ ok: false, body: { status: "ok", more: true } })).toBe(DERIVED_TICK_FAILED_MS);
    expect(derivedTickDelayMs({ ok: false, body: null })).toBe(DERIVED_TICK_FAILED_MS);
  });

  it("falls back to the idle interval for a body it does not know", () => {
    for (const body of [null, "x", {}, { status: "skipped", reason: "no_database" }, { status: "ok" }])
      expect(derivedTickDelayMs({ ok: true, body }), JSON.stringify(body)).toBe(DERIVED_TICK_IDLE_MS);
  });

  it("paces the model tick the same way: at once while it fills batches, idle for no_extractors and for a paused circuit", () => {
    expect(derivedTickDelayMs({ ok: true, body: { status: "ok", more: true, extractors: [{ status: "ok" }] } })).toBe(
      DERIVED_TICK_MORE_MS
    );
    for (const status of ["no_extractors", "ok"])
      expect(derivedTickDelayMs({ ok: true, body: { status, more: false } }), status).toBe(DERIVED_TICK_IDLE_MS);
    expect(derivedTickDelayMs({ ok: true, body: { status: "busy" } })).toBe(DERIVED_TICK_BUSY_MS);
  });

  it("never asks for a pause of more than a minute or less than a second", () => {
    for (const ms of [DERIVED_TICK_IDLE_MS, DERIVED_TICK_MORE_MS, DERIVED_TICK_BUSY_MS, DERIVED_TICK_FAILED_MS]) {
      expect(ms).toBeGreaterThanOrEqual(1_000);
      expect(ms).toBeLessThanOrEqual(60_000);
    }
  });
});

describe("workLabelTickDelayMs", () => {
  it("comes back soon when another area waits, or the store was busy", () => {
    expect(workLabelTickDelayMs({ ok: true, body: { status: "ok", more: true } })).toBe(DERIVED_TICK_MORE_MS * 5);
    expect(workLabelTickDelayMs({ ok: true, body: { status: "discarded", more: true } })).toBe(
      DERIVED_TICK_MORE_MS * 5
    );
    expect(workLabelTickDelayMs({ ok: true, body: { status: "busy" } })).toBe(DERIVED_TICK_BUSY_MS);
  });

  it("takes the slow pace when idle, unconfigured, failed, or the request failed", () => {
    for (const body of [
      null,
      { status: "idle", more: false },
      { status: "not_configured" },
      { status: "failed", more: true }
    ])
      expect(workLabelTickDelayMs({ ok: true, body }), JSON.stringify(body)).toBe(WORK_LABEL_TICK_IDLE_MS);
    expect(workLabelTickDelayMs({ ok: false, body: { status: "ok", more: true } })).toBe(WORK_LABEL_TICK_IDLE_MS);
  });
});
