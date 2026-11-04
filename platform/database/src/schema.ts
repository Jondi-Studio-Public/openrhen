// The database schema barrel: the core tables, then whatever private table groups are installed
// (schema/private/index.ts; empty in the OpenRhen export). drizzle-kit and `@openrhen/database/schema` read this file.
export * from "./schema/core.js";
export * from "./schema/private/index.js";
