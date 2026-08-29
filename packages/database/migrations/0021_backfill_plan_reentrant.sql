-- Make the backfill function re-entrant inside one transaction.
--
-- `backfill_worktree_plan` is a TEMP TABLE ... ON COMMIT DROP, so it survives
-- until the transaction commits, not until the function returns. The workflow
-- 0018's header documents is two calls - a dry run, then the apply - and an
-- operator who wraps them in a single `BEGIN` (psql, or any client that sends
-- a multi-statement batch as one transaction) hits
-- `relation "backfill_worktree_plan" already exists` on the second call. The
-- plan is rebuilt from scratch on every call anyway, so dropping a leftover
-- one first is the whole fix.
--
-- Fix-forward as its own migration because 0019 is applied history. The
-- function is otherwise byte-identical to 0019's: same plan, same lanes, same
-- ambiguity refusals, same audit stamping, idempotent.

CREATE OR REPLACE FUNCTION backfill_agent_session_worktree_attribution(p_dry_run boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql AS $fn$
DECLARE
    v_backslash text := chr(92);
    v_report jsonb;
BEGIN
    DROP TABLE IF EXISTS backfill_worktree_plan;
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
