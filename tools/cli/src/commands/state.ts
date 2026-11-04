import { portalStateSchema } from "@openrhen/contracts";
import { booleanOption, stringOption, type CommandSpec } from "../command.js";
import type { AnyRecord } from "../entities.js";
import { findEntity } from "../entities.js";
import { CliError, EXIT } from "../errors.js";
import { toJson } from "../output.js";

/**
 * Every key `GET /api/state` may carry. Derived from the contract's own shape rather than listed by
 * hand, so a field the contract adds shows up here without a second edit; `planning` is appended
 * because it rides alongside the contract document rather than being part of it (see `client.ts`).
 */
const stateKeys: string[] = [...Object.keys(portalStateSchema.shape), "planning"];

/** A `--key` may name a top-level key directly, or an entity kind (plural, singular, or alias). */
function resolveKey(name: string): string | undefined {
  if (stateKeys.includes(name)) return name;
  return findEntity(name)?.key;
}

/** Over the remote endpoint a key's answer past this many bytes is refused: the whole document costs an agent its context. */
export const REMOTE_STATE_LIMIT_BYTES = 64 * 1024;

const remoteRefusal = (why: string): CliError =>
  new CliError(
    `${why} Use rhen_status for what to do now, rhen_list, rhen_show or rhen_search for ` +
      "records, or rhen_history for past sessions. A small key is allowed.",
    EXIT.usage
  );

export const stateCommand: CommandSpec = {
  name: "state",
  summary: "Dump the whole portal state as JSON",
  description:
    "Prints the full planning document the portal serves, including the engine's latest result under `planning`. " +
    "Meant for jq and for tools that want everything at once; --key narrows it to one top-level key. Over the remote " +
    "server a key is required and an answer over 64 KB is refused: use rhen_status, rhen_list, " +
    "rhen_show, rhen_search or rhen_history instead.",
  positionals: [],
  options: {
    key: { type: "string", placeholder: "name", description: "Only this top-level key, e.g. actions or planning" },
    pretty: { type: "boolean", description: "Indent the JSON" }
  },
  mutates: false,
  examples: ["state --pretty", "state --key planning", "state | jq '.actions | length'"],
  async run(context, args) {
    const keyArg = stringOption(args.values, "key");
    if (context.remote === true && keyArg === undefined)
      throw remoteRefusal(
        "rhen_state without a key returns the whole planning document, which is too large to read here."
      );
    const state = await context.client.getState();
    let value: unknown = state;
    if (keyArg !== undefined) {
      const resolved = resolveKey(keyArg);
      if (resolved === undefined)
        throw new CliError(`Unknown state key "${keyArg}". Keys: ${stateKeys.join(", ")}.`, EXIT.usage);
      // A missing-but-valid key (e.g. `planning` when the portal sent none) prints null, not an error.
      value = (state as unknown as AnyRecord)[resolved] ?? null;
    }
    if (context.remote === true && Buffer.byteLength(JSON.stringify(value), "utf8") > REMOTE_STATE_LIMIT_BYTES)
      throw remoteRefusal(`The "${keyArg}" key is over 64 KB, which is too large to read here.`);
    if (context.mode === "jsonl") {
      if (Array.isArray(value)) for (const item of value) context.stdout(toJson(item));
      else context.stdout(toJson(value));
      return;
    }
    const pretty = booleanOption(args.values, "pretty") || context.mode === "json";
    context.stdout(toJson(value, pretty));
  }
};
