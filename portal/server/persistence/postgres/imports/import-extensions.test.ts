import { describe, expect, it } from "vitest";
import {
  extensionLinkImportKey,
  extensionOfLinkSource,
  extensionSentenceLabel,
  extensionSourceTypeOf,
  importExtensions,
  isExtensionSourceType,
  registerImportExtension
} from "./import-extensions";

// With nothing registered (the OpenRhen export) the import commit sees no extension; a registered one is found by
// the provider its link source names.
describe("import extensions", () => {
  it("finds nothing until an extension registers", () => {
    expect(importExtensions()).toEqual([]);
    expect(isExtensionSourceType("example")).toBe(false);
    expect(extensionOfLinkSource({ provider: "example" })).toBeUndefined();
    expect(extensionOfLinkSource(undefined)).toBeUndefined();
    expect(extensionSentenceLabel("example")).toBeUndefined();
    expect(extensionLinkImportKey("example", "f", "e")).toBeNull();
    expect(extensionSourceTypeOf("example")).toBeUndefined();
  });

  it("resolves a registered extension by its provider, once per id", () => {
    const extension = {
      id: "example",
      sourceTypes: ["example"],
      sentenceLabels: { example: "the example" },
      linkImportKey: (_provider: string, frame: string, event: string) => `example:${frame}:${event}`
    };
    registerImportExtension(extension);
    registerImportExtension(extension);
    expect(importExtensions()).toHaveLength(1);
    expect(extensionOfLinkSource({ provider: "example" })).toBe(extension);
    expect(extensionSentenceLabel("example")).toBe("the example");
    expect(extensionLinkImportKey("example", "f", "e")).toBe("example:f:e");
    expect(extensionSourceTypeOf("example")).toBe("example");
  });
});
