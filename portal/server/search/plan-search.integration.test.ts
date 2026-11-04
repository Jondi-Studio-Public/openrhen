import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { fixedNow, setupStateStoreSuite, sql, unplannedStore } from "@/server/persistence/postgres/state-store-harness";
import { EmbeddingIndex, type Embedder } from "./embedding-index";
import { PlanSearchInputError, QUERY_INSTRUCTION, searchPlan, type PlanSearchRequest } from "./plan-search";

/**
 * Plan search against a real database: the one
 * plan-document query, word ranking across kinds with the breadcrumb, the filters, `like`, and the honest
 * fall back to words when meaning is unavailable. Meaning comes from a fake embedder that maps a few
 * words to the same direction, so "laundry" can find "Sort the bedroom floor" without sharing a word.
 */
setupStateStoreSuite("openrhen_plan_search");

const TOPICS: Record<string, number> = {
  bedroom: 0,
  room: 0,
  laundry: 0,
  floor: 0,
  network: 1,
  networking: 1,
  router: 1
};
function topicVector(text: string): Float32Array {
  const vector = new Float32Array(4);
  for (const word of text.toLowerCase().split(/\W+/)) {
    const topic = TOPICS[word];
    if (topic !== undefined) vector[topic] = vector[topic]! + 1;
  }
  vector[3] = 0.05;
  return vector;
}

function fakeEmbedder(calls: string[][] = []): Embedder {
  return {
    embed: async (texts) => {
      calls.push([...texts]);
      return texts.map(topicVector);
    }
  };
}

const failing: Embedder = {
  embed: async () => {
    throw new Error("proxy down");
  }
};

const base: PlanSearchRequest = { status: "open", mode: "hybrid", limit: 10 };

async function seeded() {
  await unplannedStore.put(createSeedState(fixedNow));
}

describe("plan search", () => {
  it("ranks by words across kinds, with the path and where the words hit", async () => {
    await seeded();
    const result = await searchPlan(
      sql,
      { ...base, query: "networking assignment", mode: "words" },
      {
        index: new EmbeddingIndex({ embedder: failing })
      }
    );
    expect(result.ranking).toBe("words");
    expect(result.note).toBeUndefined();
    const titles = result.results.map((hit) => `${hit.kind}:${hit.title}`);
    expect(titles).toContain("outcome:Complete Networking Assignment 2");
    expect(titles).toContain("project:Submit Networking Assignment 2");
    expect(titles).toContain("action:Draft networking assignment section 1");
    const action = result.results.find((hit) => hit.kind === "action")!;
    expect(action.path).toBe("Study › Complete Networking Assignment 2 › Submit Networking Assignment 2");
    expect(action.matched).toBe("words");
    expect(action.fields).toContain("title");
  });

  it("finds by meaning what shares no word, and says both when the lists agree", async () => {
    await seeded();
    const index = new EmbeddingIndex({ embedder: fakeEmbedder() });
    const result = await searchPlan(sql, { ...base, query: "laundry" }, { index });
    expect(result.ranking).toBe("hybrid");
    expect(result.results.find((hit) => hit.title === "Sort the bedroom floor")).toMatchObject({
      matched: "meaning",
      fields: []
    });
    expect(result.results.every((hit) => hit.matched === "meaning")).toBe(true);
    expect(result.results.some((hit) => hit.title.includes("Networking"))).toBe(false);
    const both = await searchPlan(sql, { ...base, query: "bedroom" }, { index });
    expect(both.results.find((hit) => hit.title === "Sort the bedroom floor")?.matched).toBe("both");
  });

  it("embeds the plan once and only new text after that", async () => {
    await seeded();
    const calls: string[][] = [];
    const index = new EmbeddingIndex({ embedder: fakeEmbedder(calls) });
    await searchPlan(sql, { ...base, query: "bedroom" }, { index });
    const first = calls.flat().length;
    calls.length = 0;
    await searchPlan(sql, { ...base, query: "router" }, { index });
    // Only the query, with the retrieval instruction a query carries and a document does not.
    expect(calls).toEqual([[`${QUERY_INSTRUCTION}router`]]);
    expect(first).toBeGreaterThan(5);
  });

  it("falls back to words and says why when meaning is unavailable", async () => {
    await seeded();
    const result = await searchPlan(
      sql,
      { ...base, query: "bedroom" },
      { index: new EmbeddingIndex({ embedder: failing }) }
    );
    expect(result.ranking).toBe("words");
    expect(result.note).toMatch(/words only.*proxy down/);
    expect(result.results.length).toBeGreaterThan(0);
    const meaningOnly = await searchPlan(
      sql,
      { ...base, query: "bedroom", mode: "meaning" },
      {
        index: new EmbeddingIndex({ embedder: failing })
      }
    );
    expect(meaningOnly.ranking).toBe("words");
    expect(meaningOnly.results.length).toBeGreaterThan(0);
  });

  it("keeps a search inside one branch, and to the kinds and statuses asked for", async () => {
    await seeded();
    const index = new EmbeddingIndex({ embedder: failing });
    const under = await searchPlan(
      sql,
      { ...base, query: "networking bedroom", mode: "words", under: "Study" },
      { index }
    );
    expect(under.results.length).toBeGreaterThan(0);
    expect(under.results.every((hit) => hit.path.startsWith("Study"))).toBe(true);
    const kinds = await searchPlan(sql, { ...base, query: "networking", mode: "words", kinds: ["action"] }, { index });
    expect(kinds.results.map((hit) => hit.kind)).toEqual(["action"]);
    await sql`UPDATE actions SET status = 'done' WHERE title = 'Draft networking assignment section 1'`;
    const open = await searchPlan(sql, { ...base, query: "networking", mode: "words", kinds: ["action"] }, { index });
    expect(open.results).toEqual([]);
    const any = await searchPlan(
      sql,
      { ...base, query: "networking", mode: "words", kinds: ["action"], status: "any" },
      { index }
    );
    expect(any.results).toHaveLength(1);
    await expect(searchPlan(sql, { ...base, query: "x", under: "Nowhere" }, { index })).rejects.toBeInstanceOf(
      PlanSearchInputError
    );
  });

  it("finds records like an existing one, leaving the record itself out", async () => {
    await seeded();
    const id = (await sql<{ id: string }[]>`SELECT id::text FROM actions WHERE title = 'Sort the bedroom floor'`)[0]!
      .id;
    const result = await searchPlan(
      sql,
      { ...base, like: id },
      { index: new EmbeddingIndex({ embedder: fakeEmbedder() }) }
    );
    expect(result.results.some((hit) => hit.id === id)).toBe(false);
    expect(result.results.map((hit) => hit.title)).toContain("Reset and clean my room");
    await expect(searchPlan(sql, { ...base, like: crypto.randomUUID() })).rejects.toBeInstanceOf(PlanSearchInputError);
  });

  it("gives a record outside the hierarchy no ancestors", async () => {
    await seeded();
    const { readPlanDocuments } = await import("./plan-documents");
    const userId = (await sql<{ id: string }[]>`SELECT id::text FROM users LIMIT 1`)[0]!.id;
    const { documents } = await readPlanDocuments(sql, userId, null);
    const commitment = documents.find((d) => d.kind === "commitment");
    expect(commitment?.ancestors).toEqual([]);
  });

  it("never returns another user's records", async () => {
    await seeded();
    const other = (
      await sql<{ id: string }[]>`
        INSERT INTO users (display_name, timezone) VALUES ('Someone else', 'UTC') RETURNING id::text AS id`
    )[0]!.id;
    try {
      const area = (
        await sql<{ id: string }[]>`
          INSERT INTO areas (user_id, name, sort_order) VALUES (${other}, 'Networking secrets', 0) RETURNING id::text AS id`
      )[0]!.id;
      await sql`INSERT INTO outcomes (area_id, title, definition_of_done) VALUES (${area}, 'Networking elsewhere', 'Not yours')`;
      const result = await searchPlan(
        sql,
        { ...base, query: "networking", mode: "words", status: "any", limit: 50 },
        {
          index: new EmbeddingIndex({ embedder: failing })
        }
      );
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results.map((hit) => hit.title)).not.toContain("Networking secrets");
      expect(result.results.map((hit) => hit.title)).not.toContain("Networking elsewhere");
    } finally {
      await sql`DELETE FROM outcomes WHERE area_id IN (SELECT id FROM areas WHERE user_id = ${other})`;
      await sql`DELETE FROM areas WHERE user_id = ${other}`;
      await sql`DELETE FROM users WHERE id = ${other}`;
    }
  });

  it("falls back to words when the embedder hangs, after its own short timeout", async () => {
    await seeded();
    const hanging: Embedder = { embed: () => new Promise(() => undefined) };
    const started = Date.now();
    const result = await searchPlan(
      sql,
      { ...base, query: "bedroom" },
      {
        index: new EmbeddingIndex({ embedder: hanging }),
        queryTimeoutMs: 50,
        warmBudgetMs: 50
      }
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.ranking).toBe("words");
    expect(result.note).toMatch(/took longer than 50 ms/);
    expect(result.results.length).toBeGreaterThan(0);
  });

  it("matches a word that holds characters tsquery treats as operators", async () => {
    await seeded();
    await sql`UPDATE actions SET notes = 'see https://example.com/a?x=1&y=2 for the brief' WHERE title = 'Sort the bedroom floor'`;
    const result = await searchPlan(
      sql,
      { ...base, query: "https://example.com/a?x=1&y=2 it's", mode: "words" },
      {
        index: new EmbeddingIndex({ embedder: failing })
      }
    );
    expect(result.results.map((hit) => hit.title)).toContain("Sort the bedroom floor");
  });

  it("matches a quoted phrase only in order", async () => {
    await seeded();
    const index = new EmbeddingIndex({ embedder: failing });
    const inOrder = await searchPlan(sql, { ...base, query: '"networking assignment"', mode: "words" }, { index });
    expect(inOrder.results.length).toBeGreaterThan(0);
    const reversed = await searchPlan(sql, { ...base, query: '"assignment networking"', mode: "words" }, { index });
    expect(reversed.results).toEqual([]);
  });
});
