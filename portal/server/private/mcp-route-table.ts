// The stock export keeps no extra API routes. A deployment that adds some replaces this file.
import type { RouteModule } from "../mcp-route-table";

export const PRIVATE_MCP_ROUTE_TABLE: Record<string, () => Promise<RouteModule>> = {};
