-- Worktree attribution backfill, hand-written on purpose: this is the one
-- migration that rewrites attribution on existing rows, so it is kept apart
-- from the schema change before it (0017, the audit column) and from every
-- generated migration after it. Review it, revert it, and re-run it
-- independently of the code fix.
--
-- What it does
-- ------------
-- Re-resolves every `agent_sessions` row's `project_id` under the rules the
-- fixed ingest uses, where the desktop now reports the **main repository
-- root** (the parent of `git rev-parse --git-common-dir`) rather than the
-- worktree toplevel a `--show-toplevel` probe produced. For each row:
--
--   1. Derive the main root from the cwd when it names a worktree marker
--      (`/.worktrees/`, `/.claude/worktrees/`); use the cwd as-is otherwise.
--   2. Path lane: the operator's `path_prefix` mappings, longest prefix on a
--      segment boundary, exactly as `resolveProjectForCwd` matches. A
--      worktree nested under a mapped root already resolves here.
--   3. Remote lane, only when the path lane found nothing: the row's roster
--      identity's `repo_key` (a normalized remote) against the mappings'
--      `repo_url`, both through `siqshift_normalize_remote`. This is the
--      lane for worktrees stored outside every mapped root - two checkouts
--      of one remote are one project.
--   4. A lane that matches two different projects is ambiguous: the row is
--      left alone and counted, never guessed at. Two different remotes can
--      never collapse into one project - a remote only ever resolves through
--      a mapping that names the very same remote.
--
-- A row's `project_id` only moves when the re-resolution lands on a
-- different project. The value it held is written to
-- `agent_sessions.original_project_id` (added by 0017) on the first move and
-- never overwritten afterwards, so the change is inspectable and reversible:
--
--   UPDATE agent_sessions
--   SET project_id = original_project_id, original_project_id = NULL
--   WHERE original_project_id IS NOT NULL;
--
-- Idempotent and re-runnable. The migration applies the backfill once, and
-- the function stays behind for deliberate re-runs after the operator adds
-- or changes mappings (nothing re-runs a migration by itself):
--
--   SELECT backfill_agent_session_worktree_attribution(true);   -- dry run
--   SELECT backfill_agent_session_worktree_attribution(false);  -- apply
--
-- A second application that changes nothing returns moved: 0.
--
-- Scope notes. Only `agent_sessions` moves: it is the surface every report
-- (leaderboard, agent shifts) reads project time from. `cwd` is evidence of
-- where the shift ran and is deliberately left as it was;
-- `agents.repo_root` stays the first directory that minted the row, also
-- evidence; `shift_commits.repo_root` is a verification address and a dedup
-- key, not attribution, and is not rewritten here. A fresh database replaying
-- the chain has no legacy rows and this migration is a no-op there.
--
-- Backslash literals are spelled `chr(92)`: this file's statements travel
-- through drivers that consume backslash escapes in string literals, and a
-- literal `\` here would silently become nothing.

CREATE OR REPLACE FUNCTION siqshift_normalize_remote(remote text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
    candidate text;
    authority text;
    path text;
    host text;
    match text[];
BEGIN
    IF remote IS NULL THEN
        RETURN NULL;
    END IF;
    candidate := lower(btrim(remote));
    IF candidate = '' THEN
        RETURN NULL;
    END IF;
    -- A file URL names a directory, not a repository: the same refusal
    -- `normalizeRemote` in apps/api/src/services/attribution.ts makes.
    IF candidate LIKE 'file://%' THEN
        RETURN NULL;
    END IF;
    IF candidate ~ '^[a-z][a-z0-9+.-]*://' THEN
        match := regexp_match(candidate, '^[a-z][a-z0-9+.-]*://([^/]*)/(.*)$');
        IF match IS NULL THEN
            RETURN NULL;
        END IF;
        authority := match[1];
        path := match[2];
    ELSIF candidate ~ '^([^@/:]+@)?([^/:]{2,}):(.+)$' THEN
        -- The scp-style form git accepts without a scheme. The two-character
        -- host minimum is what keeps a drive-letter path out: `C:/dev/repo`
        -- has one character before its colon.
        match := regexp_match(candidate, '^([^@/:]+@)?([^/:]{2,}):(.+)$');
        authority := match[2];
        path := match[3];
    ELSE
        RETURN NULL;
    END IF;
    -- Credentials and transport are not identity: strip userinfo and port,
    -- then fold case, exactly as the TypeScript normalizer does.
    host := regexp_replace(authority, '^.*@', '');
    host := regexp_replace(host, ':[0-9]+$', '');
    IF host = '' THEN
        RETURN NULL;
    END IF;
    path := regexp_replace(path, '^/+', '');
    path := regexp_replace(path, '/+$', '');
    path := regexp_replace(path, '[.]git$', '');
    path := regexp_replace(path, '/+$', '');
    IF path = '' THEN
        RETURN NULL;
    END IF;
    RETURN host || '/' || path;
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
    -- and record the first value the row held before any pass touched it.
    IF NOT p_dry_run THEN
        UPDATE agent_sessions s
        SET project_id = plan.target_project_id,
            original_project_id = coalesce(s.original_project_id, s.project_id),
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

-- Apply the backfill as part of this migration, deliberately and once. A
-- dry run first (`SELECT backfill_agent_session_worktree_attribution(true)`)
-- reports the same numbers without writing anything.
SELECT backfill_agent_session_worktree_attribution(false);--> statement-breakpoint
