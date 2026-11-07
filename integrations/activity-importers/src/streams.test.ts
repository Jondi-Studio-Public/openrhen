import { describe, expect, it } from "vitest";
import { MAX_FIELD_CHARS, csvRecords } from "./csv-stream.js";
import { chunked, collect } from "./fixtures.js";
import { ImportReadError } from "./types.js";
import { jsonArrayObjects } from "./json-stream.js";
import { xmlStartTags } from "./xml-stream.js";

describe("jsonArrayObjects", () => {
  const doc = '[{"a":"x]}\\"{["},{"b":[1,{"c":2}]},\n{"d":"é€😀"}]';
  it.each([1, 2, 3, 5, 64])("yields each object of a top-level array, with chunks of %i bytes", async (size) => {
    const elements = await collect(jsonArrayObjects(chunked(doc, size)));
    expect(elements.map((e) => e.value)).toEqual([{ a: 'x]}"{[' }, { b: [1, { c: 2 }] }, { d: "é€😀" }]);
  });

  it("reads the array inside a wrapper object (Chrome) and ignores sibling keys", async () => {
    const elements = await collect(
      jsonArrayObjects(chunked('{"meta":{"n":[1]},"Browser History":[{"u":1},{"u":2}],"after":[{"no":1}]}', 4))
    );
    // The array nested in "meta" is not the document's list; the first top-level list is, and a later one is not read.
    expect(elements.map((e) => e.value)).toEqual([{ u: 1 }, { u: 2 }]);
  });

  it("reads the outermost array only, so objects nested in an element are not elements", async () => {
    const elements = await collect(jsonArrayObjects(chunked('{"Browser History":[{"u":1,"n":[{"x":1}]},{"u":2}]}', 3)));
    expect(elements.map((e) => e.value)).toEqual([{ u: 1, n: [{ x: 1 }] }, { u: 2 }]);
  });

  it("reports a malformed element without stopping, and a cut-off file as truncated", async () => {
    let end: { truncated: boolean; sawArray: boolean } | undefined;
    const elements = await collect(
      jsonArrayObjects(chunked('[{"a":1},{"b":oops},{"c":3},{"d":', 5), (info) => (end = info))
    );
    expect(elements.map((e) => e.ok)).toEqual([true, false, true]);
    expect(end).toEqual({ truncated: true, sawArray: true });
  });

  it("says when there is no array at all", async () => {
    let end: { truncated: boolean; sawArray: boolean } | undefined;
    await collect(jsonArrayObjects(chunked('{"a":1}', 2), (info) => (end = info)));
    expect(end).toEqual({ truncated: false, sawArray: false });
  });
});

describe("csvRecords", () => {
  const csv =
    'ID,Timestamp,Contents\r\n1,2026-01-02 03:04:05+00:00,"hello, ""world""\nsecond line"\r\n\r\n2,t,plain\n3,t,';
  it.each([1, 4, 100])("reads quoted commas, quotes and newlines, with chunks of %i", async (size) => {
    expect(await collect(csvRecords(chunked(csv, size)))).toEqual([
      ["ID", "Timestamp", "Contents"],
      ["1", "2026-01-02 03:04:05+00:00", 'hello, "world"\nsecond line'],
      ["2", "t", "plain"],
      ["3", "t", ""]
    ]);
  });

  it("drops a record cut off inside a quote and says so", async () => {
    let truncated = false;
    const records = await collect(
      csvRecords(chunked('a,b\n1,"never closed', 3), (info) => (truncated = info.truncated))
    );
    expect(records).toEqual([["a", "b"]]);
    expect(truncated).toBe(true);
  });

  it("skips a record with a field over the cap and keeps the rest", async () => {
    let skipped = 0;
    const big = "x".repeat(MAX_FIELD_CHARS + 10);
    const records = await collect(
      csvRecords(chunked(`a,b\n1,${big}\n2,ok\n`, 100_000), undefined, () => (skipped += 1))
    );
    expect(records).toEqual([
      ["a", "b"],
      ["2", "ok"]
    ]);
    expect(skipped).toBe(1);
  });

  it("skips a leading byte order mark", async () => {
    expect(await collect(csvRecords(chunked("﻿ID,x\n1,2\n", 2)))).toEqual([
      ["ID", "x"],
      ["1", "2"]
    ]);
  });
});

describe("xmlStartTags", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [
<!ELEMENT HealthData (Record*)>
<!ATTLIST Record type CDATA #REQUIRED>
]>
<HealthData locale="en_AU">
 <!-- a <Record fake="1"/> comment -->
 <Record type="A" value="x &gt; y &amp; &#65;" sourceName="Jo's &quot;Phone&quot;"/>
 <Workout duration="3"><MetadataEntry key="k" value="a>b"/></Workout>
 </HealthData>`;
  it.each([1, 5, 1000])("yields start tags with decoded attributes, with chunks of %i", async (size) => {
    const tags = await collect(xmlStartTags(chunked(xml, size)));
    expect(tags.map((t) => t.name)).toEqual(["HealthData", "Record", "Workout", "MetadataEntry"]);
    expect(tags[1]!.attrs).toEqual({ type: "A", value: "x > y & A", sourceName: 'Jo\'s "Phone"' });
    expect(tags[3]!.attrs.value).toBe("a>b");
  });

  it("throws an ImportReadError for a tag that never closes", async () => {
    await expect(collect(xmlStartTags(chunked("<a " + "x".repeat(1_100_000), 100_000)))).rejects.toBeInstanceOf(
      ImportReadError
    );
  });

  it("flags a file that ends inside a tag", async () => {
    let truncated = false;
    await collect(xmlStartTags(chunked('<a x="1"/><b y="', 3), (info) => (truncated = info.truncated)));
    expect(truncated).toBe(true);
  });
});
