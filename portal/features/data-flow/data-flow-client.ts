"use client";

import type { DataFlowResponse } from "@openrhen/contracts/data-flow";

/** Reads the data-flow graph; throws when the route fails or the body is not the graph. */
const FAILED = "The data map could not be read.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The body as the graph, or null. Only the parts the page leans on are checked; the route is the owner of the shape. */
export function parseDataFlow(body: unknown): DataFlowResponse | null {
  if (!isRecord(body)) return null;
  const { entries, edges, datasets, devices, unused, health } = body;
  if (!Array.isArray(entries) || !Array.isArray(edges) || !Array.isArray(datasets) || !Array.isArray(devices))
    return null;
  if (!isRecord(unused) || !Array.isArray(unused.entries)) return null;
  if (!isRecord(health)) return null;
  if (
    health.unavailable !== true &&
    !(isRecord(health.nodes) && Array.isArray(health.issues) && Array.isArray(health.devices))
  )
    return null;
  if (typeof body.generatedAt !== "string") return null;
  return body as unknown as DataFlowResponse;
}

export async function fetchDataFlow(signal?: AbortSignal): Promise<DataFlowResponse> {
  const response = await fetch("/api/data-flow", { cache: "no-store", ...(signal ? { signal } : {}) });
  if (!response.ok) throw new Error(FAILED);
  const graph = parseDataFlow(await response.json());
  if (!graph) throw new Error(FAILED);
  return graph;
}
