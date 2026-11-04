/**
 * Folds a response's cookies into the jar carried through a sign-in flow, newest value winning.
 *
 * `getSetCookie` rather than `headers.get("set-cookie")`: the latter comma-joins every Set-Cookie
 * into a single string, so reading the text before the first `;` off it keeps the first cookie and
 * silently discards the rest. A flow that lost a cookie this way would fail
 * several hops later with nothing to suggest a missing cookie was the reason.
 */
export function cookieFrom(response: Response, current = ""): string {
  let jar = current;
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(";", 1)[0]?.trim();
    // A malformed entry with no `=` would yield an empty name, and every cookie starts with "" —
    // matching the whole jar and emptying it.
    if (!pair?.includes("=")) continue;
    const name = pair.slice(0, pair.indexOf("=") + 1);
    const kept = jar
      .split(/;\s*/)
      .filter(Boolean)
      .filter((value) => !value.startsWith(name));
    jar = [...kept, pair].join("; ");
  }
  return jar;
}
