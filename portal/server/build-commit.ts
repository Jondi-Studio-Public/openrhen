/**
 * The commit this portal image was built from, read from `OPENRHEN_BUILD_COMMIT` (compose.yaml sets it
 * from `IMAGE_TAG`). `dev`, empty and `unknown` mean "not a real build" and read as null, so a local run
 * never claims a commit it does not have.
 */
export const SERVER_COMMIT_HEADER = "x-openrhen-server-commit";

export function serverCommit(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.OPENRHEN_BUILD_COMMIT?.trim() ?? "";
  return raw === "" || raw === "dev" || raw === "unknown" ? null : raw;
}

/** Adds the commit header to a response when the commit is known; a response with immutable headers is copied. */
export function withServerCommit(response: Response, commit: string | null = serverCommit()): Response {
  if (commit === null) return response;
  try {
    response.headers.set(SERVER_COMMIT_HEADER, commit);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    copy.headers.set(SERVER_COMMIT_HEADER, commit);
    return copy;
  }
}
