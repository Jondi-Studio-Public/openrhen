import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AGENT_HEADER, TOKEN_HEADER, parseAgentName, withoutOwnerToken } from "../agent.js";
import { buildLineContext, handleLine, type LineContext } from "./mcp.js";

/**
 * `rhen mcp --http`: the same tool table `rhen mcp` serves over stdio, over MCP's
 * Streamable HTTP transport instead, for clients (ChatGPT desktop's connectors, for example) that
 * take a remote HTTP endpoint and cannot spawn a local process. See
 * The cli deliverables design note, "Remote transport".
 *
 * Deliberately minimal against the full Streamable HTTP spec: this server never pushes a message the
 * client did not ask for (`tools/list` never changes mid-session, and every `tools/call` result is
 * already complete by the time `handleToolsCall` returns), so there is nothing here that needs the
 * spec's optional server-initiated SSE stream. One POST endpoint, one JSON-RPC request or batch in,
 * one JSON response out.
 *
 * Three checks stand between an arbitrary local process and this server, and all three are mandatory,
 * not configurable:
 *
 * - **Loopback only.** The server binds `127.0.0.1`, never `0.0.0.0`, with no flag to widen it — the
 *   household network never needs to reach this, only whatever runs on this same machine.
 * - **A bearer token.** Every request needs `Authorization: Bearer <token>`, checked in constant time.
 *   `OPENRHEN_MCP_TOKEN` supplies it; unset, one is generated and printed once at startup, and
 *   exists only for that process's lifetime.
 * - **Origin and Host validation.** A browser on the same machine can reach a loopback server through
 *   DNS rebinding (a public DNS name that resolves to 127.0.0.1) even though it could never reach it
 *   directly, so both headers are checked against loopback regardless of the bearer token.
 */

export interface HttpMcpOptions {
  port: number;
  token: string;
  log: (line: string) => void;
  /** Overridable for tests; defaults to the real registry-backed context. */
  buildContext?: () => Promise<LineContext>;
}

export interface HttpMcpServer {
  port: number;
  close: () => Promise<void>;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function hostIsLoopback(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.split(":")[0] ?? "";
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

function originIsLoopback(originHeader: string | undefined): boolean {
  // No Origin header at all is normal for a non-browser HTTP client (curl, an MCP SDK's HTTP client)
  // and is not itself a rebinding attempt — only a same-origin browser request carries this header,
  // and dropping requests that never had one would just break every ordinary client.
  if (!originHeader) return true;
  try {
    const url = new URL(originHeader);
    return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function timingSafeTokenMatch(expected: string, provided: string): boolean {
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

function bearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

/** Far above any real tool call; bounds what one local client can make this process hold. */
export const MAX_BODY_BYTES = 1024 * 1024;
/** JSON-RPC calls in one batch; each runs a whole command, so an unbounded batch is unbounded work. */
export const MAX_BATCH = 50;

/** Past this the client is not a confused caller but a stream; the socket is dropped instead of drained. */
const MAX_DRAIN_BYTES = 16 * MAX_BODY_BYTES;

class BodyTooLarge extends Error {
  /** True when the socket was dropped mid-stream, so there is no one left to answer. */
  constructor(readonly dropped: boolean) {
    super("request body too large");
  }
}

/**
 * Reads the body, keeping at most `MAX_BODY_BYTES`. An oversized body is still read to the end (and
 * discarded) before the 413 goes out: answering while the client is mid-upload makes the socket close
 * with unread data, and the client then sees a reset instead of the 413.
 */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_DRAIN_BYTES) {
      request.destroy();
      throw new BodyTooLarge(true);
    }
    if (size <= MAX_BODY_BYTES) chunks.push(buffer);
  }
  if (size > MAX_BODY_BYTES) throw new BodyTooLarge(false);
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  response.end(text);
}

/** Generates a fresh per-process token when `OPENRHEN_MCP_TOKEN` is not set. */
export function resolveHttpToken(env: NodeJS.ProcessEnv): { token: string; generated: boolean } {
  const configured = env.OPENRHEN_MCP_TOKEN?.trim();
  if (configured) return { token: configured, generated: false };
  return { token: randomBytes(24).toString("hex"), generated: true };
}

export function startHttpMcpServer(options: HttpMcpOptions): Promise<HttpMcpServer> {
  const buildContext = options.buildContext ?? buildLineContext;
  let contextPromise: Promise<LineContext> | null = null;
  const getContext = () => (contextPromise ??= buildContext());

  const server = createServer((request, response) => {
    void (async () => {
      if (!hostIsLoopback(request.headers.host)) {
        sendJson(response, 421, { error: "This server only answers requests addressed to a loopback host." });
        return;
      }
      if (!originIsLoopback(request.headers.origin)) {
        sendJson(response, 403, { error: "Origin is not a loopback origin." });
        return;
      }
      const provided = bearerToken(request);
      if (!provided || !timingSafeTokenMatch(options.token, provided)) {
        sendJson(response, 401, { error: "A valid bearer token is required." });
        return;
      }
      let agent: string | undefined;
      const agentHeader = request.headers[AGENT_HEADER.toLowerCase()];
      if (agentHeader !== undefined) {
        try {
          agent = parseAgentName(Array.isArray(agentHeader) ? (agentHeader[0] ?? "") : agentHeader, AGENT_HEADER);
        } catch (error) {
          sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
          return;
        }
      }
      // The request's own agent token, or none: the server process's OPENRHEN_TOKEN is never used here,
      // so one client's identity cannot leak to another. Reaches the command through its env, not argv.
      const tokenHeader = request.headers[TOKEN_HEADER.toLowerCase()];
      const requestToken = (Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader)?.trim() ?? "";
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "Only POST is supported." });
        return;
      }
      let raw: string;
      try {
        raw = await readBody(request);
      } catch (error) {
        if (error instanceof BodyTooLarge) {
          if (!error.dropped) sendJson(response, 413, { error: `The request body is over ${MAX_BODY_BYTES} bytes.` });
          return;
        }
        sendJson(response, 400, { error: "Could not read the request body." });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        sendJson(response, 400, { error: "The request body is not valid JSON." });
        return;
      }
      const ctx: LineContext = {
        ...(await getContext()),
        ...(agent === undefined ? {} : { agent }),
        // OPENRHEN_AGENT is blanked too: a request's name is its own header (forwarded as --agent), never the server's.
        // The owner token is dropped as on stdio: a client that sends only the bearer token is not the owner.
        env: { ...withoutOwnerToken(process.env), OPENRHEN_TOKEN: requestToken, OPENRHEN_AGENT: "" }
      };
      if (Array.isArray(parsed)) {
        if (parsed.length > MAX_BATCH) {
          sendJson(response, 400, { error: `A batch may hold at most ${MAX_BATCH} calls.` });
          return;
        }
        const results = await Promise.all(
          parsed.map((entry) => handleLine(JSON.stringify(entry), ctx).catch(() => null))
        );
        const responses = results.filter((line): line is string => line !== null).map((line) => JSON.parse(line));
        if (responses.length === 0) {
          response.writeHead(202);
          response.end();
          return;
        }
        sendJson(response, 200, responses);
        return;
      }
      const line = await handleLine(raw, ctx);
      if (line === null) {
        response.writeHead(202);
        response.end();
        return;
      }
      sendJson(response, 200, JSON.parse(line));
    })().catch((error) => {
      options.log(`rhen mcp --http: unhandled error — ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) sendJson(response, 500, { error: "Internal error." });
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      resolve({
        port,
        close: () =>
          new Promise((resolveClose) => {
            server.close(() => resolveClose());
          })
      });
    });
  });
}
