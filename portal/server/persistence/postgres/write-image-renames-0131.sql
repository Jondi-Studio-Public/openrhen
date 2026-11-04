-- The data statements of migration 0131_rename_captures_commitments, kept as a fixture because the OpenRhen
-- baseline replaces the migration history. A test pins that they match the migration wherever it exists.
-- The write ledger names the table of every stored row image; undo refuses an image whose table it does not know,
-- so an old write's images are rewritten to the new names (and the feed's per-entity filter reads the same names).
UPDATE "writes" w
SET "images" = (
  SELECT jsonb_agg(
    CASE e ->> 'table'
      WHEN 'proposals' THEN jsonb_set(e, '{table}', '"captures"')
      WHEN 'fixed_commitments' THEN jsonb_set(e, '{table}', '"commitments"')
      ELSE e
    END
    ORDER BY ord
  )
  FROM jsonb_array_elements(w."images") WITH ORDINALITY AS t(e, ord)
)
WHERE jsonb_typeof(w."images") = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(w."images") AS x(e)
    WHERE jsonb_typeof(x.e) = 'object' AND x.e ->> 'table' IN ('proposals', 'fixed_commitments')
  );
--> statement-breakpoint
UPDATE "write_rows" SET "entity_type" = 'captures' WHERE "entity_type" = 'proposals';
--> statement-breakpoint
UPDATE "write_rows" SET "entity_type" = 'commitments' WHERE "entity_type" = 'fixed_commitments';
