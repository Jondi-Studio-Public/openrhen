import {
  PlanMapQueryError,
  parseKinds as parseKindsShared,
  resolveItem as resolveItemShared,
  type PlanIndex,
  type MapItem
} from "@openrhen/contracts/plan-map-navigator";
import { CliError, EXIT } from "../errors.js";

export {
  navigate,
  approxTokens,
  type NavigateOptions,
  type Neighbourhood
} from "@openrhen/contracts/plan-map-navigator";

/** The navigator lives in `@openrhen/contracts` so the portal draws the same map; its lookup errors become CLI errors here. */
function asCliError<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof PlanMapQueryError)
      throw new CliError(error.message, error.code === "not_found" ? EXIT.notFound : EXIT.usage);
    throw error;
  }
}

export const resolveItem = (index: PlanIndex, query: string): MapItem =>
  asCliError(() => resolveItemShared(index, query));
export const parseKinds = (raw: string | undefined): Set<string> => asCliError(() => parseKindsShared(raw));
