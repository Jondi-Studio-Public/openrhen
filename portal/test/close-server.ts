import { vi } from "vitest";
import type { CloseEntityCommand } from "@openrhen/contracts";
import { createSeedState } from "@/state/portal-state";
import { jsonResponse, parseCloseBody } from "./close-fixtures";

/**
 * A stand-in for the portal server in component tests: `/api/commands/close` goes to `onClose` with the posted body
 * already parsed by the route's own schema (an unparseable body fails the test), a state read answers no state (as an
 * empty database does, so the provider's freshness check does not run), and any other command answers a seed state.
 */
export function stubCloseServer(onClose: (command: CloseEntityCommand, posts: CloseEntityCommand[]) => Response | Promise<Response>) {
  const posts: CloseEntityCommand[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/commands/close") {
      const command = parseCloseBody(init);
      posts.push(command);
      return onClose(command, posts);
    }
    return jsonResponse({ state: init?.method === "POST" ? createSeedState() : null });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, posts };
}
