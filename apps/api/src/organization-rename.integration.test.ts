import { randomUUID } from "node:crypto";

import {
  createDisposableTestDatabase,
  runMigrations,
  type DatabaseConnection,
  type DisposableTestDatabase,
} from "@siqshift/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { DrizzleAccountStore } from "./drizzle-repositories.js";
import { parseEnv } from "./env.js";
import { createTestAuth } from "./test-tokens.js";

const databaseUrl = process.env.TEST_DATABASE_URL || undefined;
const integration = databaseUrl ? describe : describe.skip;

const REFUSAL = { error: { code: "forbidden", message: "Only a workspace administrator can rename the workspace." } };

// The rename's role check rides in the same UPDATE as the write, and the join
// lands an account by code whatever its email domain. Only a real PostgreSQL
// runs that statement, so the guarantees are proven here, not with a fake store.
integration("renaming a workspace", () => {
  let disposable: DisposableTestDatabase | undefined;
  let database = undefined as unknown as DatabaseConnection;
  let app: ReturnType<typeof createApp>;
  let auth: Awaited<ReturnType<typeof createTestAuth>>;

  beforeAll(async () => {
    if (!databaseUrl) return;
    disposable = await createDisposableTestDatabase(databaseUrl, "organization_rename");
    database = disposable.database;
    await runMigrations(database);
    const config = parseEnv({
      DATABASE_URL: disposable.databaseUrl,
      AUTH_BASE_URL: "https://auth.siqshift.test/neondb/auth",
      NODE_ENV: "test",
    });
    auth = await createTestAuth(config, new Date());
    app = createApp({ config, keys: auth.keys, accounts: new DrizzleAccountStore(database.db) });
  }, 60_000);

  afterAll(async () => {
    if (disposable === undefined) return;
    await disposable.cleanup();
  });

  async function headersFor(email: string, name: string): Promise<Record<string, string>> {
    return { authorization: await auth.bearer(randomUUID(), { email, name }), "content-type": "application/json" };
  }

  async function workspaceOf(headers: Record<string, string>): Promise<{ id: string; name: string; inviteCode: string }> {
    const response = await app.request("/organization", { headers });
    expect(response.status).toBe(200);
    return (await response.json()).organization;
  }

  async function rename(headers: Record<string, string>, name: string): Promise<Response> {
    return app.request("/organization", { method: "PATCH", headers, body: JSON.stringify({ name }) });
  }

  it("renames for its administrator, and a teammate on another email domain joins it by the code", async () => {
    // Arrange: the creator of a workspace is its administrator.
    const administrator = await headersFor("alex@siqshift.test", "Alex Morgan");
    const before = await workspaceOf(administrator);
    const newcomer = await headersFor("riley@fieldcrew.test", "Riley Chen");

    // Act
    const renamed = await rename(administrator, "  Field Crew  ");
    const joined = await app.request("/accounts", {
      method: "POST",
      headers: newcomer,
      body: JSON.stringify({ inviteCode: before.inviteCode }),
    });

    // Assert: the name is all that changed, and every read of it agrees.
    expect(renamed.status).toBe(200);
    await expect(renamed.json()).resolves.toEqual({ organization: { ...before, name: "Field Crew" } });
    await expect(workspaceOf(administrator)).resolves.toEqual({ ...before, name: "Field Crew" });
    expect(joined.status).toBe(200);
    await expect(joined.json()).resolves.toMatchObject({ user: { organizationId: before.id, role: "member" } });
    await expect(workspaceOf(newcomer)).resolves.toMatchObject({ id: before.id, name: "Field Crew" });
  }, 60_000);

  it("refuses a member who is not its administrator, and leaves the name as it was", async () => {
    // Arrange
    const administrator = await headersFor("sam@siqshift.test", "Sam Patel");
    const { inviteCode, name } = await workspaceOf(administrator);
    const member = await headersFor("op@othercrew.test", "Op Rivera");
    await app.request("/accounts", { method: "POST", headers: member, body: JSON.stringify({ inviteCode }) });

    // Act
    const response = await rename(member, "Taken Over");

    // Assert
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(REFUSAL);
    await expect(workspaceOf(administrator)).resolves.toMatchObject({ name });
  }, 60_000);

  it("renames only the administrator's own workspace, never another's", async () => {
    // Arrange
    const first = await headersFor("dev@siqshift.test", "Dev Okafor");
    const second = await headersFor("a@elsewhere.test", "A Lindqvist");
    const firstBefore = await workspaceOf(first);
    const secondBefore = await workspaceOf(second);

    // Act
    const response = await rename(second, "Second Crew");

    // Assert
    expect(response.status).toBe(200);
    await expect(workspaceOf(second)).resolves.toEqual({ ...secondBefore, name: "Second Crew" });
    await expect(workspaceOf(first)).resolves.toEqual(firstBefore);
  }, 60_000);

  it("refuses an administrator demoted after the role was read, in the same statement that would rename", async () => {
    // Arrange: the subject still says admin, as it would mid-request.
    const organizationId = randomUUID();
    const userId = randomUUID();
    await database.client`
      insert into organizations (id, name, invite_code) values (${organizationId}, 'Stale Read', 'ACDEF-GHJKN')
    `;
    await database.client`
      insert into users (id, organization_id, email, name, role)
      values (${userId}, ${organizationId}, 'stale@siqshift.test', 'Stale Reader', 'member')
    `;
    const accounts = new DrizzleAccountStore(database.db);

    // Act
    const renamed = await accounts.renameOrganization({ organizationId, userId, role: "admin" }, "Renamed Anyway");

    // Assert
    expect(renamed).toBeNull();
    await expect(accounts.findOrganization(organizationId)).resolves.toMatchObject({ name: "Stale Read" });
  }, 60_000);
});
