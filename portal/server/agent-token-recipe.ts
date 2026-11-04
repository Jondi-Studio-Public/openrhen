/**
 * The exact line that issues a token with these scopes under this name: nothing left for the agent to fill in. It
 * omits `--direct-writes` on purpose (the flag is optional and defaults to off); the owner turns it on in settings.
 */
export const newTokenFor = (scopes: readonly string[], name = "<agent>") =>
  `\`rhen agent-token create --name ${name} --scopes ${[...new Set(scopes)].join(",")}\``;
