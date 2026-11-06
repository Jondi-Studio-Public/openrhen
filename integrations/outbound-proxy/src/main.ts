import { createServer, type ServerResponse } from "node:http";
import { PLACEHOLDER_CREDENTIAL, handleRequest, placeholderCredentialWarnings } from "./server.js";

/** A missing setting is a setup step, not a crash: one line saying what and how to fix it, no stack trace. */
const SETUP_FIX =
  'Run "docker compose run --rm setup" to generate it (it never overwrites a value you set), then "docker compose up -d".';
function refuseToStart(reason: string, fix = SETUP_FIX): never {
  process.stderr.write(`${JSON.stringify({ level: "error", message: `OpenRhen cannot start: ${reason}. ${fix}` })}\n`);
  process.exit(1);
}

const host = process.env.OUTBOUND_PROXY_HOST ?? "0.0.0.0";
const port = integer(process.env.OUTBOUND_PROXY_PORT, 4200);
const token = process.env.OUTBOUND_PROXY_TOKEN ?? "";
if (!token) refuseToStart("OUTBOUND_PROXY_TOKEN is required");
if (token.trim() === PLACEHOLDER_CREDENTIAL) refuseToStart("OUTBOUND_PROXY_TOKEN is still the compose placeholder");

// A provider credential still holding compose.yaml's placeholder is not fatal — that provider's
// routes simply answer "not configured" — but it is easy to miss until something tries to use it.
for (const name of placeholderCredentialWarnings())
  process.stdout.write(
    `${JSON.stringify({
      level: "warn",
      message: "Outbound integrations proxy credential is still the placeholder value",
      variable: name
    })}\n`
  );

const server = createServer(
  (request, response) => void handleRequest(request, response, { token }).catch((error) => failed(response, error))
);
server.requestTimeout = integer(process.env.OUTBOUND_PROXY_REQUEST_TIMEOUT_MS, 30_000);
server.listen(port, host, () =>
  process.stdout.write(
    `${JSON.stringify({ level: "info", message: "Outbound integrations proxy ready", host, port })}\n`
  )
);

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    process.stdout.write(
      `${JSON.stringify({ level: "info", message: "Outbound integrations proxy stopping", signal })}\n`
    );
    server.close((error) => process.exit(error ? 1 : 0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });

/**
 * `handleRequest` wraps each third-party call it makes, but two paths sit outside those wrappers:
 * reading the request body, which rejects with ECONNRESET when a client resets the connection before
 * the body is complete, and /proof's schema parse. Un-caught, either rejection meets Node's default
 * handling and kills the process - and this container is the one holding every third-party
 * credential in the stack, so its death takes every provider down together. Catching
 * here keeps one bad request to one bad request.
 */
function failed(response: ServerResponse, error: unknown) {
  // A reset connection is not a fault, and there is nobody left to answer: record it and let go.
  const aborted = (error as NodeJS.ErrnoException | null)?.code === "ECONNRESET";
  const line = `${JSON.stringify({
    level: aborted ? "info" : "error",
    message: aborted ? "Outbound integrations proxy request aborted" : "Outbound integrations proxy request threw",
    detail: error instanceof Error ? error.message : String(error)
  })}\n`;
  if (aborted) process.stdout.write(line);
  else process.stderr.write(line);
  if (aborted || response.writableEnded) return;
  if (!response.headersSent)
    response.writeHead(502, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify({ error: "The request failed." }));
}

// Belt and braces behind the catch above. Nothing should reach here now, but the default for an
// unhandled rejection is a dead process, and for this service staying up on an unexpected one is
// always the better trade: a request that fails is a failed request, not a failed integration layer.
process.on("unhandledRejection", (reason) =>
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      message: "Outbound integrations proxy unhandled rejection",
      detail: reason instanceof Error ? reason.message : String(reason)
    })}\n`
  )
);

function integer(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
