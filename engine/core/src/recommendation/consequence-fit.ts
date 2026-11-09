/**
 * The comparison-derived consequence fit lives in `@openrhen/contracts` (`planning/consequence-fit.ts`) so the database
 * layer, which may not import engine-core, can run the same pure function when it refits stored values. Re-exported here
 * so engine-core callers and tests keep their import path.
 */
export * from "@openrhen/contracts/consequence-fit";
