-- A project's chosen icon and color, hand-written for the same reason 0018
-- through 0023 are: the generated snapshots under meta/ stop at 0017, so
-- drizzle-kit generate would re-emit every hand-written migration since as a
-- diff.
--
-- What it is for
-- --------------
-- The team view draws every project with a built-in icon and color. Any
-- member may pick both from fixed lists the API validates; a project nobody
-- has picked for keeps both columns null and is drawn with the pair the API
-- assigns from its id, so there is nothing to backfill.
--
-- Why it is safe
-- --------------
-- A nullable column with no default is a catalog change: it rewrites no row
-- and holds its lock only for that change. The running API selects named
-- columns, so it neither reads nor depends on these two until the release that
-- writes them.
ALTER TABLE "projects" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "color" text;
