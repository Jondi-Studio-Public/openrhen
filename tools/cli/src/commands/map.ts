import { parsePositiveInt, stringOption, booleanOption, requirePositional, type CommandSpec } from "../command.js";
import { CliError, EXIT } from "../errors.js";
import { localiseInstants, toJson } from "../output.js";
import { formatClock } from "../when.js";
import { buildPlanIndex } from "../plan-map/derive.js";
import { navigate, parseKinds, resolveItem } from "../plan-map/navigate.js";
import type { Card } from "../plan-map/model.js";
import { ALL_KINDS } from "../plan-map/model.js";
import { portalLinkSource, readStoredLinks } from "../plan-map/stored-links.js";

const DEFAULT_BUDGET = 1500;
const MAX_DEPTH = 4;

export const mapCommand: CommandSpec = {
  name: "map",
  summary: "Show one plan item and its neighbourhood: cards and the links between them",
  description:
    "Reads the plan as a small neighbourhood instead of loading all of it. One call returns the item's card and " +
    "the cards around it, plus the edges between them: parent and child, depends on, criterion, blocker, prep, " +
    "and the shared place, contact or source two items have in common. Cards and edges are computed from the " +
    "current plan on every call, so they are never stale. Neighbours are ranked before --budget trims them: " +
    "confirmed links before suggested, judgement before derived, open before done, nearer dates first. " +
    "<item> is a handle like project:project-thesis, a bare id or unique id prefix, or an exact title. Read-only. " +
    "Stored links (about, prepares, before ...) are read once the link store exists; until then the map is " +
    "derived links only and --json says so under storedLinks.",
  positionals: [
    {
      name: "item",
      required: true,
      description: "Handle (project:project-thesis), id or unique id prefix, or exact title"
    }
  ],
  options: {
    depth: {
      type: "string",
      mcp: { type: "integer", minimum: 1, maximum: 4 },
      placeholder: "n",
      description: `How many links out to walk (default 1, max ${MAX_DEPTH})`
    },
    kinds: {
      type: "string",
      placeholder: "a,b",
      description: `Only follow these link kinds, comma separated. Kinds: ${ALL_KINDS.join(", ")}`
    },
    budget: {
      type: "string",
      mcp: { type: "integer", minimum: 1 },
      placeholder: "tokens",
      description: `Approximate size of the answer, cards and link lines together; lowest-ranked neighbours are dropped to fit (default ${DEFAULT_BUDGET})`
    },
    suggested: { type: "boolean", description: "Also include suggested stored links, flagged as suggested" }
  },
  mutates: false,
  examples: [
    "map project:project-thesis",
    "map action-thesis-draft --depth 2 --kinds depends_on,parent_child --json",
    'map "Thesis" --budget 400'
  ],
  async run(context, args) {
    const query = requirePositional(mapCommand, args, 0);
    const depth = parsePositiveInt(args, "depth") ?? 1;
    if (depth > MAX_DEPTH) throw new CliError(`--depth is at most ${MAX_DEPTH}.`, EXIT.usage);
    const budget = parsePositiveInt(args, "budget") ?? DEFAULT_BUDGET;
    const kinds = parseKinds(stringOption(args.values, "kinds"));

    const state = await context.client.getState();
    const index = buildPlanIndex(state);
    const root = resolveItem(index, query);
    const stored = await readStoredLinks(context.storedLinks ?? portalLinkSource(context.client));
    const result = navigate(index, root, {
      depth,
      kinds,
      budget,
      stored: stored.links,
      includeSuggested: booleanOption(args.values, "suggested"),
      now: context.now()
    });
    const timeZone = state.settings.timezone;

    if (context.mode === "json" || context.mode === "jsonl") {
      const doc = {
        ...result,
        depth,
        storedLinks: stored.state,
        ...(stored.error ? { storedLinksError: stored.error } : {})
      };
      context.stdout(toJson(localiseInstants(doc, timeZone), true));
      return;
    }

    const lines = [cardLine(result.root, timeZone)];
    for (const card of result.cards) lines.push(`  ${cardLine(card, timeZone)}`);
    if (result.edges.length > 0) {
      lines.push("", "Links");
      for (const edge of result.edges)
        lines.push(
          `  ${edge.from} --${edge.kind}${edge.status === "suggested" ? " (suggested)" : ""}--> ${edge.to}` +
            (edge.evidence ? `  ${edge.evidence}` : "")
        );
    }
    if (result.omitted > 0)
      lines.push("", `+${result.omitted} more neighbours cut by --budget ${budget}; raise it or narrow with --kinds.`);
    if (stored.state === "unavailable")
      lines.push("", "Stored links are not available yet; this map shows derived links only.");
    if (stored.state === "error")
      lines.push("", `Stored links could not be read (${stored.error}); this map shows derived links only.`);
    context.stdout(lines.join("\n"));
  }
};

/** One line per card: enough for an agent to decide whether to look closer. */
function cardLine(card: Card, timeZone: string): string {
  const parts = [`${card.handle}  ${card.title}`];
  if (card.status) parts.push(`[${card.status}]`);
  if (card.when) parts.push(`${card.type === "commitment" ? "at" : "due"} ${formatClock(card.when, timeZone)}`);
  const counts: string[] = [];
  if (card.parent) counts.push(`in ${card.parent}`);
  if (card.steps > 0) counts.push(`${card.steps} ${card.steps === 1 ? "step" : "steps"}`);
  if (card.openBlockers > 0) counts.push(`${card.openBlockers} open blocker${card.openBlockers === 1 ? "" : "s"}`);
  if (card.links > 0) counts.push(`${card.links} ${card.links === 1 ? "link" : "links"}`);
  let line = parts.join(" ");
  if (counts.length > 0) line += ` · ${counts.join(" · ")}`;
  if (card.detail) line += ` — ${card.detail}`;
  return line;
}
