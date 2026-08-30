-- Audit fix-forward for the worktree attribution backfill (0018), kept as its
-- own migration so the pair reviews and reverts independently.
--
-- NOTE, applied as history: the stamping heuristic in this migration's DO
-- block proved ambiguous in production (ingest batches form updated_at
-- clusters of their own) and stamped the wrong rows; 0020 clears those and
-- re-stamps on a deterministic rule. The function below is the live one.
--
-- What 0018 missed: it recorded each moved row's previous project in
-- `original_project_id`, but a row that moved from UNATTRIBUTED (project_id
-- was null) coalesced to null too - indistinguishable from a row the backfill
-- never touched. The Overlord's audit rule is that no old value is destroyed
-- without a record, and a null-old-value is a value. This migration adds the
-- missing record and makes it permanent for future passes.
--
--   `attribution_backfilled_at` - set the first time a backfill pass moves
--   the row; never overwritten. Null means no backfill pass ever moved it.
--
-- Inspection and revert, for every row any pass ever moved:
--
--   SELECT * FROM agent_sessions WHERE attribution_backfilled_at IS NOT NULL;
--   UPDATE agent_sessions
--   SET project_id = original_project_id, original_project_id = NULL,
--       attribution_backfilled_at = NULL
--   WHERE attribution_backfilled_at IS NOT NULL;
--
-- (A row that moved from null gets its null back; a row that moved between
-- projects returns to the project it held before the first pass.)
--
-- The function below also replaces 0018's, so every future pass stamps the
-- marker itself. It is otherwise unchanged: same plan, same lanes, same
-- ambiguity refusals, idempotent.

ALTER TABLE "agent_sessions" ADD COLUMN "attribution_backfilled_at" timestamptz;--> statement-breakpoint

-- Stamp the rows the 0018 pass already moved. Those rows are identifiable
-- after the fact because 0018's UPDATE was one transaction: every row it
-- touched carries that transaction's `now()` in `updated_at`, and nothing
-- else wrote those rows in that instant. They are the cluster of rows with
-- project_id set, original_project_id null, and an identical updated_at that
-- no ingest batch matches (ingest batches either leave project null or set it
-- at insert with their own earlier timestamps). The window and the >=10
-- cluster bound keep every other update in history out; if more than one
-- cluster qualified, this migration refuses rather than guess.
--
-- On a fresh database replaying the chain there are no rows at all and this
-- is a no-op; it only ever fires on the database 0018's backfill just ran
-- against, so 0018 and 0019 are applied back to back.
DO $fn$
DECLARE
    cluster record;
    cluster_count integer;
BEGIN
    SELECT updated_at, count(*) AS n
    INTO cluster
    FROM agent_sessions
    WHERE updated_at > now() - interval '48 hours'
      AND project_id IS NOT NULL
      AND original_project_id IS NULL
    GROUP BY updated_at
    HAVING count(*) >= 10;

    GET DIAGNOSTICS cluster_count = ROW_COUNT;

    IF cluster_count = 0 THEN
        RAISE NOTICE 'backfill audit stamp: no 0018 cluster found; nothing to stamp';
        RETURN;
    END IF;
    IF cluster_count > 1 THEN
        RAISE EXCEPTION 'backfill audit stamp: % candidate clusters, refusing to guess', cluster_count;
    END IF;

    UPDATE agent_sessions s
    SET attribution_backfilled_at = cluster.updated_at
    FROM (SELECT cluster.updated_at AS t) AS mark
    WHERE s.updated_at = mark.t
      AND s.project_id IS NOT NULL
      AND s.original_project_id IS NULL;
    RAISE NOTICE 'backfill audit stamp: % rows stamped', cluster.n;
END;
$fn$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION backfill_agent_session_worktree_attribution(p_dry_run boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql AS $fn$
DECLARE
    v_backslash text := chr(92);
    v_report jsonb;
BEGIN
    CREATE TEMP TABLE backfill_worktree_plan ON COMMIT DROP AS
    WITH derived AS (
        SELECT
            s.id,
            s.user_id,
            s.project_id AS current_project_id,
            s.cwd,
            replace(s.cwd, v_backslash, '/') AS ncwd,
            (SELECT a.repo_key FROM agents a WHERE a.id = s.agent_id) AS repo_key
        FROM agent_sessions s
        WHERE s.cwd IS NOT NULL
    ),
    rooted AS (
        SELECT
            d.*,
            CASE
                WHEN ncwd ~* '/[.]worktrees(/|$)'
                    THEN (regexp_match(ncwd, '^(.*?)/[.]worktrees/', 'i'))[1]
                WHEN ncwd ~* '/[.]claude/worktrees(/|$)'
                    THEN (regexp_match(ncwd, '^(.*?)/[.]claude/worktrees/', 'i'))[1]
                ELSE ncwd
            END AS main_root,
            (ncwd ~* '/[.]worktrees(/|$)' OR ncwd ~* '/[.]claude/worktrees(/|$)') AS from_worktree
        FROM derived d
    ),
    path_hits AS (
        SELECT
            r.id,
            m.project_id,
            length(rtrim(replace(m.path_prefix, v_backslash, '/'), '/')) AS prefix_len
        FROM rooted r
        JOIN project_path_mappings m
            ON m.user_id = r.user_id
            AND m.kind = 'path_prefix'
            AND (
                lower(rtrim(replace(m.path_prefix, v_backslash, '/'), '/')) = lower(rtrim(r.main_root, '/'))
                OR lower(rtrim(r.main_root, '/')) LIKE lower(rtrim(replace(m.path_prefix, v_backslash, '/'), '/')) || '/%'
            )
    ),
    -- Longest prefix wins; winners of equal length must name one project or
    -- the row is ambiguous, mirroring `resolveProjectForCwd`'s tie rule.
    path_lane AS (
        SELECT
            h.id,
            count(DISTINCT h.project_id) AS n_projects,
            min(h.project_id::text)::uuid AS project_id
        FROM path_hits h
        WHERE h.prefix_len = (SELECT max(h2.prefix_len) FROM path_hits h2 WHERE h2.id = h.id)
        GROUP BY h.id
    ),
    remote_lane AS (
        SELECT
            r.id,
            count(DISTINCT m.project_id) AS n_projects,
            min(m.project_id::text)::uuid AS project_id
        FROM rooted r
        JOIN project_path_mappings m
            ON m.user_id = r.user_id
            AND m.kind = 'path_prefix'
            AND m.repo_url IS NOT NULL
            AND r.repo_key IS NOT NULL
            AND r.repo_key NOT LIKE 'path:%'
            AND siqshift_normalize_remote(m.repo_url) = r.repo_key
        GROUP BY r.id
    ),
    planned AS (
        SELECT
            r.id,
            r.current_project_id,
            r.cwd,
            r.main_root,
            r.from_worktree,
            r.repo_key,
            CASE
                WHEN p.n_projects > 1 THEN NULL::uuid
                WHEN p.n_projects = 1 THEN p.project_id
                WHEN x.n_projects > 1 THEN NULL::uuid
                WHEN x.n_projects = 1 THEN x.project_id
                ELSE NULL::uuid
            END AS target_project_id,
            CASE
                WHEN p.n_projects > 1 THEN 'ambiguous_path'
                WHEN p.n_projects = 1 THEN 'path_prefix'
                WHEN x.n_projects > 1 THEN 'ambiguous_remote'
                WHEN x.n_projects = 1 THEN 'remote'
                ELSE 'unresolved'
            END AS lane
        FROM rooted r
        LEFT JOIN path_lane p ON p.id = r.id
        LEFT JOIN remote_lane x ON x.id = r.id
    )
    SELECT * FROM planned;

    -- The write: move only rows the re-resolution lands somewhere different,
    -- record the first value the row held before any pass touched it, and
    -- mark the row as one a backfill pass decided - the record that makes a
    -- null old value (an unattributed row) auditable and reversible.
    IF NOT p_dry_run THEN
        UPDATE agent_sessions s
        SET project_id = plan.target_project_id,
            original_project_id = coalesce(s.original_project_id, s.project_id),
            attribution_backfilled_at = coalesce(s.attribution_backfilled_at, now()),
            updated_at = now()
        FROM backfill_worktree_plan plan
        WHERE s.id = plan.id
          AND plan.target_project_id IS NOT NULL
          AND plan.target_project_id IS DISTINCT FROM s.project_id;
    END IF;

    SELECT jsonb_build_object(
        'dry_run', p_dry_run,
        'scanned', count(*),
        'moved', count(*) FILTER (WHERE lane IN ('path_prefix', 'remote') AND target_project_id IS DISTINCT FROM current_project_id),
        'already_correct', count(*) FILTER (WHERE lane IN ('path_prefix', 'remote') AND target_project_id IS NOT DISTINCT FROM current_project_id),
        'ambiguous', count(*) FILTER (WHERE lane LIKE 'ambiguous%'),
        'unresolved_no_signal', count(*) FILTER (WHERE lane = 'unresolved' AND (repo_key IS NULL OR repo_key LIKE 'path:%')),
        'unresolved_remote_unconfigured', count(*) FILTER (WHERE lane = 'unresolved' AND repo_key IS NOT NULL AND repo_key NOT LIKE 'path:%'),
        'moves', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
                'from_project', from_project,
                'to_project', to_project,
                'worktree', worktree,
                'rows', rows
            ) ORDER BY rows DESC)
            FROM (
                SELECT
                    current_project_id AS from_project,
                    target_project_id AS to_project,
                    from_worktree AS worktree,
                    count(*) AS rows
                FROM backfill_worktree_plan
                WHERE lane IN ('path_prefix', 'remote')
                  AND target_project_id IS DISTINCT FROM current_project_id
                GROUP BY current_project_id, target_project_id, from_worktree
            ) breakdown
        ), '[]'::jsonb)
    )
    INTO v_report
    FROM backfill_worktree_plan;
    RETURN v_report;
END;
$fn$;--> statement-breakpoint
