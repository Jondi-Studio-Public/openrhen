import type { CapabilityId, ConnectionManifest, OpId } from "@openrhen/contracts";

/** What an op receives for one call. */
export interface OpCall {
  /** The parsed JSON body. The router answers 400 for an empty or invalid body, so ops with no input receive `{}`. */
  body: unknown;
  /** Bound to the request's abort signal, so a client disconnect or timeout cancels the upstream call. */
  fetch: typeof fetch;
  signal: AbortSignal;
  env: Record<string, string | undefined>;
  /** The inbound capability path, for logs such as a transport-failure line. */
  pathname: string;
}

/** The status and JSON body an op answers with. */
export interface OpResult {
  status: number;
  body: unknown;
}

export interface JsonOp {
  kind: "json";
  rate?: "ai" | "embedding";
  run(call: OpCall): Promise<OpResult>;
}

export interface StreamOp {
  kind: "stream";
  rate?: "ai";
  /**
   * An ok `Response` is piped to the client. `{status, body}` is answered as JSON, for failures
   * before the stream opens. The op catches its own pre-stream errors, transport logging included.
   */
  run(call: OpCall): Promise<Response | OpResult>;
}

export type ConnectionOp = JsonOp | StreamOp;

export type ConnectionImpl = Partial<Record<CapabilityId, Partial<Record<OpId, ConnectionOp>>>>;

export interface BoundConnection {
  manifest: ConnectionManifest;
  create(env: Record<string, string | undefined>): ConnectionImpl;
}
