import { planLinkSchema, type PlanLink } from "@openrhen/contracts";
import { toStoredLinks } from "@openrhen/contracts/plan-map-navigator";
import type { PortalClient } from "../client.js";
import { STORED_KINDS, type StoredLink } from "./model.js";

/**
 * Where the navigator reads stored links (`plan_links`) from. The default is `portalLinkSource`, which
 * reads confirmed and suggested links through the portal API; `unavailableLinkSource` is the fallback
 * when there is nothing to read, and the navigator then answers from derived links alone.
 */
export interface StoredLinkSource {
  /** False until the link store exists; reported in the output so an agent knows the map is derived-only. */
  readonly available: boolean;
  read(): Promise<StoredLink[]>;
}

export const unavailableLinkSource: StoredLinkSource = {
  available: false,
  read: async () => []
};

/** Thrown by a source that cannot reach its store at all; reported as `unavailable`, not as an error. */
export class StoredLinksUnavailableError extends Error {}

/**
 * Reads stored links from `GET /api/plan-map`, mapping each end to the `<type>:<id>` handle the navigator
 * uses. Any failure to read (an older portal without the route, a network error, `--state-file`, an
 * unparseable body) is an unavailable source, so `map` keeps working from derived links. A row that does
 * not parse is skipped, never fatal.
 */
export function portalLinkSource(client: PortalClient): StoredLinkSource {
  return {
    available: true,
    async read() {
      let body: unknown;
      try {
        body = await client.get("/api/plan-map");
      } catch (error) {
        throw new StoredLinksUnavailableError(error instanceof Error ? error.message : String(error));
      }
      const rows = (body as { links?: unknown } | null)?.links;
      if (!Array.isArray(rows)) throw new StoredLinksUnavailableError("The portal returned no plan map.");
      const parsed: PlanLink[] = [];
      for (const row of rows) {
        const result = planLinkSchema.safeParse(row);
        if (result.success) parsed.push(result.data);
      }
      return toStoredLinks(parsed);
    }
  };
}

export interface StoredLinkRead {
  state: "available" | "unavailable" | "error";
  links: StoredLink[];
  error?: string;
}

/**
 * Reads stored links without ever failing the map: a source that is missing, throws (a table mid-migration,
 * a bad row) or returns junk degrades to derived links only, with the state saying why. Rows whose kind or
 * status is not one the design defines are dropped here, so the navigator can trust what it gets.
 */
export async function readStoredLinks(source: StoredLinkSource): Promise<StoredLinkRead> {
  if (!source.available) return { state: "unavailable", links: [] };
  try {
    const rows = await source.read();
    const kinds: readonly string[] = STORED_KINDS;
    const links = rows.filter(
      (link) => kinds.includes(link.kind) && (link.status === "confirmed" || link.status === "suggested")
    );
    return { state: "available", links };
  } catch (error) {
    if (error instanceof StoredLinksUnavailableError) return { state: "unavailable", links: [] };
    return { state: "error", links: [], error: error instanceof Error ? error.message : String(error) };
  }
}
