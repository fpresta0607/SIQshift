import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import type { AuthenticatedUser } from "../auth.js";
import { parseEnv } from "../env.js";
import type { DeviceRecord, DeviceRepository } from "../repositories.js";
import { createTestAuth } from "../test-tokens.js";

const ids = {
  organization: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  otherOrganization: "1e59dfd6-3d1f-4795-9420-3ab65f0df843",
  admin: "e0c7e513-b094-4d4c-ae55-21790ae019a4",
  member: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
  teammate: "e2c7e513-b094-4d4c-ae55-21790ae019a4",
  outsider: "e3c7e513-b094-4d4c-ae55-21790ae019a4",
  newerDevice: "9b1c7e51-3b09-44d4-ae55-21790ae019a4",
  olderDevice: "8b1c7e51-3b09-44d4-ae55-21790ae019a4",
  teammateDevice: "7b1c7e51-3b09-44d4-ae55-21790ae019a4",
};
const config = parseEnv({
  DATABASE_URL: "postgres://siqshift:password@localhost:5432/siqshift",
  AUTH_BASE_URL: "https://auth.siqshift.test/neondb/auth",
  NODE_ENV: "test",
});
const people: AuthenticatedUser[] = [
  { id: ids.admin, email: "ada@example.com", name: "Ada", organizationId: ids.organization, role: "admin", pictureVersion: null },
  { id: ids.member, email: "alex@example.com", name: "Alex", organizationId: ids.organization, role: "member", pictureVersion: null },
  { id: ids.teammate, email: "sam@example.com", name: "Sam", organizationId: ids.organization, role: "member", pictureVersion: null },
  { id: ids.outsider, email: "riley@example.com", name: "Riley", organizationId: ids.otherOrganization, role: "member", pictureVersion: null },
];

let keys: Awaited<ReturnType<typeof createTestAuth>>["keys"];
let bearerHeaders: Record<"admin" | "member", string>;

beforeAll(async () => {
  const auth = await createTestAuth(config, new Date("2026-08-06T14:00:00.000Z"));
  keys = auth.keys;
  bearerHeaders = { admin: await auth.bearer(ids.admin), member: await auth.bearer(ids.member) };
});

class MemoryDevices implements DeviceRepository {
  public constructor(private readonly rows: Map<string, DeviceRecord[]>) {}

  public async recordSeen(): Promise<void> {
    throw new Error("Not used by the read route.");
  }

  public async listForUser(organizationId: string, userId: string): Promise<DeviceRecord[]> {
    return this.rows.get(`${organizationId}/${userId}`) ?? [];
  }
}

function createTestApp() {
  const rows = new Map<string, DeviceRecord[]>([
    [`${ids.organization}/${ids.member}`, [
      { id: ids.newerDevice, appVersion: "0.2.7", lastSeenAt: new Date("2026-08-06T13:00:00.000Z") },
      { id: ids.olderDevice, appVersion: null, lastSeenAt: new Date("2026-08-01T09:30:00.000Z") },
    ]],
    [`${ids.organization}/${ids.teammate}`, [
      { id: ids.teammateDevice, appVersion: "0.2.6", lastSeenAt: new Date("2026-08-05T10:00:00.000Z") },
    ]],
  ]);
  return createApp({
    config,
    keys,
    accounts: { resolve: async (identity) => people.find((person) => person.id === identity.authUserId) },
    clock: () => new Date("2026-08-06T14:00:00.000Z"),
    deviceRepository: new MemoryDevices(rows),
  });
}

describe("device routes", () => {
  it("requires a bearer token", async () => {
    const response = await createTestApp().request("http://api.test/devices");
    expect(response.status).toBe(401);
  });

  it("lists the caller's own devices with ISO timestamps", async () => {
    const response = await createTestApp().request("http://api.test/devices", { headers: { authorization: bearerHeaders.member } });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      devices: [
        { id: ids.newerDevice, appVersion: "0.2.7", lastSeenAt: "2026-08-06T13:00:00.000Z" },
        { id: ids.olderDevice, appVersion: null, lastSeenAt: "2026-08-01T09:30:00.000Z" },
      ],
    });
  });

  it("reads the caller's own devices when the userId names the caller", async () => {
    const response = await createTestApp().request(`http://api.test/devices?userId=${ids.member}`, {
      headers: { authorization: bearerHeaders.member },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ devices: [{ id: ids.newerDevice }, { id: ids.olderDevice }] });
  });

  it("lets an administrator read a teammate's devices", async () => {
    const response = await createTestApp().request(`http://api.test/devices?userId=${ids.teammate}`, {
      headers: { authorization: bearerHeaders.admin },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      devices: [{ id: ids.teammateDevice, appVersion: "0.2.6", lastSeenAt: "2026-08-05T10:00:00.000Z" }],
    });
  });

  it("refuses a member reading a teammate's devices", async () => {
    const response = await createTestApp().request(`http://api.test/devices?userId=${ids.teammate}`, {
      headers: { authorization: bearerHeaders.member },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "forbidden" } });
  });

  it("answers an administrator naming a user of another workspace with an empty list", async () => {
    const response = await createTestApp().request(`http://api.test/devices?userId=${ids.outsider}`, {
      headers: { authorization: bearerHeaders.admin },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ devices: [] });
  });

  it.each(["?userId=not-a-uuid", "?unknown=1"])("rejects the invalid query %s", async (query) => {
    const response = await createTestApp().request(`http://api.test/devices${query}`, { headers: { authorization: bearerHeaders.admin } });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "validation_error" } });
  });
});
