-- Audit stamp fix-forward, part two. 0019 tried to stamp the rows the 0018
-- backfill had moved by fingerprinting the backfill transaction's `updated_at`
-- cluster, but the fingerprint was not unique: rows ingest had attributed at
-- insert form `updated_at` clusters of their own (every row in one upload
-- batch shares the batch's clock), so 0019 stamped thirteen rows ingest had
-- attributed and none of the forty-eight the backfill had moved. This
-- migration clears those wrong stamps and re-stamps on a rule that does not
-- depend on timestamps at all.
--
-- The deterministic rule: a row that was ingested BEFORE the mapping that
-- today resolves it (`received_at < winner_mapping.created_at`) cannot have
-- received its project at ingest - ingest resolves against the mappings that
-- exist at upload time - and the backfill is the only other writer of
-- `project_id`. So a row that is plan-resolved today, carries no
-- `original_project_id` (it moved from null), was ingested before its winning
-- mapping existed, and is not yet stamped, is exactly a row a backfill pass
-- moved from unattributed, and it gets the stamp. On any database replaying
-- the chain fresh there are no rows and this is a no-op; on the database 0018
-- ran against, it stamps precisely the rows that pass moved from null.
--
-- The backfill function's own writes already stamp the rows they move (the
-- coalesce in 0019's function), so future passes need no repair.

UPDATE agent_sessions
SET attribution_backfilled_at = NULL
WHERE attribution_backfilled_at IS NOT NULL;--> statement-breakpoint

UPDATE agent_sessions s
SET attribution_backfilled_at = now()
FROM (
    SELECT d.id
    FROM (
        SELECT s.id, s.project_id,
               replace(s.cwd, chr(92), '/') AS ncwd,
               s.received_at,
               s.original_project_id,
               s.attribution_backfilled_at
        FROM agent_sessions s
    ) d
    JOIN project_path_mappings m
        ON m.user_id = (SELECT x.user_id FROM agent_sessions x WHERE x.id = d.id)
        AND m.kind = 'path_prefix'
        AND (
            lower(rtrim(replace(m.path_prefix, chr(92), '/'), '/')) = lower(rtrim(d.ncwd, '/'))
            OR lower(rtrim(d.ncwd, '/')) LIKE lower(rtrim(replace(m.path_prefix, chr(92), '/'), '/')) || '/%'
        )
    WHERE d.project_id IS NOT NULL
      AND d.original_project_id IS NULL
      AND d.attribution_backfilled_at IS NULL
      AND d.received_at < m.created_at
      AND d.project_id = m.project_id
      AND length(rtrim(replace(m.path_prefix, chr(92), '/'), '/')) = (
            SELECT max(length(rtrim(replace(m2.path_prefix, chr(92), '/'), '/')))
            FROM project_path_mappings m2
            WHERE m2.user_id = m.user_id
              AND m2.kind = 'path_prefix'
              AND (
                lower(rtrim(replace(m2.path_prefix, chr(92), '/'), '/')) = lower(rtrim(d.ncwd, '/'))
                OR lower(rtrim(d.ncwd, '/')) LIKE lower(rtrim(replace(m2.path_prefix, chr(92), '/'), '/')) || '/%'
              )
          )
) moved
WHERE s.id = moved.id;--> statement-breakpoint
