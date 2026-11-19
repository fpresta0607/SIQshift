import { randomUUID } from "node:crypto";

import {
  createDisposableTestDatabase,
  runMigrations,
  type DatabaseConnection,
  type DisposableTestDatabase,
} from "@siqshift/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuthenticatedSubject } from "./auth.js";
import { DrizzlePathMappingRepository, DrizzleProjectRepository } from "./drizzle-repositories.js";
import { PathMappingRepositoryError } from "./repositories.js";

const databaseUrl = process.env.TEST_DATABASE_URL || undefined;
const integration = databaseUrl ? describe : describe.skip;

// Picking a repository in the New project box makes the project and its folder
// link together. Only a real PostgreSQL can prove the pair is one transaction:
// a prefix the person already maps must leave no project behind.
integration("creating a project with a folder link", () => {
  let disposable: DisposableTestDatabase | undefined;
  let database = undefined as unknown as DatabaseConnection;
  const organizationId = randomUUID();
  const userId = randomUUID();
  const subject: AuthenticatedSubject = { organizationId, userId, role: "member" };
  let projects: DrizzleProjectRepository;
  let mappings: DrizzlePathMappingRepository;

  beforeAll(async () => {
    if (!databaseUrl) return;
    disposable = await createDisposableTestDatabase(databaseUrl, "projects_folder_link");
    database = disposable.database;
    await runMigrations(database);
    await database.client`
      insert into organizations (id, name, invite_code)
      values (${organizationId}, 'Folder Link Test', ${randomUUID().slice(0, 11)})
    `;
    await database.client`
      insert into users (id, organization_id, email, name, role)
      values (${userId}, ${organizationId}, 'link@siqshift.test', 'Link User', 'member')
    `;
    projects = new DrizzleProjectRepository(database.db);
    mappings = new DrizzlePathMappingRepository(database.db);
  }, 60_000);

  afterAll(async () => {
    if (disposable === undefined) return;
    await disposable.cleanup();
  });

  it("writes the project, the creator's membership and the folder link together", async () => {
    // Act
    const project = await projects.createForMember(subject, "Clock in", { pathPrefix: "C:/dev/clock-in", repoUrl: "https://github.com/acme/clock-in" });

    // Assert
    expect(await projects.findForMember(subject, project.id)).toMatchObject({ id: project.id, name: "Clock in" });
    expect(await mappings.listForSubject(subject)).toEqual([expect.objectContaining({
      kind: "path_prefix",
      pathPrefix: "C:/dev/clock-in",
      repoUrl: "https://github.com/acme/clock-in",
      projectId: project.id,
      userId,
    })]);
  });

  it("leaves no project behind when the person already maps that prefix", async () => {
    // Arrange
    const before = (await projects.listForMember(subject)).length;

    // Act
    const attempt = projects.createForMember(subject, "Clock in again", { pathPrefix: "C:/dev/clock-in", repoUrl: null });

    // Assert
    await expect(attempt).rejects.toBeInstanceOf(PathMappingRepositoryError);
    expect((await projects.listForMember(subject)).length).toBe(before);
  });
});
