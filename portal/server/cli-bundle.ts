import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { serverCommit } from "@/server/build-commit";

/** The literal esbuild's `define` leaves in the bundle built in Docker (`scripts/build.mjs`), quotes included. */
export const COMMIT_SENTINEL = JSON.stringify("__SERVER_COMMIT__");
const DEFAULT_PATH = "/app/cli/rhen.mjs";

export interface CliBundle {
  text: string;
  sha256: string;
  bytes: number;
}

/**
 * Reads the agent CLI bundle baked into the image and stamps the server's commit over the build
 * sentinel, so the served CLI knows which portal build it matches. With an unknown commit the bundle
 * is served unstamped (it then reads as "dev" and never warns). Null when no bundle is present.
 * The hash covers the stamped bytes, which are exactly what `/api/cli/bundle` sends.
 */
export async function loadCliBundle(
  env: Record<string, string | undefined> = process.env,
  commit: string | null = serverCommit(env)
): Promise<CliBundle | null> {
  const path = env.OPENRHEN_CLI_BUNDLE_PATH?.trim() || DEFAULT_PATH;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const text = commit === null ? raw : raw.split(COMMIT_SENTINEL).join(JSON.stringify(commit));
  const buffer = Buffer.from(text, "utf8");
  return { text, sha256: createHash("sha256").update(buffer).digest("hex"), bytes: buffer.length };
}
