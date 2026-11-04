# addon-drizzle

Empty in the stock OpenRhen. A deployment that adds its own tables (the schema in `src/schema/private/`) drops its drizzle migrations here: `meta/_journal.json`, the `NNNN_name.sql` files and, optionally, `meta/baseline.json`. The migrator (`src/operations/migrate-on-deploy.ts`) then runs them as a second set after core's, with their own ledger `drizzle.__drizzle_migrations_addon`. With no `meta/_journal.json` here there is no add-on set and nothing changes. `Dockerfile.migrate` copies this folder into the image; see `docs/operations/database-and-backups.md`.
