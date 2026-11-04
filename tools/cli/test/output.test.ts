import { describe, expect, it } from "vitest";
import {
  emitRows,
  formatCell,
  getPath,
  localiseInstants,
  pickFields,
  renderRecord,
  renderTable,
  toJson,
  type Emitter
} from "../src/output.js";

describe("getPath", () => {
  it("reads a nested path", () => {
    expect(getPath({ project: { title: "Thesis" } }, "project.title")).toBe("Thesis");
  });

  it("reads an array length", () => {
    expect(getPath({ steps: [1, 2, 3] }, "steps.length")).toBe(3);
  });

  it("returns undefined through a null or undefined segment", () => {
    expect(getPath({ project: null }, "project.title")).toBeUndefined();
    expect(getPath({}, "project.title")).toBeUndefined();
  });

  it("returns undefined when a non-object segment is indexed further", () => {
    expect(getPath({ title: "Thesis" }, "title.length")).toBeUndefined();
  });
});

describe("pickFields", () => {
  it("projects a subset of dotted paths", () => {
    expect(pickFields({ id: "a", project: { title: "T" }, extra: "x" }, ["id", "project.title"])).toEqual({
      id: "a",
      "project.title": "T"
    });
  });
});

describe("formatCell", () => {
  it("renders undefined as empty string", () => expect(formatCell(undefined)).toBe(""));
  it("renders null as the literal null", () => expect(formatCell(null)).toBe("null"));
  it("renders numbers and booleans as strings", () => {
    expect(formatCell(42)).toBe("42");
    expect(formatCell(true)).toBe("true");
  });
  it("collapses internal whitespace and trims", () => {
    expect(formatCell("  a   b\n\tc  ")).toBe("a b c");
  });
  it("drops terminal controls before cutting to width, so they cannot push the text out", () => {
    expect(formatCell(`${"\u0000".repeat(48)}invoice overdue`)).toBe("invoice overdue");
  });

  it("joins an array of primitives with a comma", () => {
    expect(formatCell(["home", "laptop"])).toBe("home, laptop");
  });
  it("shows the count for an array of objects", () => {
    expect(formatCell([{ a: 1 }, { a: 2 }])).toBe("[2 items]");
  });
  it("treats null entries as primitives within an array (explicit exception in the every check)", () => {
    // formatCell's rule keeps null out of the "array of objects" branch even though typeof null === "object".
    expect(formatCell([null, "x"])).toBe("null, x");
  });
  it("JSON-encodes a plain object", () => {
    expect(formatCell({ a: 1, b: "x" })).toBe(JSON.stringify({ a: 1, b: "x" }));
  });

  it("does not truncate at exactly 48 characters", () => {
    const text = "a".repeat(48);
    expect(formatCell(text)).toBe(text);
    expect(formatCell(text).length).toBe(48);
  });
  it("truncates at 49 characters with an ellipsis, keeping total length 48", () => {
    const text = "a".repeat(49);
    const result = formatCell(text);
    expect(result.length).toBe(48);
    expect(result.endsWith("…")).toBe(true);
    expect(result.slice(0, 47)).toBe("a".repeat(47));
  });

  it("never truncates the id column", () => {
    const text = "a".repeat(100);
    expect(formatCell(text, "id")).toBe(text);
  });
  it("never truncates a column ending in Id", () => {
    const text = "a".repeat(100);
    expect(formatCell(text, "projectId")).toBe(text);
  });
  it("never truncates a column ending in Ids", () => {
    const text = "a".repeat(100);
    expect(formatCell(text, "dependencyIds")).toBe(text);
  });
  it("does truncate a column that merely contains Id but does not end with it", () => {
    const text = "a".repeat(100);
    expect(formatCell(text, "idealPlan").length).toBe(48);
  });
});

describe("renderTable", () => {
  it("renders (no rows) for an empty list", () => {
    expect(renderTable([], ["id", "name"])).toBe("(no rows)");
  });

  it("aligns columns to the widest cell and trims trailing padding", () => {
    const rows = [
      { id: "a1", name: "Short" },
      { id: "area-study", name: "A very much longer name here" }
    ];
    const table = renderTable(rows, ["id", "name"]);
    const lines = table.split("\n");
    expect(lines).toHaveLength(4); // header, dashes, 2 rows

    const idWidth = "area-study".length; // widest cell in the id column beats the "id" header
    const nameWidth = "A very much longer name here".length; // widest cell beats the "name" header
    expect(lines[0]).toBe(`id${" ".repeat(idWidth - 2)}  name`);
    expect(lines[1]).toBe(`${"-".repeat(idWidth)}  ${"-".repeat(nameWidth)}`);
    expect(lines[2]).toBe(`a1${" ".repeat(idWidth - 2)}  Short`);
    expect(lines[3]).toBe(`area-study  A very much longer name here`);
    // No trailing whitespace anywhere.
    for (const line of lines) expect(line).toBe(line.replace(/\s+$/, ""));
  });

  it("reads column values through getPath, including dotted paths", () => {
    const rows = [{ id: "d1", steps: [1, 2] }];
    const table = renderTable(rows, ["id", "steps.length"]);
    expect(table).toContain("2");
  });
});

describe("renderRecord", () => {
  it("skips undefined values and named skip keys", () => {
    const text = renderRecord({ a: 1, b: undefined, c: "x" }, { skip: ["c"] });
    expect(text).toBe("a  1");
  });

  it("JSON-encodes nested objects and arrays, and prints null literally", () => {
    const text = renderRecord({ obj: { x: 1 }, n: null, list: [1, 2] });
    const lines = text.split("\n");
    expect(lines).toContain(`obj   ${JSON.stringify({ x: 1 })}`);
    expect(lines).toContain("n     null");
    expect(lines).toContain(`list  ${JSON.stringify([1, 2])}`);
  });
});

describe("toJson", () => {
  it("compact by default", () => expect(toJson({ a: 1 })).toBe('{"a":1}'));
  it("pretty when asked", () => expect(toJson({ a: 1 }, true)).toBe(JSON.stringify({ a: 1 }, null, 2)));
});

describe("localiseInstants", () => {
  it("rewrites ISO instant strings anywhere in a nested value, leaving other strings alone", () => {
    const value = {
      id: "commitment-1",
      startsAt: "2026-09-04T08:30:00Z",
      nested: { endsAt: "2026-09-04T09:00:00Z" },
      list: ["2026-09-04T08:30:00Z", "not-a-date"]
    };
    const result = localiseInstants(value, "Australia/Sydney");
    expect(result.startsAt).toBe("2026-09-04T18:30:00+10:00");
    expect(result.nested.endsAt).toBe("2026-09-04T19:00:00+10:00");
    expect(result.list[0]).toBe("2026-09-04T18:30:00+10:00");
    expect(result.list[1]).toBe("not-a-date");
    expect(result.id).toBe("commitment-1");
  });

  it("leaves non-string values untouched", () => {
    expect(localiseInstants({ n: 1, b: true, nil: null }, "Australia/Sydney")).toEqual({ n: 1, b: true, nil: null });
  });
});

describe("emitRows", () => {
  const rows = [
    { id: "a1", title: "Alpha", extra: "x" },
    { id: "a2", title: "Beta", extra: "y" }
  ];

  it("table mode renders a table of the columns", () => {
    const out: string[] = [];
    const emitter: Emitter = { mode: "table", stdout: (text) => out.push(text) };
    emitRows(emitter, rows, ["id", "title"]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("id");
    expect(out[0]).toContain("Alpha");
    expect(out[0]).not.toContain("extra");
  });

  it("json mode prints one pretty array of full rows", () => {
    const out: string[] = [];
    const emitter: Emitter = { mode: "json", stdout: (text) => out.push(text) };
    emitRows(emitter, rows, ["id", "title"]);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0] ?? "")).toEqual(rows);
    expect(out[0]).toBe(toJson(rows, true));
  });

  it("jsonl mode prints one line per row", () => {
    const out: string[] = [];
    const emitter: Emitter = { mode: "jsonl", stdout: (text) => out.push(text) };
    emitRows(emitter, rows, ["id", "title"]);
    expect(out).toHaveLength(2);
    expect(JSON.parse(out[0] ?? "")).toEqual(rows[0]);
    expect(JSON.parse(out[1] ?? "")).toEqual(rows[1]);
  });

  it("json mode rewrites ISO instants to the given timezone's offset when one is passed", () => {
    const out: string[] = [];
    const emitter: Emitter = { mode: "json", stdout: (text) => out.push(text) };
    emitRows(emitter, [{ id: "c1", startsAt: "2026-09-04T08:30:00Z" }], ["id", "startsAt"], {
      timeZone: "Australia/Sydney"
    });
    expect(JSON.parse(out[0] ?? "")).toEqual([{ id: "c1", startsAt: "2026-09-04T18:30:00+10:00" }]);
  });

  it("jsonl mode rewrites ISO instants the same way, one row per line", () => {
    const out: string[] = [];
    const emitter: Emitter = { mode: "jsonl", stdout: (text) => out.push(text) };
    emitRows(emitter, [{ id: "c1", startsAt: "2026-09-04T08:30:00Z" }], ["id", "startsAt"], {
      timeZone: "Australia/Sydney"
    });
    expect(JSON.parse(out[0] ?? "")).toEqual({ id: "c1", startsAt: "2026-09-04T18:30:00+10:00" });
  });

  it("fields projects both table columns and JSON keys", () => {
    const tableOut: string[] = [];
    emitRows({ mode: "table", stdout: (text) => tableOut.push(text) }, rows, ["id", "title"], { fields: ["id"] });
    expect(tableOut[0]).not.toContain("Alpha");
    expect(tableOut[0]).toContain("a1");

    const jsonOut: string[] = [];
    emitRows({ mode: "json", stdout: (text) => jsonOut.push(text) }, rows, ["id", "title"], { fields: ["id"] });
    expect(JSON.parse(jsonOut[0] ?? "")).toEqual([{ id: "a1" }, { id: "a2" }]);
  });
});
