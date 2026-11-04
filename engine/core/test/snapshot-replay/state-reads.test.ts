import { describe, expect, it } from "vitest";
import {
  collectStateReads,
  docsDirectory,
  fs,
  jsonPath,
  lowerBoundLabel,
  markdownPath,
  regenerateCommand,
  renderJson,
  renderMarkdown,
  updateRequested
} from "./state-reads.js";

describe("engine state reads", () => {
  const reads = collectStateReads();
  const json = renderJson(reads);
  const markdown = renderMarkdown(reads);

  if (updateRequested) {
    fs.mkdirSync(docsDirectory, { recursive: true });
    fs.writeFileSync(jsonPath, json);
    fs.writeFileSync(markdownPath, markdown);
  }

  it("reads real fields, not an empty or whole-state table", () => {
    expect(reads.collections.length).toBeGreaterThan(5);
    expect(reads.settings.length).toBeGreaterThan(5);
    expect(reads.settings).toContain("timezone");
  });

  it("labels the table as a lower bound", () => {
    expect(markdown).toContain(lowerBoundLabel);
    expect(json).toContain(lowerBoundLabel);
  });

  it("matches the committed table", () => {
    const hint = `engine state reads changed. Regenerate with (on Windows set the variable first):\n${regenerateCommand}`;
    expect(fs.existsSync(jsonPath) && fs.existsSync(markdownPath), hint).toBe(true);
    expect(fs.readFileSync(jsonPath, "utf8"), hint).toBe(json);
    expect(fs.readFileSync(markdownPath, "utf8"), hint).toBe(markdown);
  });
});
