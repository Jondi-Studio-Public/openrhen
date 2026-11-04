import { describe, expect, it } from "vitest";
import { addonNavFolders, registerAddonNav } from "./addon-nav";
import { destinations } from "./app-nav-tabs";
import { withExtensionDestinations, withExtensionOwnership } from "./nav-extensions";

describe("add-on navigation", () => {
  it("finds no add-on folder in the stock tree, so the core navigation is unchanged", () => {
    expect(addonNavFolders).toEqual([]);
    expect(destinations.some((destination) => destination.href.startsWith("/example-addon"))).toBe(false);
  });

  it("registers each nav.ts default export as a navigation extension", () => {
    registerAddonNav({
      "../app/(addon)/example-addon/nav.ts": {
        default: {
          id: "example-addon-test",
          destinations: [
            {
              after: "/you",
              items: [{ href: "/example-addon", label: "Example", where: "You", keywords: "example addon" }]
            }
          ],
          ownership: [["you", "/example-addon"]]
        }
      }
    });
    const list = withExtensionDestinations([{ href: "/you", label: "You", where: "You" }]);
    expect(list.map((destination) => destination.href)).toEqual(["/you", "/example-addon"]);
    expect(withExtensionOwnership([]).some(([tab, prefix]) => tab === "you" && prefix === "/example-addon")).toBe(true);
  });

  it("names the add-on folder that holds a nav.ts, and skips a file with no default export", () => {
    expect(
      registerAddonNav({
        "../app/(addon)/notes/nav.ts": { default: { id: "notes-test" } },
        "../app/(addon)/api/empty/nav.ts": {}
      })
    ).toEqual(["notes"]);
  });

  it("registers the same id once", () => {
    const module = { default: { id: "twice", ownership: [["you", "/twice-a"]] as const } };
    registerAddonNav({ "../app/(addon)/twice/nav.ts": module });
    registerAddonNav({
      "../app/(addon)/twice/nav.ts": { default: { id: "twice", ownership: [["you", "/twice-b"]] as const } }
    });
    const prefixes = withExtensionOwnership([]).map(([, prefix]) => prefix);
    expect(prefixes).toContain("/twice-a");
    expect(prefixes).not.toContain("/twice-b");
  });
});
