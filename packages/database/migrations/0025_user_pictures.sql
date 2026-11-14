-- Uploaded profile pictures, hand-written for the same reason 0018 through
-- 0024 are: the generated snapshots under meta/ stop at 0017, so drizzle-kit
-- generate would re-emit every hand-written migration since as a diff.
--
-- What it is for
-- --------------
-- A member uploads one small picture, and their workspace draws it. The bytes
-- sit in their own table so no read of a member can carry them: every other
-- read selects users.picture_version alone, and the bytes leave the database
-- only on the picture read itself, which a client caches for good under that
-- version. The production database once hit its monthly data-transfer quota,
-- and a picture riding along on every poll is exactly how it would again.
--
-- Why it is safe
-- --------------
-- Both changes are additive. The new column is nullable with no default, so
-- it rewrites no row, and nothing reads the new table until the release that
-- writes it. Deleting a user deletes their picture with them.
ALTER TABLE "users" ADD COLUMN "picture_version" text;--> statement-breakpoint
CREATE TABLE "user_pictures" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"content_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_pictures_content_type_valid" CHECK ("user_pictures"."content_type" in ('image/jpeg', 'image/png', 'image/webp'))
);
--> statement-breakpoint
ALTER TABLE "user_pictures" ADD CONSTRAINT "user_pictures_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
