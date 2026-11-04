import { confirmProjectWantedCommandSchema } from "@openrhen/contracts";
import { requirePositional, type CommandSpec } from "../command.js";
import { CliError, EXIT, firstIssueMessage } from "../errors.js";
import { resolveReference } from "../resolve.js";
import { newCommandId, postCommand, printOutcome } from "../write.js";

const SUBCOMMANDS = ["keep"] as const;
const KINDS = ["keep", "overdue_seen"] as const;

/**
 * `review keep <project>`: the weekly review's Keep. It confirms a project is still wanted, which stamps
 * `lastReviewedAt` and so takes the project off the review's stale list for 30 days. Nothing else writes
 * that field: a `save project` leaves it alone.
 */
export const reviewCommand: CommandSpec = {
  name: "review",
  summary: "Confirm a project is still wanted (the weekly review's Keep)",
  description:
    "keep <project> records, on the server, that the person (or you, on their word) looked at this project and " +
    "still wants it, so the weekly review stops listing it as stale for 30 days even when nothing was worked on. " +
    "With kind=overdue_seen it instead records that the person has seen this project's passed date and is leaving " +
    "it, so the review stops counting it as overdue for the current review week. " +
    "<project> is an id or exact title. It changes only one review time (lastReviewed, or overdueSeen for " +
    "kind=overdue_seen) and bumps the version; it never changes its status, deadlines or anything else. Use it only when the person has said the project " +
    "stays; to pause one, use `save project --set status=paused`; to drop one, use `cancel project`. Applies at once and is " +
    "reversed with `rhen undo`.",
  positionals: [
    { name: "subcommand", required: true, description: `One of: ${SUBCOMMANDS.join(", ")}` },
    { name: "project", required: true, description: "The project's id or exact title" }
  ],
  options: {
    kind: {
      type: "string",
      placeholder: KINDS.join("|"),
      description:
        "keep (the default) holds the project off the stale list for 30 days; overdue_seen marks its overdue date as seen for this review week"
    },
    "dry-run": { type: "boolean", description: "Print the payload instead of sending it" }
  },
  mutates: true,
  examples: [
    'review keep "Thesis"',
    'review keep "Thesis" --kind overdue_seen',
    "review keep project-thesis --dry-run"
  ],
  async run(context, args) {
    const subcommand = requirePositional(reviewCommand, args, 0);
    if (subcommand !== "keep")
      throw new CliError(
        `Unknown review subcommand "${subcommand}". Use one of: ${SUBCOMMANDS.join(", ")}.`,
        EXIT.usage
      );
    const query = requirePositional(reviewCommand, args, 1);
    const kindValue = typeof args.values["kind"] === "string" ? args.values["kind"] : "keep";
    if (!(KINDS as readonly string[]).includes(kindValue))
      throw new CliError(`Unknown kind "${kindValue}". Use one of: ${KINDS.join(", ")}.`, EXIT.usage);
    const seen = kindValue === "overdue_seen";
    const state = await context.client.getState();
    const project = resolveReference(state, "projects", query);
    const projectId = String(project.id);
    const version = project.version;
    if (typeof version !== "number")
      throw new CliError(`Project "${String(project.title)}" has no version to confirm against.`, EXIT.validation);
    const stamp = seen ? project.overdueSeenAt : project.lastReviewedAt;
    const previous = typeof stamp === "string" ? stamp : null;
    const parsed = confirmProjectWantedCommandSchema.safeParse({
      commandId: newCommandId(),
      projectId,
      expectedVersion: version,
      ...(seen ? { kind: "overdue_seen" } : {})
    });
    if (!parsed.success) throw new CliError(firstIssueMessage(parsed.error), EXIT.validation, parsed.error.issues);
    const result = await postCommand(context, args, {
      path: "/api/commands/project-review",
      payload: parsed.data,
      summary: `${seen ? "mark overdue seen on" : "keep"} project "${String(project.title)}" (${projectId})`,
      // Undo puts the earlier review time (or none) back, at the version this write leaves.
      reverse: {
        undo: {
          path: "/api/commands/project-review",
          payload: { ...parsed.data, commandId: newCommandId(), expectedVersion: version + 1, reviewedAt: previous }
        },
        target: { stateKey: "projects", id: projectId }
      }
    });
    if (result.state === null) return;
    printOutcome(context, result.state, {
      stateKey: "projects",
      id: projectId,
      fallback: seen ? "Project marked seen." : "Project kept.",
      timeZone: result.state.settings.timezone
    });
  }
};
