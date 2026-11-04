/**
 * The exact line that issues a token with these scopes under this name: nothing left for the agent to fill in. It
 * omits `--direct-writes` on purpose (the flag is optional and defaults to off); the owner turns it on in settings.
 */
export const newTokenFor = (scopes: readonly string[], name = "<agent>") =>
  `\`rhen agent-token create --name ${name} --scopes ${[...new Set(scopes)].join(",")}\``;

/**
 * Replacing an expired token: it is still "live" in the name index (only a revoke frees the name), so a bare
 * `create --name <same>` always fails with a 409. Revoke first, then create.
 */
export const replaceExpiredTokenFor = (scopes: readonly string[], name: string) =>
  `\`rhen agent-token revoke ${name}\`, then ${newTokenFor(scopes, name)}`;
