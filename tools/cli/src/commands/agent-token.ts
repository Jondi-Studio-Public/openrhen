import {
  AGENT_SCOPE_PRESETS,
  AGENT_TOKEN_DEFAULT_EXPIRY_DAYS,
  allDirectWritesOn,
  DIRECT_WRITE_CLASSES,
  DIRECT_WRITE_MODES,
  directWritesSchema,
  resolveScopeList,
  type AgentTokenSummary
} from "@openrhen/contracts";
import { requirePositional, stringOption, type CommandSpec, type OptionValues } from "../command.js";
import { CliError, EXIT } from "../errors.js";
import { emitRows, toJson } from "../output.js";

const ACTIONS = ["create", "list", "revoke"] as const;

/**
 * `--direct-writes on` turns every entity class on and `off` leaves them all off (the default). It also takes
 * `action=on,commitment=shadow` (repeatable): which entity classes may land as facts. Entries apply in order, so
 * `on,commitment=off` is everything but commitments.
 */
export function parseDirectWrites(values: OptionValues): Record<string, string> {
  const raw = values["direct-writes"];
  const entries = (raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]).flatMap((item) =>
    String(item)
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
  );
  const map: Record<string, string> = {};
  for (const entry of entries) {
    if (entry === "on" || entry === "off") {
      for (const key of Object.keys(map)) delete map[key];
      if (entry === "on") Object.assign(map, allDirectWritesOn());
      continue;
    }
    const [key, mode, ...extra] = entry.split("=");
    if (!key || !mode || extra.length > 0 || !(DIRECT_WRITE_MODES as readonly string[]).includes(mode))
      throw new CliError(`--direct-writes needs class=${DIRECT_WRITE_MODES.join("|")}, got "${entry}".`, EXIT.usage);
    map[key.trim()] = mode;
  }
  const checked = directWritesSchema.safeParse(map);
  if (!checked.success)
    throw new CliError(
      `${checked.error.issues[0]?.message ?? "Bad --direct-writes."} Classes: ${DIRECT_WRITE_CLASSES.join(", ")}.`,
      EXIT.usage
    );
  return map;
}

const state = (token: AgentTokenSummary, now: Date): string =>
  token.revokedAt ? "revoked" : new Date(token.expiresAt).getTime() <= now.getTime() ? "expired" : "active";

export const agentTokenCommand: CommandSpec = {
  name: "agent-token",
  summary: "Issue, list and revoke scoped agent tokens (owner only)",
  description:
    "The owner's tool for giving an agent a scoped token. `create` " +
    "prints the token once on stdout and never again; set it as OPENRHEN_TOKEN in the agent's own environment. " +
    "`list` shows each token's scopes, direct-write modes, last use and expiry, never the secret. `revoke` ends " +
    "one at once; to rotate, revoke and create again. Scopes are a comma list or a preset (" +
    `${Object.keys(AGENT_SCOPE_PRESETS).join(", ")}). --direct-writes on lets the agent's writes apply at once for ` +
    "every entity class, with each one listed and undoable (an agent that OAuth approves gets this); " +
    "class=on does it for one class, and class=shadow records what would have applied while still proposing. " +
    "Deletes, settings and anything sent outward wait for you either way. The default is off for every class. The portal refuses these commands from any request that carries an agent identity, and " +
    "they are not offered over MCP. With OPENRHEN_OWNER_AUTH=require they need your owner token " +
    "(OPENRHEN_OWNER_TOKEN, see owner-token); otherwise a caller that sends no identity counts as the owner, " +
    "so keep OPENRHEN_TOKEN out of the shell you run this in.",
  positionals: [
    { name: "action", required: true, description: `${ACTIONS.join(", ")}` },
    { name: "name-or-id", required: false, description: "For revoke: the token's agent name or id" }
  ],
  options: {
    name: { type: "string", placeholder: "agent", description: "create: the agent name (a-z, 0-9, _ or -; 1 to 32)" },
    scopes: {
      type: "string",
      placeholder: "preset|a,b",
      description: `create: a preset (${Object.keys(AGENT_SCOPE_PRESETS).join(", ")}) or a comma list of scopes`
    },
    "expires-days": {
      type: "string",
      placeholder: "n",
      description: `create: days until the token expires (default ${AGENT_TOKEN_DEFAULT_EXPIRY_DAYS}, max 365)`
    },
    "direct-writes": {
      type: "string",
      multiple: true,
      placeholder: "on|off|class=on|shadow|off",
      description:
        "create: on = every entity class applies directly; or class=mode for one class (repeatable or comma list); default off"
    }
  },
  mutates: true,
  ownerOnly: true,
  examples: [
    "agent-token create --name companion --scopes scribe",
    "agent-token create --name openclaw --scopes assistant --direct-writes on",
    "agent-token create --name companion --scopes assistant --direct-writes action=shadow --expires-days 30",
    "agent-token list",
    "agent-token revoke companion"
  ],
  async run(context, args) {
    const action = requirePositional(agentTokenCommand, args, 0);
    if (!(ACTIONS as readonly string[]).includes(action))
      throw new CliError(`agent-token ${action} is not a subcommand; use ${ACTIONS.join(", ")}.`, EXIT.usage);
    if (args.values["state-file"] !== undefined) throw new CliError("agent-token needs the live portal.", EXIT.usage);

    if (action === "list") {
      const { tokens } = await context.client.get<{ tokens: AgentTokenSummary[] }>("/api/agent-tokens");
      const now = context.now();
      const rows = tokens.map((token) => ({
        ...token,
        state: state(token, now),
        scopes: token.scopes.join(" "),
        directWrites: Object.entries(token.directWrites)
          .map(([key, mode]) => `${key}=${mode}`)
          .join(" ")
      }));
      emitRows(
        { mode: context.mode, stdout: context.stdout },
        context.mode === "table" ? rows : tokens.map((token) => ({ ...token, state: state(token, now) })),
        ["name", "state", "scopes", "directWrites", "lastUsedAt", "expiresAt", "id"]
      );
      return;
    }

    if (action === "revoke") {
      const target = requirePositional(agentTokenCommand, args, 1);
      const { tokens } = await context.client.get<{ tokens: AgentTokenSummary[] }>("/api/agent-tokens");
      const match = tokens.find((token) => !token.revokedAt && (token.id === target || token.name === target));
      if (!match) throw new CliError(`No live token is named or numbered "${target}".`, EXIT.notFound);
      const { agentToken } = await context.client.del!<{ agentToken: AgentTokenSummary }>(
        `/api/agent-tokens/${match.id}`
      );
      if (context.mode !== "table") context.stdout(toJson(agentToken, true));
      else context.stdout(`Revoked the token for ${match.name}; it stops working on its next request.`);
      return;
    }

    const name = stringOption(args.values, "name");
    const scopesRaw = stringOption(args.values, "scopes");
    if (name === undefined || scopesRaw === undefined)
      throw new CliError("agent-token create needs --name and --scopes.", EXIT.usage);
    const scopes = resolveScopeList(scopesRaw);
    if (!scopes.ok) throw new CliError(`--scopes: ${scopes.reason}`, EXIT.usage);
    const expiresRaw = stringOption(args.values, "expires-days");
    const expiresInDays = expiresRaw === undefined ? undefined : Number(expiresRaw);
    if (expiresInDays !== undefined && !Number.isInteger(expiresInDays))
      throw new CliError("--expires-days must be a whole number.", EXIT.usage);
    const payload = {
      name,
      scopes: scopes.scopes,
      directWrites: parseDirectWrites(args.values),
      ...(expiresInDays === undefined ? {} : { expiresInDays })
    };
    const { token, agentToken } = await context.client.post<{ token: string; agentToken: AgentTokenSummary }>(
      "/api/agent-tokens",
      payload
    );
    // Shown once. Only stdout carries the secret, so `$t = rhen agent-token create ...` captures just it.
    context.stderr(
      `rhen: token for "${agentToken.name}" (expires ${agentToken.expiresAt.slice(0, 10)}). ` +
        "It is shown only now: store it in your secrets manager and set it as OPENRHEN_TOKEN in the agent's environment."
    );
    if (context.mode === "table") context.stdout(token);
    else context.stdout(toJson({ token, agentToken }, true));
  }
};
