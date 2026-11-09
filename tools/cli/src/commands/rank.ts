import {
  consequenceSaveCallTemplate,
  formatAgentCall,
  rankConsequenceGroupCommandSchema,
  type ConsequenceGroupView,
  type RankConsequenceGroupResult
} from "@openrhen/contracts";
import { booleanOption, stringOption, type CommandContext, type CommandSpec, type ParsedArgs } from "../command.js";
import { CliError, EXIT, firstIssueMessage } from "../errors.js";
import { toJson } from "../output.js";
import { DRY_RUN_NOTICE, newCommandId, sendCommand, stampCommandId } from "../write.js";

/**
 * `rank`: refine how much each project (or each action of one project) matters by ranking a few at a time. The server
 * hands out a group of four ("If you could only get one of these done, which would you do?" or "A year from now, which
 * would you most regret never having done?", alternating by local day); the answer is the numbers best first, equal, or
 * skip. Every answer is one `POST /api/commands/consequence`, the same command the portal card and an agent's
 * `rhen_save comparison` use. With nothing answered the plan behaves exactly as before.
 */

const NEXT = "/api/consequence/next";
const ANSWER = "/api/commands/consequence";

export interface ComparisonAnswer {
  groupId: string;
  rankedIds?: readonly string[] | undefined;
  tie?: boolean | undefined;
  wording?: string | undefined;
  /** Why the answer is a tie of no information: shown in the log. */
  evidence?: string | undefined;
}

/** The group as text: the question, the numbered items, and how to answer. */
export function describeGroup(context: CommandContext, group: ConsequenceGroupView): string {
  const inOrder = group.items.map((item) => item.n).join(" ");
  const how = context.mcp
    ? `groupId: ${group.groupId}\nAnswer with ${formatAgentCall(group.answerCall)}`
    : `groupId: ${group.groupId}\n` +
      `Answer with the numbers, best first (reorder them): rhen rank ${inOrder} --group ${group.groupId}\n` +
      `Equal or cannot decide: rhen rank --tie --group ${group.groupId}\n` +
      "Not now: rhen rank --skip\n" +
      "--group makes a retry safe: if the first try's reply was lost, a repeat is refused instead of answering the next group.";
  return [
    group.question,
    ...group.items.map((item) => `  ${item.n}. ${item.title} (${item.stars} star${item.stars === 1 ? "" : "s"})`),
    how,
    ...(group.reissued ? ["(This group was still waiting for an answer.)"] : [])
  ].join("\n");
}

/** Sends one answer: checks it, honours --dry-run, posts it with the invocation's command id, and prints the outcome. */
export async function sendComparison(
  context: CommandContext,
  args: ParsedArgs,
  answer: ComparisonAnswer
): Promise<void> {
  const basis = stringOption(args.values, "basis");
  const evidence = stringOption(args.values, "evidence") ?? answer.evidence;
  const request: Record<string, unknown> = {
    commandId: newCommandId(),
    groupId: answer.groupId,
    ...(answer.tie === true ? { tie: true } : { rankedIds: [...(answer.rankedIds ?? [])] }),
    ...(answer.wording !== undefined ? { wording: answer.wording } : {}),
    ...(basis !== undefined ? { basis } : {}),
    ...(evidence !== undefined ? { evidence } : {})
  };
  const checked = rankConsequenceGroupCommandSchema.safeParse(request);
  if (!checked.success) throw new CliError(firstIssueMessage(checked.error), EXIT.usage);
  const stamped = stampCommandId(context, args, request);
  context.stderr(`rhen: rank group ${answer.groupId}`);
  if (booleanOption(args.values, "dry-run")) {
    context.stdout(
      toJson(
        {
          dryRun: true,
          applied: false,
          commandId: stamped.payload.commandId,
          ...DRY_RUN_NOTICE,
          path: ANSWER,
          payload: stamped.payload
        },
        true
      )
    );
    return;
  }
  // The portal refuses with the group waiting and the exact next call; `sendCommand` raises that as the error text.
  const done = await sendCommand<{ result: RankConsequenceGroupResult }>(
    context.client,
    ANSWER,
    stamped.payload,
    stamped.key
  );
  if (context.mode !== "table") {
    context.stdout(toJson({ applied: true, commandId: stamped.payload.commandId, ...done.result }, true));
    return;
  }
  context.stdout(`${done.result.replayed ? "Already recorded. " : ""}${done.result.next}`);
}

/** The numbers typed after `rank`, as the group's ids best first. */
function idsFromNumbers(group: ConsequenceGroupView, typed: readonly string[]): string[] {
  const count = group.items.length;
  const numbers = typed.map((text) => (/^\d+$/.test(text) ? Number(text) : Number.NaN));
  const valid =
    numbers.length === count &&
    numbers.every((n) => Number.isInteger(n) && n >= 1 && n <= count) &&
    new Set(numbers).size === count;
  if (!valid)
    throw new CliError(
      `Give all ${count} numbers once, best first, like \`rhen rank ${group.items.map((item) => item.n).join(" ")}\` ` +
        `(you gave: ${typed.join(" ") || "none"}). Nothing was changed.`,
      EXIT.usage
    );
  return numbers.map((n) => group.items[n - 1]!.id);
}

export const rankCommand: CommandSpec = {
  name: "rank",
  summary: "Rank a few items to refine how much each one matters",
  description:
    "Shows the next group of items to rank (projects with projects; actions with actions of the same project) with " +
    "numbered items, and the question for today. Answer with the numbers best first (`rank 2 1 4 3`), --tie when they are " +
    "equal or you cannot decide, or --skip to leave it for now; the numbers and --tie need --group <groupId> from the " +
    "group shown (run `rank` with nothing first), so a retry cannot land on the next group. Only the person's answer counts in full: an agent sends " +
    "--basis stated with --evidence (their words), or --basis inferred (a guess, counted at half). Nothing changes until " +
    "you answer; an unanswered group stays the next one.",
  positionals: [
    {
      name: "order",
      required: false,
      description: "The group's numbers, best first, separated by spaces; leave out to just show the group"
    }
  ],
  options: {
    tie: { type: "boolean", description: "The items are equal, or you cannot decide" },
    skip: { type: "boolean", description: "Not now: records no preference and moves the group out of the way" },
    pool: {
      type: "string",
      placeholder: "project|action",
      description: "Rank projects or actions only (default: whichever has been asked least)"
    },
    group: {
      type: "string",
      placeholder: "id",
      description:
        "The groupId shown by `rhen rank`; required with the numbers or --tie (a repeat after a lost reply is then refused)"
    },
    "dry-run": { type: "boolean", description: "Print the answer that would be sent instead of sending it" }
  },
  mutates: true,
  examples: [
    "rank",
    "rank 2 1 4 3 --group <groupId>",
    "rank --tie --group <groupId>",
    "rank --skip",
    "rank --pool action"
  ],
  async run(context, args) {
    const pool = stringOption(args.values, "pool");
    if (pool !== undefined && pool !== "project" && pool !== "action")
      throw new CliError('--pool must be "project" or "action".', EXIT.usage);
    const tie = booleanOption(args.values, "tie");
    const skip = booleanOption(args.values, "skip");
    const typed = args.positionals;
    if ((tie || skip) && typed.length > 0)
      throw new CliError("Give the numbers, or --tie, or --skip: not more than one.", EXIT.usage);
    if (tie && skip) throw new CliError("Give --tie or --skip, not both.", EXIT.usage);
    if ((typed.length > 0 || tie) && stringOption(args.values, "group") === undefined)
      throw new CliError(
        "Answering needs --group <groupId>, so a retry after a lost reply cannot land on the next group. " +
          "To fix this, run `rhen rank` first to see the group, its groupId and the exact answer command, then send " +
          "`rhen rank <numbers best first> --group <groupId>` (or `rhen rank --tie --group <groupId>`). Nothing was changed.",
        EXIT.usage
      );

    const { group } = await context.client.get<{ group: ConsequenceGroupView | null }>(
      pool ? `${NEXT}?pool=${pool}` : NEXT
    );
    if (!group) {
      if (context.mode !== "table") context.stdout(toJson({ group: null }, true));
      else
        context.stdout(
          "Nothing to rank right now: there are fewer than two comparable items, or every pair was asked in the last 30 days."
        );
      return;
    }
    const wanted = stringOption(args.values, "group");
    if (wanted !== undefined && wanted !== group.groupId)
      throw new CliError(
        `Group ${wanted} is no longer the one waiting; the next group is ${group.groupId}. Nothing was changed. Run \`rhen rank\` to see it.`,
        EXIT.conflict
      );
    if (typed.length === 0 && !tie && !skip) {
      if (context.mode !== "table") context.stdout(toJson({ group }, true));
      else context.stdout(describeGroup(context, group));
      return;
    }
    await sendComparison(context, args, {
      groupId: group.groupId,
      wording: undefined,
      ...(tie || skip
        ? { tie: true, ...(skip ? { evidence: "skipped" } : {}) }
        : { rankedIds: idsFromNumbers(group, typed) })
    });
  }
};

/**
 * `save comparison`: the answer to a group as an entity save, for an agent that reads the group from `inbox compare`.
 * Fields: `groupId`, and `rankedIds` (every id once, best first) or `tie: true`; `wording` is optional. The record is a
 * log entry, so there is no id, create or expected version to send.
 */
export async function saveComparison(
  context: CommandContext,
  args: ParsedArgs,
  provided: Record<string, unknown>
): Promise<void> {
  for (const name of ["id", "create", "expected-version"])
    if (args.values[name] !== undefined)
      throw new CliError(
        `A comparison is an answer, not a record: --${name} does not apply. Leave --id, --create and --expected-version off and send: ${consequenceSaveCallTemplate()}`,
        EXIT.usage
      );
  const { groupId, rankedIds, tie, wording } = provided;
  if (typeof groupId !== "string" || groupId.trim() === "")
    throw new CliError(
      `A comparison needs the groupId of the group it answers. Get the group with ${formatAgentCall({ tool: "rhen_inbox", arguments: { room: "compare" } })} ` +
        `(CLI: rhen rank), then send: ${consequenceSaveCallTemplate()}`,
      EXIT.validation
    );
  if (rankedIds !== undefined && (!Array.isArray(rankedIds) || rankedIds.some((id) => typeof id !== "string")))
    throw new CliError(
      `rankedIds must be a list of the group's item ids, best first. Nothing was changed. Send: ${consequenceSaveCallTemplate()}`,
      EXIT.validation
    );
  if (tie !== undefined && typeof tie !== "boolean")
    throw new CliError(
      `tie must be true or false. Nothing was changed. Send: ${consequenceSaveCallTemplate()}`,
      EXIT.validation
    );
  if (wording !== undefined && typeof wording !== "string")
    throw new CliError(
      `wording must be the group's wording name (only_finish_one or most_regret_not_doing), or left out. Nothing was changed. Send: ${consequenceSaveCallTemplate()}`,
      EXIT.validation
    );
  await sendComparison(context, args, {
    groupId,
    ...(tie === true ? { tie: true } : { rankedIds: (rankedIds as string[] | undefined) ?? [] }),
    ...(wording !== undefined ? { wording } : {})
  });
}
