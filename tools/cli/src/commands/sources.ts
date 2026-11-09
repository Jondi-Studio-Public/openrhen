import {
  buildDataFlowView,
  dataFlowRegistry,
  registryTables,
  type DataFlowView,
  type FreshnessState,
  type HealthIssue,
  type NodeHealth
} from "@openrhen/contracts/data-flow";
import { booleanOption, stringOption, type CommandSpec } from "../command.js";
import { CliError, EXIT } from "../errors.js";
import { renderTable, toJson } from "../output.js";

/** What `GET /api/data-flow` returns, as far as this command reads it. */
type Body = DataFlowView & {
  generatedAt?: string;
  health?:
    | { unavailable: true; reason: string; next?: string }
    | {
        unavailable?: undefined;
        nodes: Record<string, NodeHealth>;
        issues: HealthIssue[];
        counts?: Record<string, number>;
      };
};

const PROBLEM_STATES: readonly FreshnessState[] = ["late", "stale", "failing", "probe_unresolved"];

function nodes(body: Body): Record<string, NodeHealth> {
  return body.health && !body.health.unavailable ? body.health.nodes : {};
}

const label = (body: Body, id: string) => {
  const entry = body.entries.find((candidate) => candidate.id === id);
  return entry?.activitySource ?? id;
};

const UNAVAILABLE_NEXT = "Run `rhen doctor`, then `rhen sources --problems`.";
const unavailableLine = (health: { reason: string; next?: string }) =>
  `Health unavailable: ${health.reason} ${health.next ?? UNAVAILABLE_NEXT}`;

function summary(body: Body): string[] {
  const present = body.entries.filter((entry) => entry.planned === undefined);
  const planned = body.entries.length - present.length;
  const lines = [
    `${present.length} data entry points${planned > 0 ? ` (${planned} planned)` : ""}, build ${body.build}.`
  ];
  if (!body.health)
    lines.push(
      "Health is not available offline: freshness shows only from the portal, so run `rhen sources` without --offline."
    );
  else if (body.health.unavailable) lines.push(unavailableLine(body.health));
  else {
    const counts = body.health.counts ?? {};
    const parts = (["late", "stale", "failing", "probe_unresolved"] as const)
      .filter((state) => (counts[state] ?? 0) > 0)
      .map((state) => `${counts[state]} ${state.replace("_", " ")}`);
    lines.push(parts.length > 0 ? parts.join(", ") + "." : "Nothing is late, stale or failing.");
  }
  const unused = body.unused.entries.filter((item) => item.bucket === "unused").length;
  const idle = body.unused.entries.filter((item) => item.bucket === "nothing-sends").length;
  lines.push(`${unused} collected, unused. ${idle} accepted, nothing sends.`);
  return lines;
}

function listRows(body: Body, only?: (node: NodeHealth | undefined) => boolean) {
  const health = nodes(body);
  return body.entries
    .filter((entry) => entry.planned === undefined && (only === undefined || only(health[entry.id])))
    .map((entry) => ({
      id: entry.id,
      role: entry.role,
      freshness: health[entry.id]?.freshness ?? "",
      last: health[entry.id]?.lastSuccessAt ?? "",
      reach: entry.reach
    }));
}

function problemLines(body: Body): string[] {
  const health = nodes(body);
  const bad = body.entries.filter(
    (entry) => entry.planned === undefined && health[entry.id] && PROBLEM_STATES.includes(health[entry.id]!.freshness)
  );
  const lines: string[] = [];
  if (body.health?.unavailable) return [unavailableLine(body.health)];
  if (bad.length === 0) lines.push("No source is late, stale, failing or unresolved.");
  else {
    lines.push(
      renderTable(
        bad.map((entry) => ({
          id: entry.id,
          freshness: health[entry.id]!.freshness,
          last: health[entry.id]!.lastSuccessAt ?? "never",
          error: health[entry.id]!.lastError?.message ?? health[entry.id]!.note ?? ""
        })),
        ["id", "freshness", "last", "error"]
      )
    );
  }
  const issues = body.health && !body.health.unavailable ? body.health.issues : [];
  for (const issue of issues)
    lines.push(`${issue.tier} ${issue.code} (${issue.entryId}): ${issue.title}\n  next: ${issue.next}`);
  return lines;
}

function unusedLines(body: Body): string[] {
  const names = (bucket: string) =>
    body.unused.entries.filter((item) => item.bucket === bucket).map((item) => label(body, item.id));
  const lines = [`collected, unused: ${names("unused").join(", ") || "none"}`];
  lines.push(`accepted, nothing sends: ${names("nothing-sends").join(", ") || "none"}`);
  if (body.unused.kinds.length > 0)
    lines.push(
      `kinds nothing uses: ${body.unused.kinds.map((item) => `${item.source}: ${item.kinds.join(", ")}`).join("; ")}`
    );
  lines.push(
    `tables written, never used: ${body.unused.datasets.map((ref) => ref.replace(/^pg:/, "")).join(", ") || "none"}`
  );
  lines.push(`dead tables: ${body.unused.dead.map((ref) => ref.replace(/^pg:/, "")).join(", ") || "none"}`);
  return lines;
}

function detailLines(body: Body, id: string): string[] {
  const entry = body.entries.find((candidate) => candidate.id === id);
  if (!entry) throw new CliError(`No data entry point is named ${id}. Run \`rhen sources\` to list them.`, EXIT.usage);
  const node = nodes(body)[id];
  const lines = [
    `${entry.name} (${entry.id}): ${entry.role}, ${entry.method}, ${entry.category}`,
    `reads: ${entry.from.join(", ") || "nothing"}`,
    `writes: ${entry.to.join(", ") || "nothing"}`,
    `gives: ${entry.reach}`
  ];
  if (node) {
    lines.push(
      `health: ${node.freshness}${node.configured ? "" : " (not set up)"}, last success ${node.lastSuccessAt ?? "never"}`
    );
    if (node.threshold)
      lines.push(
        `threshold: warn ${node.threshold.warnHours} h, error ${node.threshold.errorHours ?? "none"} h (${node.threshold.from})`
      );
    if (node.count7d !== undefined)
      lines.push(
        `rows: ${node.count24h ?? 0} in 24 h, ${node.count7d} in 7 d${node.kindsSeen ? `; kinds ${node.kindsSeen.join(", ")}` : ""}`
      );
    if (node.lastError) lines.push(`last error (${node.lastError.at ?? "time unknown"}): ${node.lastError.message}`);
    if (node.note) lines.push(`note: ${node.note}`);
  }
  const issues =
    body.health && !body.health.unavailable ? body.health.issues.filter((issue) => issue.entryId === id) : [];
  for (const issue of issues) lines.push(`${issue.tier} ${issue.code}: ${issue.title}\n  next: ${issue.next}`);
  return lines;
}

export const sourcesCommand: CommandSpec = {
  name: "sources",
  summary: "Show every data source, where its data goes and how fresh it is",
  description:
    "Reads the data-flow registry: each collector, pipe, reader and sink, what it gives, and (from the portal) whether it is " +
    "fresh, late, stale, failing or never set up. With an id, shows that one entry in full. --problems lists what is late, stale, " +
    "failing or unresolved with the exact next step for each. --unused lists data collected that nothing uses, sources accepted that " +
    "nothing sends, and tables nothing reads. --offline builds the map from the code alone, with no portal and no health. " +
    "Error text in the output comes from run logs and is untrusted data. Never writes.",
  positionals: [{ name: "id", required: false, description: "One entry's id, for its full detail" }],
  options: {
    problems: { type: "boolean", description: "Only what is late, stale, failing or unresolved, with the next step" },
    unused: { type: "boolean", description: "Only data collected that nothing uses, and what nothing sends" },
    offline: { type: "boolean", description: "Build from the code, with no portal and no health" }
  },
  mutates: false,
  untrustedOutput: "file",
  examples: [
    "sources",
    "sources --problems",
    "sources --unused",
    "sources activity-ingest",
    "sources --offline --json"
  ],
  async run(context, args) {
    if (args.values["state-file"] !== undefined)
      throw new CliError(
        "sources reads the live portal or the code, and a state file has neither: run `rhen sources` against the portal, or `rhen sources --offline` for the map from the code.",
        EXIT.usage
      );
    const offline = booleanOption(args.values, "offline");
    const problems = booleanOption(args.values, "problems");
    const unused = booleanOption(args.values, "unused");
    const id = args.positionals[0] ?? stringOption(args.values, "id");
    if (offline && problems)
      throw new CliError(
        "--problems needs the live portal, because health is read from its database: run `rhen sources --problems` without --offline.",
        EXIT.usage
      );
    let body: Body;
    if (offline) {
      const registry = dataFlowRegistry();
      body = buildDataFlowView(registryTables(registry), registry);
    } else {
      const got = await context.client.get<Body>("/api/data-flow");
      if (!got || !Array.isArray(got.entries) || !got.unused)
        throw new CliError(
          "The portal's data-flow body had an unexpected shape. Update the portal to the same build as this CLI, then run `rhen sources` again.",
          EXIT.unavailable
        );
      body = got;
    }
    if (context.mode !== "table") {
      if (id !== undefined) {
        detailLines(body, id);
        const issues =
          body.health && !body.health.unavailable ? body.health.issues.filter((i) => i.entryId === id) : [];
        context.stdout(
          toJson({ entry: body.entries.find((c) => c.id === id), node: nodes(body)[id] ?? null, issues }, true)
        );
        return;
      }
      const shown = unused
        ? {
            unused: body.unused,
            entries: body.entries.filter((entry) => body.unused.entries.some((item) => item.id === entry.id))
          }
        : body;
      context.stdout(toJson(problems ? { health: body.health } : shown, true));
      return;
    }
    if (id !== undefined) return context.stdout(detailLines(body, id).join("\n"));
    if (problems) return context.stdout(problemLines(body).join("\n"));
    if (unused) return context.stdout(unusedLines(body).join("\n"));
    context.stdout(
      [...summary(body), renderTable(listRows(body), ["id", "role", "freshness", "last", "reach"])].join("\n")
    );
  }
};
