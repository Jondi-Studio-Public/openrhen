import {
  CATCH_UP_BULKS,
  CATCH_UP_SKIP_OLDER_THAN_MAX_DAYS,
  CATCH_UP_VERDICTS,
  settleCatchUpCommandSchema
} from "@openrhen/contracts";
import type { ZodError } from "zod";
import { booleanOption, stringOption, type CommandSpec } from "../command.js";
import { CliError, EXIT, firstIssueMessage } from "../errors.js";
import { toJson } from "../output.js";
import {
  DRY_RUN_NOTICE,
  newCommandId,
  readJsonFile,
  recordServerChecked,
  sendCommand,
  stampCommandId
} from "../write.js";

const BULKS: readonly string[] = CATCH_UP_BULKS;

function parseVerdicts(args: Parameters<CommandSpec["run"]>[1]): unknown[] {
  const inline = stringOption(args.values, "verdicts-json");
  const fromPath = stringOption(args.values, "from");
  const bulk = stringOption(args.values, "bulk");
  if ([inline, fromPath, bulk].filter((value) => value !== undefined).length !== 1)
    throw new CliError("Give exactly one of --verdicts-json, --from or --bulk.", EXIT.usage);
  if (bulk !== undefined) {
    if (!BULKS.includes(bulk)) throw new CliError(`--bulk must be one of ${BULKS.join(", ")}.`, EXIT.usage);
    const day = stringOption(args.values, "day");
    const projectId = stringOption(args.values, "project");
    const daysRaw = stringOption(args.values, "days");
    if (bulk === "skip_older_than") {
      if (daysRaw === undefined) throw new CliError("--bulk skip_older_than needs --days.", EXIT.usage);
      if (day !== undefined || projectId !== undefined)
        throw new CliError("--bulk skip_older_than takes --days only, not --day or --project.", EXIT.usage);
      const days = Number(daysRaw);
      if (!/^\d+$/.test(daysRaw) || !Number.isInteger(days) || days > CATCH_UP_SKIP_OLDER_THAN_MAX_DAYS)
        throw new CliError(`--days must be a whole number from 0 to ${CATCH_UP_SKIP_OLDER_THAN_MAX_DAYS}.`, EXIT.usage);
      return [{ bulk, days }];
    }
    if (daysRaw !== undefined) throw new CliError("--days goes only with --bulk skip_older_than.", EXIT.usage);
    if (bulk === "all_dropped" && projectId === undefined)
      throw new CliError(
        "bulk all_dropped needs project: the id of the one project whose unsettled work is dropped, and only on the " +
          "person's own words. Nothing was changed. List the ids with rhen_list " +
          '{"entity":"projects"}, then call rhen_catch_up_settle {"bulk":"all_dropped","project":"<project id>"}.',
        EXIT.usage
      );
    return [{ bulk, ...(day !== undefined ? { day } : {}), ...(projectId !== undefined ? { projectId } : {}) }];
  }
  if (fromPath !== undefined) {
    const file = readJsonFile(fromPath);
    if (!Array.isArray(file.verdicts)) throw new CliError(`${fromPath} must hold {"verdicts": [...]}.`, EXIT.usage);
    return file.verdicts;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(inline ?? "");
  } catch (error) {
    throw new CliError(
      `--verdicts-json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      EXIT.usage
    );
  }
  if (!Array.isArray(parsed)) throw new CliError("--verdicts-json must be a JSON array of verdicts.", EXIT.usage);
  return parsed;
}

/** The first problem in the caller's words: the argument or verdict key to fix, never a schema path. */
function settleIssueMessage(error: ZodError): string {
  const issue = error.issues[0];
  const [head, index, key] = issue?.path ?? [];
  if (head === "verdicts" && typeof index === "number" && key === "projectId")
    return (
      `verdict ${index + 1} is a bulk all_dropped with no project. Add "projectId":"<project id>" to that verdict ` +
      '(or use the bulk and project arguments). List the ids with rhen_list {"entity":"projects"}.'
    );
  return firstIssueMessage(error);
}

const UNKNOWN_ENTRY = /unknown entry id/i;

/** What one refused entry needs, with the exact next call. */
function problemLine(item: { entryId: string; outcome: string; message?: string }): string {
  const said = (item.message ?? "").trim();
  const reason = said === "" ? "" : ` The portal said: ${said}`;
  if (item.entryId === "wake")
    return (
      `Entry "wake" (the stale wake) was not settled.${reason} A stale wake is settled by rhen_wake ` +
      '{"at":"<ISO time the person woke, with offset>"}, or by this tool with verdict done and the time: ' +
      '{"entryId":"wake","verdict":"done","at":"<ISO time the person woke, with offset>"}.'
    );
  if (UNKNOWN_ENTRY.test(said))
    return (
      `Entry "${item.entryId}" is not on the catch-up ledger: the id is mistyped or it was already settled. ` +
      "Read the current ids with rhen_catch_up {} and pass one of them as entryId."
    );
  const needsAt = /\bat\b/.test(said) || /when/i.test(said);
  return (
    `Entry "${item.entryId}" was not settled${item.outcome === "conflict" ? " because it changed" : ""}.${reason} ` +
    (needsAt
      ? `Repeat that entry with the time added: {"entryId":"${item.entryId}","verdict":"<verdict>","at":"<ISO time with offset>"}.`
      : "Read the ledger again with rhen_catch_up {} and repeat only that entry with a verdict it lists.")
  );
}

interface SettleApplied {
  results: { entryId: string; outcome: string; message?: string }[];
  closed: boolean;
  remaining: number;
}
/** The portal answers `{ result, state }` (plus `revertible` for an agent's settle); the result alone is accepted too. */
interface SettleAnswer {
  result: SettleApplied;
  revertible?: string;
}
interface SettleProposed {
  proposal: { id: string; status: string; summary: string };
  outcome: string;
}

export const catchUpSettleCommand: CommandSpec = {
  name: "catch-up-settle",
  summary: "Record what the person says happened to catch-up entries",
  description:
    "Settles catch-up entries (see `catch-up` for ids and versions). Settle only what the person answered. " +
    'Verdicts are entries ({"entryId","verdict":' +
    `"${CATCH_UP_VERDICTS.join("|")}"` +
    ',"at"?,"remainingMinutes"?,"moveTo"?,"becomes"?:"paused|done","version"?}) or bulk forms: --bulk all_skipped (optionally --day ' +
    "YYYY-MM-DD or --project <id>), --bulk all_dropped --project <id>, or --bulk skip_older_than --days <n>. Give verdicts with --verdicts-json " +
    "'[...]', or --from file.json holding {\"verdicts\":[...]}, or --bulk. --close-window closes the window once " +
    "nothing is left unsettled. --note is what happened instead (recorded with the settle). --basis stated needs the " +
    "person's words in --evidence. As an agent your settle applies at once when your token holds " +
    "write:catch-up and the person has Writes apply directly on (the change log records it); otherwise it returns 202 and waits as one proposal under the " +
    "Inbox's From agents for the person to confirm. See it later with `proposals`. A settle that applied is " +
    "reversed with `rhen undo` (`--redo` puts it back) while nothing it touched has changed since; " +
    "otherwise undo refuses unless `--force`.",
  positionals: [],
  options: {
    "verdicts-json": {
      type: "string",
      mcp: { type: "array", items: "object" },
      placeholder: "json",
      description: "The verdicts, as a JSON array"
    },
    from: {
      type: "string",
      placeholder: "file.json",
      localPath: true,
      description: 'Read {"verdicts": [...]} from a JSON file'
    },
    bulk: { type: "string", placeholder: BULKS.join("|"), description: "One bulk verdict instead of a list" },
    day: { type: "string", placeholder: "YYYY-MM-DD", description: "With --bulk: only this local day" },
    project: { type: "string", placeholder: "projectId", description: "With --bulk: only this project" },
    days: {
      type: "string",
      mcp: { type: "integer", minimum: 0 },
      placeholder: "n",
      description: "With --bulk skip_older_than: skip everything planned more than n days ago"
    },
    "close-window": { type: "boolean", description: "Close the window if nothing remains unsettled" },
    note: { type: "string", placeholder: "text", description: "What happened instead (at most 2000 characters)" },
    "dry-run": { type: "boolean", description: "Print the command that would be sent instead of sending it" }
  },
  mutates: true,
  examples: [
    `catch-up-settle --verdicts-json '[{"entryId":"occurrence:abc","verdict":"done"}]' --basis stated --evidence "yes did that Tuesday"`,
    "catch-up-settle --bulk all_skipped --day 2026-10-12 --close-window",
    "catch-up-settle --bulk skip_older_than --days 7",
    `catch-up-settle --verdicts-json '[{"entryId":"session:<id>","verdict":"ended","at":"2026-10-12T17:30:00<offset>"}]'`,
    `catch-up-settle --verdicts-json '[{"entryId":"deadline:p1","verdict":"pending","moveTo":"2026-11-01T17:00:00<offset>","version":4}]'`
  ],
  async run(context, args) {
    const basis = stringOption(args.values, "basis");
    const evidence = stringOption(args.values, "evidence");
    const note = stringOption(args.values, "note");
    const request: Record<string, unknown> = {
      commandId: newCommandId(),
      verdicts: parseVerdicts(args),
      closeWindow: booleanOption(args.values, "close-window"),
      ...(basis !== undefined ? { basis } : {}),
      ...(evidence !== undefined ? { evidence } : {}),
      ...(note !== undefined ? { note } : {})
    };
    const checked = settleCatchUpCommandSchema.safeParse(request);
    if (!checked.success) throw new CliError(`Settle is invalid: ${settleIssueMessage(checked.error)}`, EXIT.usage);

    const stamped = stampCommandId(context, args, request);
    context.stderr(`rhen: catch-up-settle ${checked.data.verdicts.length} verdict(s)`);
    if (booleanOption(args.values, "dry-run")) {
      context.stdout(
        toJson(
          { dryRun: true, ...DRY_RUN_NOTICE, path: "/api/commands/catch-up-settle", payload: stamped.payload },
          true
        )
      );
      return;
    }
    const result = await sendCommand<SettleApplied | SettleAnswer | SettleProposed>(
      context.client,
      "/api/commands/catch-up-settle",
      stamped.payload,
      stamped.key
    );
    // Only an applied settle can be reverted; a proposal changed nothing yet.
    if (!("proposal" in result))
      recordServerChecked(context, result, {
        path: "/api/commands/catch-up-settle",
        sent: stamped.payload,
        summary: `catch-up-settle ${checked.data.verdicts.length} verdict(s)`
      });
    if (!("proposal" in result)) {
      const answer = "result" in result ? result.result : result;
      const invalid = answer.results.filter((item) => item.outcome === "invalid");
      const conflicts = answer.results.filter((item) => item.outcome === "conflict");
      if (invalid.length + conflicts.length > 0) {
        // Not a success: the entry is still open. The state document the portal sends beside the result is left out.
        const problems = [...invalid, ...conflicts];
        const settled = answer.results.length - problems.length;
        const onlyUnknown = invalid.every((item) => UNKNOWN_ENTRY.test(item.message ?? ""));
        const counts = [
          invalid.length > 0 ? `${invalid.length} refused as invalid` : "",
          conflicts.length > 0
            ? `${conflicts.length} not applied because the entry changed since the ledger was read`
            : ""
        ]
          .filter((part) => part !== "")
          .join(" and ");
        const retry =
          conflicts.length > 0
            ? " Read the ledger again with rhen_catch_up {}, then send the entries that are still listed in a " +
              "new call with a new command-id (the old one would replay this answer)."
            : "";
        throw new CliError(
          `${problems.length} of ${answer.results.length} verdict(s) were not settled: ${counts}; ` +
            `${settled === 0 ? "nothing was changed" : `${settled} others were settled and stay settled`}. ` +
            problems.map(problemLine).join(" ") +
            retry,
          EXIT.validation,
          { results: answer.results, closed: answer.closed, remaining: answer.remaining },
          conflicts.length > 0 || (settled === 0 && onlyUnknown)
            ? { nextCall: { tool: "rhen_catch_up", arguments: {} } }
            : {}
        );
      }
    }
    if (context.mode !== "table") {
      context.stdout(toJson(result, true));
      return;
    }
    if ("proposal" in result) {
      context.stdout(
        `${result.outcome === "created" ? "Proposed" : "Already proposed"} ${result.proposal.id}: not applied. ` +
          "It waits for the person to confirm under Inbox, From agents. See `rhen proposals`."
      );
      return;
    }
    const counts = new Map<string, number>();
    const applied = "result" in result ? result.result : result;
    for (const item of applied.results) counts.set(item.outcome, (counts.get(item.outcome) ?? 0) + 1);
    const summary = [...counts].map(([outcome, count]) => `${count} ${outcome}`).join(", ") || "nothing to settle";
    const problems = applied.results
      .filter((item) => item.outcome === "conflict" || item.outcome === "invalid")
      .map((item) => `  ${item.entryId}: ${item.outcome}${item.message ? ` (${item.message})` : ""}`);
    context.stdout(
      [
        `Settled: ${summary}. ${applied.closed ? "Window closed." : `${applied.remaining} still unsettled.`}`,
        ...problems
      ].join("\n")
    );
  }
};
