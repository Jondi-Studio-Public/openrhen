import { Table, getTableName, is } from "drizzle-orm";
import * as schema from "@openrhen/database/schema";

/** The tables the Drizzle schema declares: what the registry's graph and the doctor's source checks measure against. */
export const SCHEMA_TABLES: readonly string[] = Object.values(schema).flatMap((value) =>
  is(value, Table) ? [getTableName(value)] : []
);
