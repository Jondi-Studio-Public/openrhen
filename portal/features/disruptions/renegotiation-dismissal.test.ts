// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { displacedSignature, isDismissed, writeDismissal } from "./renegotiation-dismissal";

beforeEach(() => {
  window.localStorage.clear();
});

describe("displacedSignature", () => {
  it("is order-independent", () => {
    expect(displacedSignature(["b", "a"])).toBe(displacedSignature(["a", "b"]));
  });

  it("is empty for an empty set", () => {
    expect(displacedSignature([])).toBe("");
  });

  it("differs when the set differs", () => {
    expect(displacedSignature(["a"])).not.toBe(displacedSignature(["a", "b"]));
  });
});

describe("isDismissed / writeDismissal", () => {
  it("is not dismissed before anything is written", () => {
    expect(isDismissed("disruption-1", displacedSignature(["a"]))).toBe(false);
  });

  it("is dismissed for the exact disruption and signature that was written", () => {
    writeDismissal("disruption-1", displacedSignature(["a", "b"]));
    expect(isDismissed("disruption-1", displacedSignature(["b", "a"]))).toBe(true);
  });

  it("re-arms when the signature changes, even for the same disruption", () => {
    writeDismissal("disruption-1", displacedSignature(["a"]));
    expect(isDismissed("disruption-1", displacedSignature(["a", "b"]))).toBe(false);
  });

  it("does not carry a dismissal over to a different disruption", () => {
    writeDismissal("disruption-1", displacedSignature(["a"]));
    expect(isDismissed("disruption-2", displacedSignature(["a"]))).toBe(false);
  });

  it("tolerates corrupted storage rather than throwing", () => {
    window.localStorage.setItem("openrhen.disruption-dismissal", "{not json");
    expect(isDismissed("disruption-1", "")).toBe(false);
  });
});
