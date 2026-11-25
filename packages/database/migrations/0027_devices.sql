-- The machines a member uploads from, and the desktop build each last said it
-- was, hand-written for the same reason 0018 through 0026 are: the generated
-- snapshots under meta/ stop at 0017, so drizzle-kit generate would re-emit
-- every hand-written migration since as a diff.
--
-- What it is for
-- --------------
-- A member's desktop uploads from one machine, identified by a device id the
-- app mints for itself, and sends the build it is running with each upload.
-- When a fix ships only in a newer build, the workspace needs to see which
-- machines still run an older one. One row per member and device id, kept up
-- to date by the upload path; the primary key includes the member because one
-- machine signed in under two accounts uploads under each. A null version is a
-- build too old to send one.
--
-- Why it is safe
-- --------------
-- The change is one new table, so it rewrites and locks nothing that exists,
-- and the running API neither reads nor writes it until the release that does.
-- There is nothing to backfill: a machine's row appears with its next upload.
-- Deleting a member deletes their devices with them.
CREATE TABLE "devices" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"app_version" text,
	"last_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_pkey" PRIMARY KEY("organization_id","user_id","id"),
	CONSTRAINT "devices_app_version_length_valid" CHECK ("devices"."app_version" is null or char_length("devices"."app_version") <= 64)
);
--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_organization_user_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE cascade ON UPDATE no action;
