import type { CommandContext, CommandSpec } from "../command.js";
import { CliError, EXIT } from "../errors.js";
import { guideOverviewFor, guideTopicsFor } from "../guide-content.js";
import { toJson } from "../output.js";

/** The topics this run serves: the remote `/mcp` leaves out the ones that need commands it does not serve. */
function topicsFor(context: CommandContext) {
  return guideTopicsFor(context.remote === true ? "remote" : "stdio");
}

function renderOverview(context: CommandContext): string {
  const topicLines = topicsFor(context).map((topic) => `  ${topic.name} — ${topic.summary}`);
  return [guideOverviewFor(context.remote === true ? "remote" : "stdio"), "", "Topics:", ...topicLines].join("\n");
}

export const guideCommand: CommandSpec = {
  name: "guide",
  summary: "The domain vocabulary and common workflows, for people and AI tools",
  description:
    "Teaches the domain OpenRhen operates in — the hierarchy, the entities, and how the CLI commands compose " +
    "into working recipes — so a fresh session can operate the CLI without reading the repo. With no topic, " +
    "prints an overview and the list of topics. `guide <topic>` prints one topic: vocabulary, workflows, " +
    "writing-data, reading-data, recurrence, limits, or coordinating. This teaches the domain, not the CLI flags; use " +
    '"rhen help <command>" for those.',
  positionals: [
    {
      name: "topic",
      required: false,
      description:
        "vocabulary, workflows, writing-data, reading-data, recurrence, limits, or coordinating; omit for the overview"
    }
  ],
  options: {},
  mutates: false,
  offline: true,
  examples: ["guide", "guide vocabulary", "guide workflows --json", "guide limits", "guide coordinating"],
  async run(context, args) {
    const topicArg = args.positionals[0];

    if (topicArg === undefined) {
      if (context.mode !== "table") {
        context.stdout(
          toJson(
            {
              overview: guideOverviewFor(context.remote === true ? "remote" : "stdio"),
              topics: topicsFor(context).map((topic) => ({ name: topic.name, summary: topic.summary }))
            },
            true
          )
        );
        return;
      }
      context.stdout(renderOverview(context));
      return;
    }

    const topics = topicsFor(context);
    const wanted = topicArg.trim().toLowerCase();
    const topic = topics.find((entry) => entry.name === wanted);
    if (!topic)
      throw new CliError(
        `Unknown guide topic "${topicArg}". Topics: ${topics.map((entry) => entry.name).join(", ")}.`,
        EXIT.usage
      );

    if (context.mode !== "table") {
      context.stdout(toJson({ topic: topic.name, text: topic.text }, true));
      return;
    }
    context.stdout(topic.text);
  }
};
