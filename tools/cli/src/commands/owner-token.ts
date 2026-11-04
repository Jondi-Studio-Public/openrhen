import type { OwnerCredentialSummary } from "@openrhen/contracts";
import { requirePositional, stringOption, type CommandSpec } from "../command.js";
import { CliError, EXIT } from "../errors.js";
import { emitRows, toJson } from "../output.js";

const ACTIONS = ["create", "list", "revoke"] as const;

const state = (credential: OwnerCredentialSummary, now: Date): string =>
  credential.revokedAt
    ? "revoked"
    : credential.expiresAt && new Date(credential.expiresAt).getTime() <= now.getTime()
      ? "expired"
      : "active";

export const ownerTokenCommand: CommandSpec = {
  name: "owner-token",
  summary: "Make, list and revoke owner tokens and enrolled browsers (owner only)",
  description:
    "The owner's own credentials. `create` prints an " +
    "owner token once on stdout and never again; keep it in your secrets manager and set it as OPENRHEN_OWNER_TOKEN in YOUR " +
    "shell only. The CLI sends it as X-OpenRhen-Owner, and never when the run names an agent (--agent, " +
    "OPENRHEN_AGENT) or holds an agent token. `list` shows owner tokens and enrolled browsers with last use, " +
    "never a secret. `revoke` ends one at once, by label or id. When the portal runs with OPENRHEN_OWNER_AUTH=" +
    "require, every write needs this token or an enrolled browser; an agent that finds the token in its " +
    "environment can use it, so never export it where an agent runs. These commands are not offered over MCP.",
  positionals: [
    { name: "action", required: true, description: ACTIONS.join(", ") },
    { name: "label-or-id", required: false, description: "For revoke: the credential's label or id" }
  ],
  options: {
    label: { type: "string", placeholder: "text", description: "create: what to call this token (default Owner token)" }
  },
  mutates: true,
  ownerOnly: true,
  examples: ["owner-token create --label laptop-shell", "owner-token list", "owner-token revoke laptop-shell"],
  async run(context, args) {
    const action = requirePositional(ownerTokenCommand, args, 0);
    if (!(ACTIONS as readonly string[]).includes(action))
      throw new CliError(`owner-token ${action} is not a subcommand; use ${ACTIONS.join(", ")}.`, EXIT.usage);
    if (args.values["state-file"] !== undefined) throw new CliError("owner-token needs the live portal.", EXIT.usage);

    if (action === "list") {
      const { credentials } = await context.client.get<{ credentials: OwnerCredentialSummary[] }>(
        "/api/owner/credentials"
      );
      const now = context.now();
      emitRows(
        { mode: context.mode, stdout: context.stdout },
        credentials.map((credential) => ({ ...credential, state: state(credential, now) })),
        ["label", "kind", "state", "lastUsedAt", "expiresAt", "id"]
      );
      return;
    }

    if (action === "revoke") {
      const target = requirePositional(ownerTokenCommand, args, 1);
      const { credentials } = await context.client.get<{ credentials: OwnerCredentialSummary[] }>(
        "/api/owner/credentials"
      );
      const match = credentials.find(
        (credential) => !credential.revokedAt && (credential.id === target || credential.label === target)
      );
      if (!match) throw new CliError(`No live credential is labelled or numbered "${target}".`, EXIT.notFound);
      const { credential } = await context.client.del!<{ credential: OwnerCredentialSummary }>(
        `/api/owner/credentials/${match.id}`
      );
      if (context.mode !== "table") context.stdout(toJson(credential, true));
      else context.stdout(`Revoked "${match.label}"; it stops working on its next request.`);
      return;
    }

    const label = stringOption(args.values, "label");
    const { token, credential } = await context.client.post<{ token: string; credential: OwnerCredentialSummary }>(
      "/api/owner/credentials",
      label === undefined ? {} : { label }
    );
    // Shown once. Only stdout carries the secret, so `$t = rhen owner-token create` captures just it.
    context.stderr(
      `rhen: owner token "${credential.label}". It is shown only now: store it in your secrets manager and set ` +
        "OPENRHEN_OWNER_TOKEN in your own shell, never where an agent runs."
    );
    if (context.mode === "table") context.stdout(token);
    else context.stdout(toJson({ token, credential }, true));
  }
};
