import { readFileSync } from "node:fs";
import {
  DERIVED_CONTENT_MAX_CODE_POINTS,
  DERIVED_FACT_STATUSES,
  DERIVED_MAX_WHO,
  DERIVED_MSG_CLASSES,
  DERIVED_MSG_CLASS_REASONS,
  DERIVED_SPAN_MAX_CODE_POINTS
} from "@openrhen/contracts";
import { describe, expect, it } from "vitest";

// integrations/communication-readers imports no workspace package, so it keeps its own copy of the derived vocabulary;
// this keeps that copy equal to the contracts' (the validators' source of truth).
describe("the communication readers' copy of the derived vocabulary", () => {
  const source = (name: string) =>
    readFileSync(new URL(`../../integrations/communication-readers/src/${name}.ts`, import.meta.url), "utf8");
  const listIn = (text: string, constant: string) => {
    const body = new RegExp(`export const ${constant} = \\[([^\\]]*)\\]`).exec(text)?.[1] ?? "";
    return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  };

  it("has the same message classes", () => {
    expect(listIn(source("classify-message"), "MSG_CLASSES")).toEqual([...DERIVED_MSG_CLASSES]);
  });

  it("has the same reason codes", () => {
    expect(listIn(source("classify-message"), "MSG_CLASS_REASONS")).toEqual([...DERIVED_MSG_CLASS_REASONS]);
  });

  it("has the same fact statuses", () => {
    expect(listIn(source("fact-status"), "FACT_STATUSES")).toEqual([...DERIVED_FACT_STATUSES]);
  });

  it("has the same limits on a grounded span and on who", () => {
    const number = (name: string, constant: string) =>
      Number(new RegExp(`export const ${constant} = (\\d+)`).exec(source(name))?.[1]);
    expect(number("ground-quote", "MAX_QUOTE_CODE_POINTS")).toBe(DERIVED_SPAN_MAX_CODE_POINTS);
    expect(number("message-context", "MAX_WHO")).toBe(DERIVED_MAX_WHO);
    expect(number("ground-quote", "MAX_CONTENT_CODE_POINTS")).toBe(DERIVED_CONTENT_MAX_CODE_POINTS);
  });
});
