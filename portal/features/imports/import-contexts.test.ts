import { describe, expect, it } from "vitest";
import { mergeImportContextOptions } from "./import-contexts";

describe("import context choices", () => {
  it("keeps CSV contexts visible even when they are not yet in the saved catalogue", () => {
    expect(mergeImportContextOptions(["home", "laptop", "phone"], ["phone", "online"])).toEqual([
      "home",
      "laptop",
      "phone",
      "online"
    ]);
  });

  it("removes blank and duplicate context choices", () => {
    expect(mergeImportContextOptions(["home", " home "], ["", "home"])).toEqual(["home"]);
  });
});
