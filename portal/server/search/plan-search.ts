import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import type { Sql } from "@/server/persistence/postgres/sql-pool";
import { EMBED_TEXT_CHARS, EmbeddingIndex, cosine, proxyEmbedder } from "./embedding-index";
import {
  PLAN_DOCUMENT_KINDS,
  readPlanDocuments,
  type PlanDocument,
  type PlanDocumentKind,
  type WordQuery
} from "./plan-documents";

/**
 * Plan search for agents and the email reasoner: words
 * (Postgres full-text over `plan-documents.ts`) and meaning (embeddings, `embedding-index.ts`) ranked
 * separately and fused by reciprocal rank. When meaning is unavailable the answer says so
 * (`ranking: "words"` and a `note`) rather than quietly returning less.
 */

export type SearchMode = "hybrid" | "words" | "meaning";

export interface PlanSearchRequest {
  /** Words, or a phrase in double quotes. Optional only with `like`. */
  query?: string;
  /** Only these kinds; all when absent. */
  kinds?: readonly PlanDocumentKind[];
  /** "open" (default) keeps records still in play; "any" keeps all; a list keeps those raw statuses. */
  status: "open" | "any" | readonly string[];
  /** An area, outcome, project or deliverable (id or exact title): search inside it only. */
  under?: string;
  mode: SearchMode;
  /** A record id: find records like it (the duplicate check before a create). */
  like?: string;
  limit: number;
}

export interface PlanSearchHit {
  kind: PlanDocumentKind;
  id: string;
  title: string;
  status?: string;
  path: string;
  matched: "both" | "words" | "meaning";
  fields: string[];
  snippet?: string;
  /** Only on a capture or commitment that came from outside the person's own entry (an email, another person, a calendar). */
  sourceType?: string;
  score: number;
}

export interface PlanSearchResult {
  ranking: SearchMode;
  note?: string;
  total: number;
  results: PlanSearchHit[];
}

/** A request the caller can fix: an unknown `like` or `under`, an ambiguous title. Answered as a 400. */
export class PlanSearchInputError extends Error {}

export const SEARCH_DEFAULT_LIMIT = 10;
export const SEARCH_MAX_LIMIT = 50;
/**
 * Below this a record is not "like" the query, however high it ranks among the rest. 0.40 comes from the
 * email reasoner's plan search (full 4,096-dimension vectors, no query instruction); it is not yet checked
 * against live vectors at 1,024 dimensions with the instruction, which the sandbox cannot reach (no key).
 * Check it on the first real searches after deploy and retune here.
 */
export const MIN_SIMILARITY = 0.4;
/** Qwen3-Embedding's retrieval instruction, put before a query (not a document), as its model card asks. */
export const QUERY_INSTRUCTION =
  "Instruct: Given a search query, retrieve the personal plan records (tasks, projects, commitments) it refers to\nQuery: ";
/** Reciprocal rank fusion's damping constant; 60 is the value from the original paper and common use. */
const RRF_K = 60;
const SNIPPET_CHARS = 160;
/** How long a search waits for the meaning index to fill after a restart before answering with what it has. */
const WARM_BUDGET_MS = 4_000;

/** The text a record is embedded from: title, breadcrumb and body, capped. */
export function documentText(document: Pick<PlanDocument, "title" | "path" | "body">): string {
  return [document.title, document.path, document.body]
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join(". ")
    .slice(0, EMBED_TEXT_CHARS);
}

/** `"exact words"` searches as a phrase; anything else matches any of its words. */
export function wordQueryOf(text: string): WordQuery {
  const trimmed = text.trim();
  const quoted = /^"(.+)"$/.exec(trimmed);
  return quoted ? { text: quoted[1]!.trim(), phrase: true } : { text: trimmed, phrase: false };
}

/** Kind names as agents type them: singular or plural, plus the CLI's aliases. */
export function parseKinds(raw: string): PlanDocumentKind[] {
  const aliases: Record<string, PlanDocumentKind> = {
    places: "condition",
    place: "condition",
    tasks: "action",
    // People are `condition` records of kind contact (a partner, a child, an instructor): there is no person kind.
    person: "condition",
    people: "condition",
    contact: "condition",
    contacts: "condition",
    kid: "condition",
    kids: "condition"
  };
  return raw
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== "")
    .map((name) => {
      const found =
        aliases[name] ??
        PLAN_DOCUMENT_KINDS.find((kind) => kind === name || `${kind}s` === name || kind.replace("-", "_") === name);
      if (!found)
        throw new PlanSearchInputError(`Unknown kind "${name}". Search covers: ${PLAN_DOCUMENT_KINDS.join(", ")}.`);
      return found;
    });
}

/** What an agent needs when a search finds nothing: what was searched, how matching works, and the next calls. */
export function noHitNote(request: { kinds?: readonly string[]; status: PlanSearchRequest["status"] }): string {
  const kinds = request.kinds && request.kinds.length > 0 ? `kinds: ${request.kinds.join(", ")}` : "every kind";
  const status = request.status === "any" ? "any status" : `status ${JSON.stringify(request.status)}`;
  const widen =
    request.status === "any"
      ? ""
      : ' Closed, done and cancelled records are skipped: repeat the call with {"status": "any"} to include them.';
  return (
    `No records matched (searched ${kinds}, ${status}). Matching is by whole words, so a different spelling or a ` +
    `partial name finds nothing: try one distinct whole word, or the other spelling.${widen} To browse instead of search, ` +
    `call rhen_list with {"entity": "<kind>"}.`
  );
}

/**
 * Reciprocal rank fusion of the two ranked lists: each record scores Σ 1/(k + rank) over the lists it
 * appears in, so a record both lists agree on rises above one that only one list liked.
 */
export function fuse(words: readonly string[], meaning: readonly string[]): { key: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const list of [words, meaning])
    list.forEach((key, index) => scores.set(key, (scores.get(key) ?? 0) + 1 / (RRF_K + index + 1)));
  return [...scores.entries()].map(([key, score]) => ({ key, score })).sort((a, b) => b.score - a.score);
}

const keyOf = (document: Pick<PlanDocument, "kind" | "id">): string => `${document.kind}:${document.id}`;

function resolveUnder(documents: readonly PlanDocument[], under: string): string {
  const containers = documents.filter((d) => ["area", "outcome", "project", "deliverable"].includes(d.kind));
  const byId = containers.find((d) => d.id === under);
  if (byId) return byId.id;
  const byTitle = containers.filter((d) => d.title.toLowerCase() === under.trim().toLowerCase());
  if (byTitle.length === 1) return byTitle[0]!.id;
  if (byTitle.length > 1)
    throw new PlanSearchInputError(
      `"${under}" names ${byTitle.length} records (${byTitle.map((d) => `${d.kind} ${d.id}`).join(", ")}); pass an id.`
    );
  throw new PlanSearchInputError(`No area, outcome, project or deliverable has the id or title "${under}".`);
}

function keepStatus(document: PlanDocument, status: PlanSearchRequest["status"]): boolean {
  if (status === "any") return true;
  if (status === "open") return document.open;
  return document.status !== null && status.includes(document.status);
}

let sharedIndex: EmbeddingIndex | null = null;
/** The process's one meaning index. Tests pass their own. */
export function planSearchIndex(): EmbeddingIndex {
  sharedIndex ??= new EmbeddingIndex({ embedder: proxyEmbedder() });
  return sharedIndex;
}

/** Test seams for the two clocks a meaning search runs on; production uses the defaults. */
interface SearchTiming {
  warmBudgetMs?: number;
  queryTimeoutMs?: number;
}

export async function searchPlan(
  sql: Sql,
  request: PlanSearchRequest,
  options: { index?: EmbeddingIndex } & SearchTiming = {}
): Promise<PlanSearchResult> {
  const index = options.index ?? planSearchIndex();
  const userId = await ensureUser(sql);

  const wordQuery: WordQuery | null = request.query?.trim() ? wordQueryOf(request.query) : null;
  if (!wordQuery && request.like === undefined)
    throw new PlanSearchInputError("Give a query, or `like` with a record id.");
  // One read either way: with `like` and no query, the words are that record's own title (any of them).
  const { documents, queryWords } = await readPlanDocuments(sql, userId, wordQuery, request.like);
  const like = request.like === undefined ? undefined : documents.find((d) => d.id === request.like);
  if (request.like !== undefined && !like)
    throw new PlanSearchInputError(`No plan record has the id "${request.like}".`);
  const words = wordQuery ?? { text: like!.title, phrase: false };

  const underId = request.under?.trim() ? resolveUnder(documents, request.under) : undefined;
  const kinds = request.kinds && request.kinds.length > 0 ? new Set(request.kinds) : null;
  const candidates = documents.filter(
    (d) =>
      (!kinds || kinds.has(d.kind)) &&
      keepStatus(d, request.status) &&
      (!underId || d.ancestors.includes(underId)) &&
      (!like || keyOf(d) !== keyOf(like))
  );
  const byKey = new Map(candidates.map((d) => [keyOf(d), d]));

  // At least a third of the query's words, as list --search always asked; a phrase already matched whole.
  const needed = words.phrase ? 0 : Math.max(1, Math.ceil(queryWords / 3));
  const wordHits =
    request.mode === "meaning"
      ? []
      : candidates
          .filter((d) => d.rank !== null && d.matchedWords >= needed)
          .sort((a, b) => b.rank! - a.rank!)
          .map(keyOf);

  let ranking: SearchMode = request.mode;
  let note: string | undefined;
  let meaningHits: string[] = [];
  if (request.mode !== "words") {
    try {
      const meaning = await meaningRanking(index, documents, candidates, like, words.text, options);
      meaningHits = meaning.keys;
      note = meaning.note;
    } catch (error) {
      ranking = "words";
      note = `Ranked by whole words only: search by meaning is unavailable on this server (${error instanceof Error ? error.message : String(error)}).`;
    }
  }

  // Meaning unavailable on a meaning-only search: the words list stands in, rather than nothing.
  const wordsForFusion =
    request.mode === "meaning" && ranking === "words"
      ? candidates
          .filter((d) => d.rank !== null && d.matchedWords >= needed)
          .sort((a, b) => b.rank! - a.rank!)
          .map(keyOf)
      : wordHits;
  const wordSet = new Set(wordsForFusion);
  const meaningSet = new Set(meaningHits);
  const fused = fuse(wordsForFusion, meaningHits);
  const results = fused.slice(0, request.limit).map(({ key, score }): PlanSearchHit => {
    const document = byKey.get(key)!;
    const matched = wordSet.has(key) && meaningSet.has(key) ? "both" : wordSet.has(key) ? "words" : "meaning";
    const snippet =
      document.snippet ?? (document.body.trim() !== "" ? document.body.trim().slice(0, SNIPPET_CHARS) : undefined);
    return {
      kind: document.kind,
      id: document.id,
      title: document.title,
      ...(document.status !== null ? { status: document.status } : {}),
      path: document.path,
      matched,
      fields: wordSet.has(key) ? document.fields : [],
      ...(snippet ? { snippet } : {}),
      ...(document.sourceType !== null ? { sourceType: document.sourceType } : {}),
      score: Number(score.toFixed(5))
    };
  });
  if (fused.length === 0)
    note = [note, noHitNote({ ...(request.kinds ? { kinds: request.kinds } : {}), status: request.status })]
      .filter(Boolean)
      .join(" ");
  return { ranking, ...(note ? { note } : {}), total: fused.length, results };
}

async function meaningRanking(
  index: EmbeddingIndex,
  documents: readonly PlanDocument[],
  candidates: readonly PlanDocument[],
  like: PlanDocument | undefined,
  queryText: string,
  { warmBudgetMs = WARM_BUDGET_MS, queryTimeoutMs }: SearchTiming
): Promise<{ keys: string[]; note?: string }> {
  const reason = index.unavailable();
  if (reason !== null) throw new Error(reason);
  // The whole plan, not just this search's candidates, so the next search with other filters is warm too.
  const warm = index.warm(documents.map(documentText));
  warm.catch(() => undefined);
  // Qwen3 embeddings are asymmetric: a query carries an instruction, a document does not. `like` compares
  // one record with others, which is symmetric, so it embeds the record as a document (usually cached).
  const queryVector = like
    ? (index.vector(documentText(like)) ?? (await index.embedQuery(documentText(like), queryTimeoutMs)))
    : await index.embedQuery(`${QUERY_INSTRUCTION}${queryText}`, queryTimeoutMs);
  // After a restart the first pass can take a while: answer with what is in by the budget, keep filling behind.
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([warm, new Promise((resolve) => (timer = setTimeout(resolve, warmBudgetMs)))]).finally(() =>
    clearTimeout(timer)
  );
  const similarity = new Map<string, number>();
  let missing = 0;
  for (const document of candidates) {
    const vector = index.vector(documentText(document));
    if (!vector) {
      missing += 1;
      continue;
    }
    const score = cosine(queryVector, vector);
    if (score >= MIN_SIMILARITY) similarity.set(keyOf(document), score);
  }
  const keys = [...similarity.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
  const note =
    missing > 0
      ? `Search by meaning covered ${candidates.length - missing} of ${candidates.length} records; the rest are still being indexed.`
      : undefined;
  return { keys, ...(note ? { note } : {}) };
}
