import { randomUUID } from "node:crypto";

import {
  createDisposableTestDatabase,
  runMigrations,
  type DatabaseConnection,
  type DisposableTestDatabase,
} from "@siqshift/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuthenticatedSubject } from "./auth.js";
import { DrizzlePictureRepository } from "./drizzle-repositories.js";

const databaseUrl = process.env.TEST_DATABASE_URL || undefined;
const integration = databaseUrl ? describe : describe.skip;

const samples = {
  jpeg: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
  png: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
};

// The bytes sit in a bytea column behind a custom Drizzle type, the version on
// users, and the read joins the two under the caller's organization. Only a
// real PostgreSQL proves the bytes come back as they went in, that a second
// upload is still one row, and that deleting a user takes their picture along.
integration("stored profile pictures", () => {
  let disposable: DisposableTestDatabase | undefined;
  let database: DatabaseConnection;
  let pictures: DrizzlePictureRepository;
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();

  beforeAll(async () => {
    if (!databaseUrl) return;
    disposable = await createDisposableTestDatabase(databaseUrl, "user_pictures");
    database = disposable.database;
    await runMigrations(database);
    await database.client`
      insert into organizations (id, name, invite_code)
      values
        (${organizationId}, 'Picture Test', ${randomUUID().slice(0, 11)}),
        (${otherOrganizationId}, 'Other Picture Test', ${randomUUID().slice(0, 11)})
    `;
    pictures = new DrizzlePictureRepository(database.db);
  }, 60_000);

  afterAll(async () => {
    if (disposable === undefined) return;
    await disposable.cleanup();
  });

  /** A new member with no picture, so no case leans on another's. */
  async function member(memberOrganizationId = organizationId): Promise<AuthenticatedSubject> {
    const userId = randomUUID();
    await database.client`
      insert into users (id, organization_id, email, name, role)
      values (${userId}, ${memberOrganizationId}, ${`${userId}@siqshift.test`}, 'Picture User', 'member')
    `;
    return { userId, organizationId: memberOrganizationId, role: "member" };
  }

  /** The stored picture with its bytes as a plain Uint8Array, since the driver hands bytea back as a Buffer. */
  async function stored(subject: AuthenticatedSubject, userId: string) {
    const picture = await pictures.find(subject, userId);
    return picture === null ? null : { ...picture, bytes: new Uint8Array(picture.bytes) };
  }

  /** The version the member's row names, beside how many picture rows they hold. */
  async function storedState(userId: string) {
    const versions = await database.client<{ picture_version: string | null }[]>`select picture_version from users where id = ${userId}`;
    const rows = await database.client<{ total: number }[]>`select count(*)::int as total from user_pictures where user_id = ${userId}`;
    return { version: versions[0]?.picture_version, rows: rows[0]?.total };
  }

  it("reads a picture back as it was saved, for a teammate, under the member's version", async () => {
    const owner = await member();
    const teammate = await member();

    await pictures.save(owner, { contentType: "image/png", bytes: samples.png, version: "1111111111111111" });

    await expect(stored(teammate, owner.userId)).resolves.toEqual({ contentType: "image/png", bytes: samples.png, version: "1111111111111111" });
    await expect(storedState(owner.userId)).resolves.toEqual({ version: "1111111111111111", rows: 1 });
  });

  it("replaces the first picture with the second in the same row", async () => {
    const owner = await member();

    await pictures.save(owner, { contentType: "image/jpeg", bytes: samples.jpeg, version: "2222222222222222" });
    await pictures.save(owner, { contentType: "image/png", bytes: samples.png, version: "3333333333333333" });

    await expect(stored(owner, owner.userId)).resolves.toEqual({ contentType: "image/png", bytes: samples.png, version: "3333333333333333" });
    await expect(storedState(owner.userId)).resolves.toEqual({ version: "3333333333333333", rows: 1 });
  });

  it("removes the picture and its version, and removing again changes nothing", async () => {
    const owner = await member();
    await pictures.save(owner, { contentType: "image/jpeg", bytes: samples.jpeg, version: "4444444444444444" });

    await pictures.remove(owner);
    await pictures.remove(owner);

    await expect(stored(owner, owner.userId)).resolves.toBeNull();
    await expect(storedState(owner.userId)).resolves.toEqual({ version: null, rows: 0 });
  });

  it("deletes a member's picture along with the member", async () => {
    const owner = await member();
    await pictures.save(owner, { contentType: "image/png", bytes: samples.png, version: "5555555555555555" });

    await database.client`delete from users where id = ${owner.userId}`;

    const remaining = await database.client`select user_id from user_pictures where user_id = ${owner.userId}`;
    expect(remaining).toEqual([]);
  });

  it("finds no picture of another organization's member, though their own teammates do", async () => {
    const outsider = await member(otherOrganizationId);
    const outsiderTeammate = await member(otherOrganizationId);
    const caller = await member();
    await pictures.save(outsider, { contentType: "image/jpeg", bytes: samples.jpeg, version: "6666666666666666" });

    await expect(stored(caller, outsider.userId)).resolves.toBeNull();
    await expect(stored(outsiderTeammate, outsider.userId)).resolves.toEqual({
      contentType: "image/jpeg",
      bytes: samples.jpeg,
      version: "6666666666666666",
    });
  });
});
