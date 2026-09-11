-- Per-user, per-UTC-day rollup of the reporting math, hand-written because the
-- generated snapshots in meta/ stop at 0017 and running drizzle-kit here would
-- re-emit the hand-written 0018 through 0021 as a diff.
--
-- What it is for
-- --------------
-- The report path re-reads raw `activity_segments`, `time_sessions` and
-- `agent_sessions` rows on every request and folds them in JavaScript. Over an
-- all-time range that is thousands of rows and megabytes of Neon egress per
-- request, on a clock, to draw a handful of numbers. This table holds the fold
-- for a day that is over, so a long range spends whole days out of it.
--
-- Why a UTC day
-- -------------
-- Nothing in this schema stores a timezone, and two members of one workspace
-- can sit in different ones, so a UTC day is the only boundary the data model
-- can state. The report path therefore spends whole UTC days out of this table
-- and reads raw rows for the partial day at each end of a range. Union and the
-- concurrency sweep both add exactly across a partition of the timeline, so
-- that split is exact rather than an approximation.
--
-- Why milliseconds
-- ----------------
-- The reporting module rounds to seconds once per group, after summing. A
-- table of pre-rounded day-seconds would drift by up to a second per day
-- against the answer the live path gives, and the two paths have to agree.
--
-- Why it is safe
-- --------------
-- Every column is a cache of rows that are still here; nothing is deleted by
-- this migration and nothing reads it exclusively. A missing row is always
-- correct, because the report path falls back to folding that day live. That
-- is what lets maintenance decline today, the one day it cannot fold honestly
-- at all, by writing no row for it. A finished day a session is still running
-- through is folded, and refolded on every event that session reports: an open
-- session is measured up to its last event, so that day's share of it moves
-- until the session closes.
--
-- The two check constraints are not decoration. `day` must be midnight UTC or
-- the row folds against the wrong boundary and every range spending it is
-- wrong; and active time must equal its own concurrency partition, which is the
-- invariant `packages/shared/src/intervals.ts` holds everywhere else.
CREATE TABLE "user_daily_rollups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"day" timestamp with time zone NOT NULL,
	"active_ms" bigint NOT NULL,
	"agent_ms" bigint NOT NULL,
	"concurrency_0_ms" bigint NOT NULL,
	"concurrency_1_ms" bigint NOT NULL,
	"concurrency_2_ms" bigint NOT NULL,
	"concurrency_3_plus_ms" bigint NOT NULL,
	"away_ms" bigint NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_daily_rollups_organization_user_day_unique" UNIQUE("organization_id","user_id","day"),
	CONSTRAINT "user_daily_rollups_active_ms_nonnegative" CHECK ("user_daily_rollups"."active_ms" >= 0),
	CONSTRAINT "user_daily_rollups_agent_ms_nonnegative" CHECK ("user_daily_rollups"."agent_ms" >= 0),
	CONSTRAINT "user_daily_rollups_concurrency_0_ms_nonnegative" CHECK ("user_daily_rollups"."concurrency_0_ms" >= 0),
	CONSTRAINT "user_daily_rollups_concurrency_1_ms_nonnegative" CHECK ("user_daily_rollups"."concurrency_1_ms" >= 0),
	CONSTRAINT "user_daily_rollups_concurrency_2_ms_nonnegative" CHECK ("user_daily_rollups"."concurrency_2_ms" >= 0),
	CONSTRAINT "user_daily_rollups_concurrency_3_plus_ms_nonnegative" CHECK ("user_daily_rollups"."concurrency_3_plus_ms" >= 0),
	CONSTRAINT "user_daily_rollups_away_ms_nonnegative" CHECK ("user_daily_rollups"."away_ms" >= 0),
	CONSTRAINT "user_daily_rollups_day_is_utc_midnight" CHECK ("user_daily_rollups"."day" = date_trunc('day', "user_daily_rollups"."day" at time zone 'UTC') at time zone 'UTC'),
	CONSTRAINT "user_daily_rollups_concurrency_partitions_active" CHECK ("user_daily_rollups"."active_ms" = "user_daily_rollups"."concurrency_0_ms" + "user_daily_rollups"."concurrency_1_ms" + "user_daily_rollups"."concurrency_2_ms" + "user_daily_rollups"."concurrency_3_plus_ms")
);
--> statement-breakpoint
ALTER TABLE "user_daily_rollups" ADD CONSTRAINT "user_daily_rollups_organization_user_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_daily_rollups_organization_day_idx" ON "user_daily_rollups" USING btree ("organization_id","day");
