import { createServer } from "node:http";
import { afterEach } from "vitest";
import { handleRequest } from "./server.js";

export const servers: ReturnType<typeof createServer>[] = [];
/** Whatever `handleRequest` rejected with, as main.ts's `failed()` would have received it. */
export const handlerFailures: unknown[] = [];

/** Closes every server a test started and clears the recorded failures; call once at the top of a test file. */
export function installServerHooks() {
  afterEach(async () => {
    handlerFailures.length = 0;
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });
}

export async function start(options: { token?: string } = {}) {
  // The same shape as main.ts: the handler is called for its effect, and the catch is what keeps a
  // rejection from reaching Node's default handling and killing the process.
  const server = createServer(
    (request, response) =>
      void handleRequest(request, response, { token: options.token ?? "test-token" }).catch((error) =>
        handlerFailures.push(error)
      )
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind.");
  return `http://127.0.0.1:${address.port}`;
}
