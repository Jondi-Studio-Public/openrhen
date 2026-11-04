import type { Sql } from "@/server/persistence/postgres/sql-pool";

/**
 * The plan as one list of searchable documents, read in a single query (the design notes,
 * "Plan search"). Each row is one record an agent can open with `show <kind> <id>`: its title, the text
 * worth searching beside it, where it sits (an Area › Outcome › Project breadcrumb) and the ids above it,
 * so `under` can keep a search inside one branch.
 *
 * The word rank is computed inline from a tsvector built per row (title weight A, breadcrumb B, body C,
 * the `english` and `simple` configurations together, the pattern email search uses). The plan is about
 * a thousand short rows, so there is no stored column and no index, and so no migration.
 *
 * A recurring commitment is one row (its nearest occurrence), and a routine step one row per title, so
 * a daily shift or a step repeated before every shift does not fill a page of results.
 */

export interface PlanDocument {
  /** The CLI's singular entity name: area, outcome, project, deliverable, action, commitment, capture, routine-step, condition, span. */
  kind: PlanDocumentKind;
  id: string;
  title: string;
  body: string;
  status: string | null;
  /** Still in play: not done, cancelled, archived or past. `status: "open"` keeps only these. */
  open: boolean;
  /** "Area › Outcome › Project", empty for an area or a record outside the hierarchy. */
  path: string;
  /** The area, outcome, project and (for a deliverable's step) deliverable ids above this record. */
  ancestors: string[];
  /** Word rank; null when the words did not match. */
  rank: number | null;
  /** How many of the query's distinct words (english lexemes) this record holds. */
  matchedWords: number;
  /** Which parts the words hit, of title, path and body. */
  fields: string[];
  snippet: string | null;
  /** Where a capture's or commitment's text came from (an email, a calendar, ...); null for the person's own records. */
  sourceType: string | null;
}

export const PLAN_DOCUMENT_KINDS = [
  "area",
  "outcome",
  "project",
  "deliverable",
  "action",
  "commitment",
  "capture",
  "routine-step",
  "condition",
  "span"
] as const;
export type PlanDocumentKind = (typeof PLAN_DOCUMENT_KINDS)[number];

export interface WordQuery {
  text: string;
  /** Match the words as one phrase, in order, instead of any of them. */
  phrase: boolean;
}

interface Row {
  kind: PlanDocumentKind;
  id: string;
  title: string;
  body: string;
  status: string | null;
  open: boolean;
  path: string;
  ancestors: string[];
  rank: number | null;
  query_words: number;
  matched_words: number;
  in_title: boolean;
  in_path: boolean;
  in_body: boolean;
  snippet: string | null;
  source_type: string | null;
}

const SEP = " › ";

/**
 * Every plan document, each with its word rank against `query` (null when it does not match, or when
 * there is no query). With `likeId` and no query, the words are that record's own title, matched as any
 * of them, in the same single read. Query text reaches Postgres only as a bound parameter.
 */
export async function readPlanDocuments(
  sql: Sql,
  userId: string,
  query: WordQuery | null,
  likeId?: string
): Promise<{ documents: PlanDocument[]; queryWords: number }> {
  const text = query?.text ?? "";
  const phrase = query?.phrase ?? false;
  // Any of the words (OR), built from the query's own lexemes rather than by editing a tsquery's text
  // (a lexeme such as a URL can hold "&"): each is quoted as tsquery input wants, then joined with " | ".
  // The rank then rewards records that hold more of the words, and the caller drops records holding too
  // few. The english config drops stop words and stems; only a query made wholly of stop words falls back
  // to the simple config, so "the" or "for" never count as a hit on their own.
  const anyOf = (config: "english" | "simple") => sql`coalesce(nullif(array_to_string(ARRAY(
      SELECT '''' || replace(replace(l, '\\', '\\\\'), '''', '''''') || ''''
      FROM unnest(tsvector_to_array(to_tsvector(${config}::regconfig, i.text))) l), ' | '), ''), '')::tsquery`;
  const rows = await sql<Row[]>`
    WITH docs AS (
      SELECT 'area' AS kind, a.id::text AS id, a.name AS title, coalesce(a.description, '') AS body,
        a.status::text AS status, a.status IN ('active', 'paused') AS open, '' AS path, ARRAY[]::text[] AS ancestors,
        NULL::text AS source_type
      FROM areas a WHERE a.user_id = ${userId}
      UNION ALL
      SELECT 'outcome', o.id::text, o.title, o.definition_of_done, o.status::text, o.status IN ('active', 'paused'),
        a.name, ARRAY[a.id::text], NULL
      FROM outcomes o JOIN areas a ON a.id = o.area_id WHERE a.user_id = ${userId}
      UNION ALL
      SELECT 'project', p.id::text, p.title, '', p.status::text, p.status IN ('active', 'paused'),
        a.name || ${SEP} || o.title, ARRAY[a.id::text, o.id::text], NULL
      FROM projects p JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id
      WHERE a.user_id = ${userId}
      UNION ALL
      SELECT 'deliverable', d.id::text, d.title,
        concat_ws(' ', d.details, d.completion_threshold, d.approval_note,
          (SELECT string_agg(concat_ws(' ', c.title, c.interpretation, c.expected_evidence, c.notes), ' ')
             FROM deliverable_criteria c WHERE c.deliverable_id = d.id),
          (SELECT string_agg(concat_ws(' ', b.description, b.proposed_resolution, b.resolution_notes), ' ')
             FROM deliverable_blockers b WHERE b.deliverable_id = d.id)),
        d.status::text, d.status NOT IN ('completed', 'cancelled', 'archived'),
        a.name || ${SEP} || o.title || ${SEP} || p.title, ARRAY[a.id::text, o.id::text, p.id::text], NULL
      FROM deliverables d JOIN projects p ON p.id = d.project_id JOIN outcomes o ON o.id = p.outcome_id
        JOIN areas a ON a.id = o.area_id
      WHERE a.user_id = ${userId}
      UNION ALL
      SELECT 'action', ac.id::text, ac.title, concat_ws(' ', ac.notes, ac.completion_condition),
        ac.status::text, ac.status NOT IN ('done', 'cancelled', 'archived'),
        a.name || ${SEP} || o.title || ${SEP} || p.title || coalesce(${SEP} || dl.title, ''),
        ARRAY[a.id::text, o.id::text, p.id::text] || coalesce(ARRAY[dl.id::text], ARRAY[]::text[]), NULL
      FROM actions ac JOIN projects p ON p.id = ac.project_id JOIN outcomes o ON o.id = p.outcome_id
        JOIN areas a ON a.id = o.area_id LEFT JOIN deliverables dl ON dl.id = ac.deliverable_id
      WHERE a.user_id = ${userId}
      UNION ALL
      SELECT * FROM (
        SELECT DISTINCT ON (coalesce(c.recurrence_rule_id, c.id)) 'commitment', c.id::text, c.title,
          coalesce(c.location, ''), c.status, c.status <> 'cancelled' AND c.ends_at >= now(),
          coalesce(a.name || ${SEP} || o.title || ${SEP} || p.title, ''),
          CASE WHEN p.id IS NULL THEN ARRAY[]::text[] ELSE ARRAY[a.id::text, o.id::text, p.id::text] END,
          -- Where its text came from, so a reader can tell a calendar's title from the person's own.
          coalesce(src.source_type, (SELECT l.provider FROM calendar_event_links l WHERE l.commitment_id = c.id ORDER BY l.provider, l.id LIMIT 1))
        FROM commitments c LEFT JOIN sources src ON src.id = c.source_id
          LEFT JOIN projects p ON p.id = c.project_id
          LEFT JOIN outcomes o ON o.id = p.outcome_id LEFT JOIN areas a ON a.id = o.area_id
        WHERE c.user_id = ${userId}
        -- The nearest occurrence of a series: the next one still to end, else the latest past one.
        ORDER BY coalesce(c.recurrence_rule_id, c.id), c.ends_at < now(),
          CASE WHEN c.ends_at >= now() THEN c.starts_at END, c.starts_at DESC
      ) commitments
      UNION ALL
      SELECT 'capture', pr.id::text, coalesce(nullif(pr.proposed_fields->>'title', ''), left(s.captured_text, 120)),
        s.captured_text, pr.status::text, pr.status = 'pending', '', ARRAY[]::text[], s.source_type
      FROM captures pr JOIN sources s ON s.id = pr.source_id
      WHERE pr.user_id = ${userId} AND pr.matched_entity_type IS DISTINCT FROM 'deliverable'
      UNION ALL
      SELECT * FROM (
        SELECT DISTINCT ON (lower(rs.title)) 'routine-step', rs.id::text, rs.title, coalesce(rs.purpose, ''),
          rs.status, rs.status NOT IN ('completed', 'cancelled', 'skipped'), coalesce(c.title, ''), ARRAY[]::text[], NULL
        FROM routine_steps rs LEFT JOIN commitments c ON c.id = rs.commitment_id
        WHERE rs.user_id = ${userId}
        ORDER BY lower(rs.title), rs.status IN ('completed', 'cancelled', 'skipped'), rs.scheduled_start_at NULLS LAST
      ) steps
      UNION ALL
      SELECT 'condition', cd.id, cd.name, coalesce(cd.address, ''), cd.status, cd.status = 'active', '', ARRAY[]::text[], NULL
      FROM condition_definitions cd WHERE cd.user_id = ${userId}
      UNION ALL
      SELECT 'span', sp.id::text, sp.title, '', NULL, sp.end_date >= current_date,
        coalesce(a.name || ${SEP} || o.title || ${SEP} || p.title, ''),
        CASE WHEN p.id IS NULL THEN ARRAY[]::text[] ELSE ARRAY[a.id::text, o.id::text, p.id::text] END, NULL
      FROM spans sp LEFT JOIN projects p ON p.id = sp.project_id
        LEFT JOIN outcomes o ON o.id = p.outcome_id LEFT JOIN areas a ON a.id = o.area_id
      WHERE sp.user_id = ${userId}
    ),
    input AS (
      SELECT coalesce(nullif(${text}, ''), (SELECT title FROM docs WHERE id = ${likeId ?? ""} LIMIT 1), '') AS text
    ),
    q AS (
      SELECT i.text,
        CASE
          WHEN ${phrase} AND numnode(phraseto_tsquery('english', i.text)) > 0 THEN phraseto_tsquery('english', i.text)
          WHEN ${phrase} THEN phraseto_tsquery('simple', i.text)
          WHEN numnode(plainto_tsquery('english', i.text)) > 0 THEN ${anyOf("english")}
          ELSE ${anyOf("simple")}
        END AS query,
        ARRAY(SELECT DISTINCT unnest(tsvector_to_array(
          CASE WHEN numnode(plainto_tsquery('english', i.text)) > 0 THEN to_tsvector('english', i.text)
            ELSE to_tsvector('simple', i.text) END
        ))) AS words
      FROM input i
    ),
    -- Materialized, so each row's tsvector is built once rather than once per reference below; no
    -- tsvector at all when there are no words to match.
    scored AS MATERIALIZED (
      SELECT d.*, q.text AS query_text, q.query, q.words,
        CASE WHEN q.text <> '' THEN
          setweight(to_tsvector('english', d.title), 'A') || setweight(to_tsvector('simple', d.title), 'A')
            || setweight(to_tsvector('english', d.path), 'B') || setweight(to_tsvector('simple', d.path), 'B')
            || setweight(to_tsvector('english', d.body), 'C') || setweight(to_tsvector('simple', d.body), 'C')
        END AS tsv
      FROM docs d CROSS JOIN q
    ),
    hits AS MATERIALIZED (
      SELECT s.*, coalesce(s.tsv @@ s.query, false) AS hit FROM scored s
    )
    SELECT kind, id, title, body, status, open, path, ancestors, source_type, cardinality(words) AS query_words,
      CASE WHEN hit THEN ts_rank_cd(tsv, query) END AS rank,
      CASE WHEN hit THEN
        (SELECT count(*)::int FROM unnest(words) w WHERE w = ANY(tsvector_to_array(tsv)))
      ELSE 0 END AS matched_words,
      CASE WHEN hit THEN (to_tsvector('english', title) || to_tsvector('simple', title)) @@ query ELSE false END AS in_title,
      CASE WHEN hit THEN (to_tsvector('english', path) || to_tsvector('simple', path)) @@ query ELSE false END AS in_path,
      CASE WHEN hit THEN (to_tsvector('english', body) || to_tsvector('simple', body)) @@ query ELSE false END AS in_body,
      CASE WHEN hit THEN
        ts_headline('english', CASE WHEN body <> '' THEN body ELSE title END, query,
          'MaxWords=18, MinWords=6, MaxFragments=1, StartSel=«, StopSel=»')
      END AS snippet
    FROM hits
  `;
  const documents = rows.map((row) => ({
    kind: row.kind,
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status,
    open: row.open,
    path: row.path,
    ancestors: row.ancestors,
    rank: row.rank === null ? null : Number(row.rank),
    matchedWords: Number(row.matched_words),
    fields: [row.in_title && "title", row.in_path && "path", row.in_body && "body"].filter(
      (field): field is string => typeof field === "string"
    ),
    snippet: row.snippet,
    sourceType: row.source_type
  }));
  return { documents, queryWords: Number(rows[0]?.query_words ?? 0) };
}
