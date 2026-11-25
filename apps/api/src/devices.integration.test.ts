import { randomUUID } from "node:crypto";

import {
  createDisposableTestDatabase,
  runMigrations,
  type DatabaseConnection,
  type DisposableTestDatabase,
} from "@siqshift/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DrizzleDeviceRepository } from "./drizzle-repositories.js";

const databaseUrl = process.env.TEST_DATABASE_URL || undefined;
const integration = databaseUrl ? describe : describe.skip;

// The most-recent-report-wins rule lives in the upsert's WHERE clause, and a
// mocked repository would pass whether or not postgres honours it.
integration("stored devices", () => {
  let disposable: DisposableTestDatabase | undefined;
  let database: DatabaseConnection;
  let devices: DrizzleDeviceRepository;
  const organizationId = randomUUID();

  beforeAll(async () => {
    if (!databaseUrl) return;
    disposable = await createDisposableTestDatabase(databaseUrl, "devices");
    database = disposable.database;
    await runMigrations(database);
    await database.client`
      insert into organizations (id, name, invite_code)
      values (${organizationId}, 'Device Test', ${randomUUID().slice(0, 11)})
    `;
    devices = new DrizzleDeviceRepository(database.db);
  }, 60_000);

  afterAll(async () => {
    if (disposable === undefined) return;
    await disposable.cleanup();
  });

  async function member(): Promise<string> {
    const userId = randomUUID();
    await database.client`
      insert into users (id, organization_id, email, name, role)
      values (${userId}, ${organizationId}, ${`${userId}@siqshift.test`}, 'Device User', 'member')
    `;
    return userId;
  }

  const first = new Date("2026-08-06T10:00:00.000Z");
  const second = new Date("2026-08-06T11:00:00.000Z");
  const third = new Date("2026-08-06T12:00:00.000Z");

  it("keeps the newest report's version and time when a later upload arrives", async () => {
    const userId = await member();
    const deviceId = randomUUID();

    await devices.recordSeen({ organizationId, userId, deviceIds: [deviceId], appVersion: null, seenAt: first });
    await devices.recordSeen({ organizationId, userId, deviceIds: [deviceId], appVersion: "0.2.7", seenAt: second });

    await expect(devices.listForUser(organizationId, userId)).resolves.toEqual([
      { id: deviceId, appVersion: "0.2.7", lastSeenAt: second },
    ]);
  });

  it("does not let a stale report overwrite a newer one", async () => {
    const userId = await member();
    const deviceId = randomUUID();

    await devices.recordSeen({ organizationId, userId, deviceIds: [deviceId], appVersion: "0.2.7", seenAt: second });
    await devices.recordSeen({ organizationId, userId, deviceIds: [deviceId], appVersion: "0.2.6", seenAt: first });

    await expect(devices.listForUser(organizationId, userId)).resolves.toEqual([
      { id: deviceId, appVersion: "0.2.7", lastSeenAt: second },
    ]);
  });

  it("records several devices in one call and lists the most recently seen first", async () => {
    const userId = await member();
    // The older device has the lower id and is stored first, so a heap scan, a
    // primary-key scan and an ascending sort all list it first.
    const [older, newer] = [randomUUID(), randomUUID()].sort();

    await devices.recordSeen({ organizationId, userId, deviceIds: [older, newer], appVersion: "0.2.6", seenAt: first });
    await devices.recordSeen({ organizationId, userId, deviceIds: [newer], appVersion: "0.2.7", seenAt: third });
    await devices.recordSeen({ organizationId, userId, deviceIds: [], appVersion: "0.2.7", seenAt: third });

    await expect(devices.listForUser(organizationId, userId)).resolves.toEqual([
      { id: newer, appVersion: "0.2.7", lastSeenAt: third },
      { id: older, appVersion: "0.2.6", lastSeenAt: first },
    ]);
  });

  it("keeps one machine signed in under two accounts as one row each", async () => {
    const [userId, otherUserId] = [await member(), await member()];
    const deviceId = randomUUID();

    await devices.recordSeen({ organizationId, userId, deviceIds: [deviceId], appVersion: "0.2.7", seenAt: second });
    await devices.recordSeen({ organizationId, userId: otherUserId, deviceIds: [deviceId], appVersion: "0.2.6", seenAt: first });

    await expect(devices.listForUser(organizationId, userId)).resolves.toMatchObject([{ appVersion: "0.2.7" }]);
    await expect(devices.listForUser(organizationId, otherUserId)).resolves.toMatchObject([{ appVersion: "0.2.6" }]);
  });

  it("refuses an over-long version and removes a member's devices with the member", async () => {
    const userId = await member();
    const deviceId = randomUUID();

    await expect(devices.recordSeen({ organizationId, userId, deviceIds: [deviceId], appVersion: "1".repeat(65), seenAt: first }))
      .rejects.toThrow();

    await devices.recordSeen({ organizationId, userId, deviceIds: [deviceId], appVersion: "0.2.7", seenAt: first });
    await database.client`delete from users where id = ${userId}`;

    await expect(devices.listForUser(organizationId, userId)).resolves.toEqual([]);
  });
});
