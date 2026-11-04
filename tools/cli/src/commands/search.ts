import { parsePositiveInt, stringOption, type CommandContext, type CommandSpec } from "../command.js";
import type { PortalState } from "../client.js";
import { entityItems, findEntity, type AnyRecord } from "../entities.js";
import { CliError, EXIT } from "../errors.js";
import { emitRows, toJson } from "../output.js";
import { outsideSourceOf } from "../outside-text.js";
import { selectRows } from "../selection.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MODES = ["hybrid", "words", "meaning"] as const;
/** What the portal's plan search covers, in the CLI's singular entity names (`show <kind> <id>` takes them). */
const KINDS = [
  "area",
  "outcome",
  "project",
  "deliverable",
  "action",
  "commitment",
  "capture",
  "routine-step",
  "condition",
  "span"
] as const;
/** Statuses that are no longer in play, for `--status open` when searching a saved snapshot. */
const CLOSED = new Set(["done", "cancelled", "archived", "completed", "skipped", "ignored", "superseded"]);
const TITLE_FIELDS = ["title", "name", "text"];

interface SearchHit {
  kind: string;
  id: string;
  title: string;
  status?: string;
  path: string;
  matched: "both" | "words" | "meaning";
  fields: string[];
  snippet?: string;
  /** Only on a capture or commitment that came from outside (mail, another person, a calendar), so a reader can tell its text is not the person's. */
  sourceType?: string;
  score: number;
}

interface SearchResponse {
  ranking: (typeof MODES)[number];
  note?: string;
  total: number;
  results: SearchHit[];
}

export const searchCommand: CommandSpec = {
  name: "search",
  summary: "Find plan records by words and meaning, best match first",
  description:
    "Searches the whole plan at once (areas, outcomes, projects, deliverables with their criteria and blockers, " +
    "actions, commitments, captures, routine steps, places and spans) by words and by meaning, fused into one " +
    "ranking across kinds. Each hit carries its kind, id, title, status, breadcrumb path (Area › Outcome › " +
    "Project), whether it matched by words, meaning or both, and a snippet. A phrase in double quotes must match " +
    "in order. --like <id> finds records similar to an existing one: run it before creating something, to catch " +
    "a duplicate. --under keeps the search inside one area, outcome, project or deliverable. By default only " +
    "records still in play are searched (--status any for all). When meaning is unavailable the answer says " +
    'so: ranking "words" and a note. Use `show <kind> <id>` for a hit\'s full record; `list --search` keeps ' +
    "per-kind filters, sorting and paging.",
  positionals: [{ name: "query", required: false, description: "Words, or a phrase in double quotes" }],
  options: {
    kinds: {
      type: "string",
      placeholder: "a,b",
      description: `Only these kinds (comma separated: ${KINDS.join(", ")}); default all`
    },
    entity: { type: "string", placeholder: "a,b", description: "Same as --kinds" },
    status: {
      type: "string",
      placeholder: "open|any|a,b",
      description: "open (default): records still in play; any: everything; or a comma list of statuses"
    },
    under: {
      type: "string",
      placeholder: "id|title",
      description: "Only records inside this area, outcome, project or deliverable"
    },
    like: {
      type: "string",
      placeholder: "id",
      description: "Find records similar to this one (check for a duplicate before creating); the query is optional"
    },
    mode: { type: "string", placeholder: "hybrid|words|meaning", description: "How to rank (default hybrid)" },
    limit: {
      type: "string",
      mcp: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
      placeholder: "n",
      description: `At most n hits (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`
    }
  },
  mutates: false,
  examples: [
    'search "dentist"',
    'search "\\"network design report\\"" --kinds deliverables,actions',
    "search --like <action-id>",
    'search "backup" --under "Home server" --status any'
  ],
  async run(context, args) {
    const query = args.positionals[0]?.trim() ?? "";
    const like = stringOption(args.values, "like")?.trim() || undefined;
    if (query === "" && !like) throw new CliError("search needs some text, or --like <id>.", EXIT.usage);
    const limit = Math.min(parsePositiveInt(args, "limit") ?? DEFAULT_LIMIT, MAX_LIMIT);
    const mode = stringOption(args.values, "mode")?.trim() || "hybrid";
    if (!(MODES as readonly string[]).includes(mode))
      throw new CliError(`--mode must be one of ${MODES.join(", ")}.`, EXIT.usage);
    const kinds = stringOption(args.values, "kinds") ?? stringOption(args.values, "entity");
    const status = stringOption(args.values, "status")?.trim() || "open";
    const under = stringOption(args.values, "under")?.trim() || undefined;

    let response: SearchResponse;
    if (context.client.baseUrl.startsWith("state-file:")) {
      response = await searchSnapshot(context, { query, like, kinds, status, under, limit }, "a saved snapshot");
    } else {
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      if (like) params.set("like", like);
      if (kinds) params.set("kinds", kinds);
      if (under) params.set("under", under);
      params.set("status", status);
      params.set("mode", mode);
      params.set("limit", String(limit));
      try {
        response = await context.client.get<SearchResponse>(`/api/plan/search?${params.toString()}`);
      } catch (error) {
        // The route never answers 404 itself, so a 404 is a portal from before plan search: the old word
        // search over the state still answers.
        if (!(error instanceof CliError && error.exitCode === EXIT.notFound)) throw error;
        response = await searchSnapshot(
          context,
          { query, like, kinds, status, under, limit },
          "a portal without plan search"
        );
      }
    }

    if (context.mode === "json") {
      // An object, not a bare array, so a caller reading only stdout (MCP) still learns the list was cut
      // and how it was ranked.
      response.results = response.results.map(keepOutsideSource);
      context.stdout(toJson({ ...response, shown: response.results.length }, true));
      return;
    }
    emitRows({ mode: context.mode, stdout: context.stdout }, response.results as unknown as AnyRecord[], [
      "kind",
      "id",
      "title",
      "status",
      "path",
      "matched"
    ]);
    if (response.note) context.stderr(`rhen: ${response.note}`);
    if (response.total > response.results.length)
      context.stderr(
        `rhen: showing ${response.results.length} of ${response.total} hits; raise --limit or use --kinds.`
      );
  }
};

/**
 * Word search over the loaded state, for a `--state-file` snapshot (the email benchmark freezes the plan
 * this way) or a portal that predates `/api/plan/search`. It ranks by words only and says so.
 */
async function searchSnapshot(
  context: CommandContext,
  request: {
    query: string;
    like: string | undefined;
    kinds: string | undefined;
    status: string;
    under: string | undefined;
    limit: number;
  },
  where: string
): Promise<SearchResponse> {
  if (request.like || request.under)
    throw new CliError(
      `--like and --under need the portal's plan search, which ${where} does not have.`,
      EXIT.unavailable
    );
  if (request.query === "") throw new CliError("search needs some text.", EXIT.usage);
  const wanted = request.kinds
    ? request.kinds
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "")
        .map((name) => {
          const entity = findEntity(name);
          if (!entity || !(KINDS as readonly string[]).includes(entity.singular))
            throw new CliError(`Unknown kind "${name}". Search covers: ${KINDS.join(", ")}.`, EXIT.usage);
          return entity.singular;
        })
    : [...KINDS];
  const state = await context.client.getState();
  const statuses = request.status === "open" || request.status === "any" ? null : new Set(request.status.split(","));
  const results: SearchHit[] = [];
  for (const kind of wanted) {
    const entity = findEntity(kind)!;
    for (const row of selectRows(state, entity, { search: request.query.replace(/^"(.*)"$/, "$1") }, context.now())) {
      const status = typeof row.status === "string" ? row.status : undefined;
      if (request.status === "open" && status !== undefined && CLOSED.has(status)) continue;
      if (statuses && (status === undefined || !statuses.has(status))) continue;
      results.push({
        kind,
        id: String(row.id ?? ""),
        title: rowTitle(row),
        ...(status !== undefined ? { status } : {}),
        path: pathOf(state, row),
        matched: "words",
        fields: [],
        ...(outsideSourceOf(row) ? { sourceType: outsideSourceOf(row)!.type } : {}),
        score: 0
      });
    }
  }
  return {
    ranking: "words",
    note: `Ranked by words only, kind by kind: ${where} has no search by meaning.`,
    total: results.length,
    results: results.slice(0, request.limit)
  };
}

/** The portal names every capture's and commitment's source; a hit keeps it only when it is outside text. */
function keepOutsideSource(hit: SearchHit): SearchHit {
  const { sourceType, ...rest } = hit;
  return sourceType !== undefined && outsideSourceOf({ sourceType }) !== undefined ? hit : rest;
}

function rowTitle(row: AnyRecord): string {
  for (const field of TITLE_FIELDS) {
    const value = row[field];
    if (typeof value === "string" && value !== "") return value;
  }
  return String(row.id ?? "");
}

/** "Area › Outcome › Project" for a record that sits under a project or outcome, from the loaded state. */
function pathOf(state: PortalState, row: AnyRecord): string {
  const byId = (key: "areas" | "outcomes" | "projects", id: unknown) =>
    entityItems(state, findEntity(key)!).find((item) => item.id === id);
  const project = typeof row.projectId === "string" ? byId("projects", row.projectId) : undefined;
  const outcome = byId("outcomes", project?.outcomeId ?? row.outcomeId);
  const area = byId("areas", outcome?.areaId ?? row.areaId);
  return [area?.name, outcome?.title, project?.title].filter((part) => typeof part === "string").join(" › ");
}
