import { existsSync, readFileSync } from "node:fs";
import { MCP_SERVER_INSTRUCTIONS, MCP_TOOL_MANIFEST } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { guideTopicsFor } from "../src/guide-content.js";
import { skillTextFor } from "../src/skill-content.js";

/**
 * The served-text contract of the archive and cancel tools (archive-removals design 8a). The expectations are typed
 * here by hand from the design's section 1 table and are NOT read from the vocabulary module, so a wrong table in
 * both places cannot pass. Each served home must say which verb takes which kind, how to restore, that a status
 * written through rhen_save is not the way, and that a big call is a proposal.
 */

/** The kinds in the words a person says, per verb (design section 1). */
const ARCHIVE_WORDS = [
  "area",
  "preset",
  "place",
  "contact",
  "capability",
  "live",
  "outcome",
  "project",
  "action",
  "deliverable"
];
const CANCEL_WORDS = ["appointment", "shift", "event", "outcome", "project", "action", "deliverable"];
/** The type enum values each tool takes. */
const ARCHIVE_ENUM = ["area", "outcome", "project", "action", "deliverable", "routine_preset", "condition_definition"];
const CANCEL_ENUM = ["area", "outcome", "project", "action", "deliverable", "commitment"];

const pluginSkill = new URL("../../../integrations/openclaw-plugin/skills/openrhen/SKILL.md", import.meta.url);
const pluginWriting = new URL(
  "../../../integrations/openclaw-plugin/skills/openrhen-writing/SKILL.md",
  import.meta.url
);

const homes: { name: string; text: string }[] = [
  { name: "remote skill", text: skillTextFor("remote") },
  { name: "stdio skill", text: skillTextFor("stdio") },
  {
    name: "remote guide writing-data",
    text: guideTopicsFor("remote").find((topic) => topic.name === "writing-data")!.text
  },
  {
    name: "stdio guide writing-data",
    text: guideTopicsFor("stdio").find((topic) => topic.name === "writing-data")!.text
  },
  { name: "server instructions", text: MCP_SERVER_INSTRUCTIONS },
  ...(existsSync(pluginSkill) ? [{ name: "plugin skill", text: readFileSync(pluginSkill, "utf8") }] : [])
];

/** What follows "Archive:" up to "Cancel:", and the sentence after "Cancel:". */
function halves(text: string): { archive: string; cancel: string } {
  const archiveAt = text.search(/archive:/i);
  const cancelAt = text.search(/cancel:/i);
  expect(archiveAt, "has an Archive: list").toBeGreaterThanOrEqual(0);
  expect(cancelAt, "has a Cancel: list").toBeGreaterThan(archiveAt);
  const rest = text.slice(cancelAt);
  const end = rest.search(/\n|\. [A-Z]/);
  return { archive: text.slice(archiveAt, cancelAt), cancel: end < 0 ? rest : rest.slice(0, end) };
}

describe("every served home says which verb takes which kind", () => {
  for (const { name, text } of homes) {
    it(name, () => {
      const { archive, cancel } = halves(text);
      for (const word of ARCHIVE_WORDS) expect(archive.toLowerCase(), `archive ${word}`).toContain(word);
      for (const word of CANCEL_WORDS) expect(cancel.toLowerCase(), `cancel ${word}`).toContain(word);
      // The kinds that are not archived are not in the archive list, and the other way round.
      expect(archive.toLowerCase()).not.toMatch(/appointment|shift/);
      expect(cancel.toLowerCase()).not.toMatch(/\bpreset\b|\bplace\b|\bcontact\b|capability/);
      expect(text).toContain("rhen_archive");
      expect(text).toContain("rhen_cancel");
      expect(text).toMatch(/restore/i);
      // The save floor is shipped: a save that closes a row is refused, and the text says so (never "do not").
      expect(text).toMatch(/A save that sets status archived or cancelled is refused/);
      expect(text).not.toMatch(/Never set status archived or cancelled|Do not set status archived or cancelled/);
      // The brake, worded as the stateless rolling hour it is (design section 4).
      expect(text).toMatch(/rolling hour/);
      expect(text).toMatch(/counting (this|the) call/);
    });
  }

  it("the prose homes (not the byte-capped instructions) also say reason, 20 rows, the hour, a day and one proposal", () => {
    for (const { name, text } of homes.filter((home) => home.name !== "server instructions")) {
      expect(text, name).toMatch(/reason/i);
      expect(text, name).toMatch(/more than 20 rows in one call/);
      expect(text, name).toMatch(/20 closures in a rolling hour/);
      expect(text, name).toMatch(/small calls that still fit/);
      expect(text, name).toMatch(/rhen_undo.*within a day/);
      expect(text, name).toMatch(/ONE proposal/);
      expect(text, name).toMatch(/include-children/);
    }
  });

  it("nothing still says status is how a record is removed", () => {
    const writing = existsSync(pluginWriting)
      ? [{ name: "plugin writing skill", text: readFileSync(pluginWriting, "utf8") }]
      : [];
    for (const { name, text } of [...homes, ...writing]) {
      expect(text, name).not.toMatch(
        /Removal is a status change|Removing is a status change|removal is a status change/
      );
      expect(text, name).not.toMatch(/end a record by status/i);
    }
  });

  it("rhen_help is named only in the stdio texts", () => {
    for (const { name, text } of homes.filter((home) => /remote|instructions/.test(home.name)))
      expect(text, name).not.toContain("rhen_help");
  });
});

describe("each tool's description repeats its half and names the other tool", () => {
  const tool = (name: string) => MCP_TOOL_MANIFEST.find((entry) => entry.name === name)!;

  it("rhen_archive names the other tool and each kind it takes", () => {
    const entry = tool("rhen_archive");
    expect(entry.description).toContain("rhen_cancel");
    expect(entry.description).toContain("rhen_save");
    expect(entry.description).toMatch(/is refused/);
    expect(entry.description).toMatch(/rolling hour/);
    for (const word of [
      "area",
      "routine_preset",
      "condition_definition",
      "outcome",
      "project",
      "action",
      "deliverable"
    ])
      expect(entry.description, word).toContain(word);
    expect(entry.description).not.toMatch(/commitment \(/);
    const type = (entry.inputSchema.properties.type as { enum?: string[] }).enum;
    expect([...(type ?? [])].sort()).toEqual([...ARCHIVE_ENUM].sort());
  });

  it("rhen_cancel names the other tool and each kind it takes", () => {
    const entry = tool("rhen_cancel");
    expect(entry.description).toContain("rhen_archive");
    expect(entry.description).toContain("rhen_save");
    expect(entry.description).toMatch(/is refused/);
    expect(entry.description).toMatch(/rolling hour/);
    for (const word of ["commitment", "appointment", "outcome", "project", "action", "deliverable"])
      expect(entry.description, word).toContain(word);
    const type = (entry.inputSchema.properties.type as { enum?: string[] }).enum;
    expect([...(type ?? [])].sort()).toEqual([...CANCEL_ENUM].sort());
  });

  it("both require do, id and type, on the tool as served", () => {
    for (const name of ["rhen_archive", "rhen_cancel"])
      expect([...(tool(name).inputSchema.required ?? [])].sort(), name).toEqual(["do", "id", "type"]);
  });
});

describe("the write tools say a closed status is refused", () => {
  it("rhen_save, rhen_bulk and rhen_changeset point to the close tools", () => {
    for (const name of ["rhen_save", "rhen_bulk", "rhen_changeset"]) {
      const entry = MCP_TOOL_MANIFEST.find((tool) => tool.name === name)!;
      expect(entry.description, name).toMatch(/status archived or cancelled is refused/);
      expect(entry.description, name).toContain("rhen_archive");
    }
  });
});

describe("the CLI README", () => {
  it("does not still say removal is a status change", () => {
    const readme = new URL("../README.md", import.meta.url);
    if (!existsSync(readme)) return;
    expect(readFileSync(readme, "utf8")).not.toMatch(/removal is a status change/);
  });
});
