import { DEFAULT_PROJECT_APPEARANCE, projectAppearance } from "@siqshift/shared";
import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { parseEnv } from "../env.js";
import type { ProjectRecord, ProjectRepository } from "../repositories.js";
import { createTestAuth } from "../test-tokens.js";

const ids = {
  organization: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  user: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
  project: "a1c7e513-b094-4d4c-ae55-21790ae019a4",
  secondProject: "a2c7e513-b094-4d4c-ae55-21790ae019a4",
};
const config = parseEnv({
  DATABASE_URL: "postgres://siqshift:password@localhost:5432/siqshift",
  AUTH_BASE_URL: "https://auth.siqshift.test/neondb/auth",
  NODE_ENV: "test",
});
const ADMIN = "e2c7e513-b094-4d4c-ae55-21790ae019a4";
const users = {
  [ids.user]: { id: ids.user, email: "alex@example.com", name: "Alex", organizationId: ids.organization, role: "member" as const },
  [ADMIN]: { id: ADMIN, email: "admin@example.com", name: "Admin", organizationId: ids.organization, role: "admin" as const },
};

let keys: Awaited<ReturnType<typeof createTestAuth>>["keys"];
let bearerHeader: string;
let adminBearerHeader: string;

beforeAll(async () => {
  const auth = await createTestAuth(config, new Date("2026-08-06T14:00:00.000Z"));
  keys = auth.keys;
  bearerHeader = await auth.bearer(ids.user);
  adminBearerHeader = await auth.bearer(ADMIN);
});

class MemoryProjects implements ProjectRepository {
  public readonly records: ProjectRecord[] = [
    { id: ids.project, organizationId: ids.organization, name: "General", archived: false, isDefault: false, icon: null, color: null, createdAt: new Date("2026-08-10T12:00:00.000Z") },
  ];
  public readonly deleted: { projectId: string; reassignTo: string | null }[] = [];
  /** Archived rows included, exactly as the real repository now returns them. */
  public async listForMember() { return this.records; }
  public async findForMember(subject: { organizationId: string }, projectId: string) {
    return this.records.find((record) => record.id === projectId && record.organizationId === subject.organizationId) ?? null;
  }
  public async createForMember(subject: { organizationId: string; userId: string }, name: string) {
    const record: ProjectRecord = { id: crypto.randomUUID(), organizationId: subject.organizationId, name, archived: false, isDefault: false, icon: null, color: null, createdAt: new Date("2026-08-10T12:00:00.000Z") };
    this.records.push(record);
    return record;
  }
  /** The real rule: the flagged project, else the oldest active one, ties broken by id. */
  public async defaultIdForOrganization(subject: { organizationId: string }) {
    const [first] = this.records
      .filter((record) => record.organizationId === subject.organizationId && !record.archived)
      .sort((left, right) => Number(right.isDefault) - Number(left.isDefault)
        || left.createdAt.getTime() - right.createdAt.getTime()
        || left.id.localeCompare(right.id));
    return first?.id ?? null;
  }
  public async updateForMember(
    _subject: { organizationId: string },
    projectId: string,
    patch: { name?: string; archived?: boolean; icon?: string; color?: string },
  ) {
    const record = this.records.find((candidate) => candidate.id === projectId);
    if (record === undefined) return null;
    if (patch.name !== undefined) record.name = patch.name;
    if (patch.archived !== undefined) record.archived = patch.archived;
    if (patch.icon !== undefined) record.icon = patch.icon;
    if (patch.color !== undefined) record.color = patch.color;
    return record;
  }
  public async usageForOrganization() {
    return { sessionCount: 3, durationSeconds: 5_400, agentSessionCount: 1, agentCount: 2 };
  }
  public async deleteForOrganization(_subject: { organizationId: string }, projectId: string, reassignTo: string | null) {
    this.deleted.push({ projectId, reassignTo });
    const index = this.records.findIndex((record) => record.id === projectId);
    if (index >= 0) this.records.splice(index, 1);
  }
}

/** A second project, a day younger than General unless a test says otherwise. */
function secondProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: ids.secondProject,
    organizationId: ids.organization,
    name: "Side work",
    archived: false,
    isDefault: false,
    icon: null,
    color: null,
    createdAt: new Date("2026-08-11T12:00:00.000Z"),
    ...overrides,
  };
}

function createTestApp(projects = new MemoryProjects()) {
  return createApp({
    config,
    keys,
    accounts: { resolve: async (identity) => users[identity.authUserId as keyof typeof users] },
    clock: () => new Date("2026-08-06T14:00:00.000Z"),
    projectRepository: projects,
  });
}

describe("project routes", () => {
  it("requires a bearer token", async () => {
    const app = createTestApp();
    expect((await app.request("http://api.test/projects")).status).toBe(401);
    expect((await app.request("http://api.test/projects", { method: "POST" })).status).toBe(401);
  });

  it("creates a project, trims its name, and lists it for the creator", async () => {
    const headers = { authorization: bearerHeader, "content-type": "application/json" };
    const app = createTestApp();

    const created = await app.request("http://api.test/projects", {
      method: "POST", headers, body: JSON.stringify({ name: "  Field work  " }),
    });
    expect(created.status).toBe(201);
    const project = await created.json();
    expect(project).toMatchObject({ id: expect.any(String), name: "Field work", createdAt: "2026-08-10T12:00:00.000Z", isArchived: false });

    const listed = await app.request("http://api.test/projects", { headers });
    await expect(listed.json()).resolves.toMatchObject({
      projects: [
        { id: expect.any(String), name: "Field work", createdAt: "2026-08-10T12:00:00.000Z", isArchived: false },
        { id: ids.project, name: "General", createdAt: "2026-08-10T12:00:00.000Z", isArchived: false },
      ],
    });
  });

  it("rejects a duplicate name, case-insensitively", async () => {
    const headers = { authorization: bearerHeader, "content-type": "application/json" };
    const app = createTestApp();

    const first = await app.request("http://api.test/projects", {
      method: "POST", headers, body: JSON.stringify({ name: "Client Work" }),
    });
    expect(first.status).toBe(201);
    // "client work" and "Client Work" are one project to a person.
    const second = await app.request("http://api.test/projects", {
      method: "POST", headers, body: JSON.stringify({ name: "client work" }),
    });
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toEqual({
      error: { code: "conflict", message: "A project with that name already exists." },
    });
  });

  it("validates the create body with a stable error code", async () => {
    const headers = { authorization: bearerHeader, "content-type": "application/json" };
    const app = createTestApp();

    const malformed = await app.request("http://api.test/projects", { method: "POST", headers, body: "{bad" });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: { code: "validation_error", message: "Invalid request body." } });

    const blank = await app.request("http://api.test/projects", { method: "POST", headers, body: JSON.stringify({ name: "   " }) });
    expect(blank.status).toBe(400);

    const tooLong = await app.request("http://api.test/projects", { method: "POST", headers, body: JSON.stringify({ name: "x".repeat(81) }) });
    expect(tooLong.status).toBe(400);
  });

  it("renames a project and refuses a name another project already uses", async () => {
    const headers = { authorization: bearerHeader, "content-type": "application/json" };
    const projects = new MemoryProjects();
    const app = createTestApp(projects);

    const renamed = await app.request(`http://api.test/projects/${ids.project}`, {
      method: "PATCH", headers, body: JSON.stringify({ name: "Field work" }),
    });
    expect(renamed.status).toBe(200);
    await expect(renamed.json()).resolves.toMatchObject({ name: "Field work" });

    const created = await app.request("http://api.test/projects", {
      method: "POST", headers, body: JSON.stringify({ name: "Client work" }),
    });
    const other = (await created.json()) as { id: string };
    const collision = await app.request(`http://api.test/projects/${other.id}`, {
      method: "PATCH", headers, body: JSON.stringify({ name: "field work" }),
    });
    expect(collision.status).toBe(409);
  });

  it("archives a project out of the pickers but keeps it listable for unarchiving", async () => {
    const headers = { authorization: bearerHeader, "content-type": "application/json" };
    const projects = new MemoryProjects();
    const app = createTestApp(projects);
    await app.request("http://api.test/projects", {
      method: "POST", headers, body: JSON.stringify({ name: "Retired" }),
    });
    const retired = projects.records.find((record) => record.name === "Retired");

    const archived = await app.request(`http://api.test/projects/${retired?.id}`, {
      method: "PATCH", headers, body: JSON.stringify({ isArchived: true }),
    });
    expect(archived.status).toBe(200);

    // Pickers never see it...
    const listed = await app.request("http://api.test/projects", { headers });
    const visible = (await listed.json()) as { projects: { name: string }[] };
    expect(visible.projects.map((project) => project.name)).not.toContain("Retired");

    // ...but the management surface can, which is the only way back.
    const all = await app.request("http://api.test/projects?includeArchived=true", { headers });
    const everything = (await all.json()) as { projects: { name: string; isArchived: boolean }[] };
    expect(everything.projects.find((project) => project.name === "Retired")?.isArchived).toBe(true);
  });

  it("reports what a delete would take, and lets only an admin take it", async () => {
    const projects = new MemoryProjects();
    const app = createTestApp(projects);
    await app.request("http://api.test/projects", {
      method: "POST",
      headers: { authorization: bearerHeader, "content-type": "application/json" },
      body: JSON.stringify({ name: "Doomed" }),
    });
    const doomed = projects.records.find((record) => record.name === "Doomed");

    const usage = await app.request(`http://api.test/projects/${doomed?.id}/usage`, { headers: { authorization: bearerHeader } });
    expect(usage.status).toBe(200);
    await expect(usage.json()).resolves.toEqual({ sessionCount: 3, durationSeconds: 5_400, agentSessionCount: 1, agentCount: 2 });

    // Deleting reaches other members' sessions, so a plain member may not.
    const refused = await app.request(`http://api.test/projects/${doomed?.id}`, {
      method: "DELETE",
      headers: { authorization: bearerHeader, "content-type": "application/json" },
      body: JSON.stringify({ reassignTo: null }),
    });
    expect(refused.status).toBe(403);

    const allowed = await app.request(`http://api.test/projects/${doomed?.id}`, {
      method: "DELETE",
      headers: { authorization: adminBearerHeader, "content-type": "application/json" },
      body: JSON.stringify({ reassignTo: ids.project }),
    });
    expect(allowed.status).toBe(204);
    expect(projects.deleted).toEqual([{ projectId: doomed?.id, reassignTo: ids.project }]);
  });

  it("refuses to delete the last active project", async () => {
    const projects = new MemoryProjects();
    const app = createTestApp(projects);

    const response = await app.request(`http://api.test/projects/${ids.project}`, {
      method: "DELETE",
      headers: { authorization: adminBearerHeader, "content-type": "application/json" },
      body: JSON.stringify({ reassignTo: null }),
    });

    expect(response.status).toBe(409);
    expect(projects.deleted).toEqual([]);
  });

  it("stores the icon and color a member picks and shows them to the rest of the workspace", async () => {
    const projects = new MemoryProjects();
    const app = createTestApp(projects);

    const picked = await app.request(`http://api.test/projects/${ids.project}`, {
      method: "PATCH",
      headers: { authorization: bearerHeader, "content-type": "application/json" },
      body: JSON.stringify({ icon: "rocket", color: "#85c6ff" }),
    });
    const listed = await app.request("http://api.test/projects", { headers: { authorization: adminBearerHeader } });

    expect(picked.status).toBe(200);
    await expect(picked.json()).resolves.toMatchObject({ id: ids.project, name: "General", icon: "rocket", color: "#85c6ff" });
    await expect(listed.json()).resolves.toMatchObject({ projects: [{ id: ids.project, icon: "rocket", color: "#85c6ff" }] });
  });

  it.each([
    { label: "an icon outside the list", body: { icon: "unicorn" } },
    { label: "an icon in the wrong case", body: { icon: "Rocket" } },
    { label: "a color outside the palette", body: { color: "#123456" } },
    { label: "a color given by its name", body: { color: "Mint" } },
  ])("refuses $label with a validation error and stores nothing", async ({ body }) => {
    const projects = new MemoryProjects();
    const app = createTestApp(projects);

    const response = await app.request(`http://api.test/projects/${ids.project}`, {
      method: "PATCH",
      headers: { authorization: bearerHeader, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { code: "validation_error", message: "Invalid request body." } });
    expect(projects.records).toEqual([expect.objectContaining({ icon: null, color: null })]);
  });

  it.each([
    {
      label: "the oldest active project when no project carries the flag",
      second: secondProject(),
      isGeneralArchived: false,
      defaultId: ids.project,
      otherId: ids.secondProject,
    },
    {
      label: "the flagged project over an older one",
      second: secondProject({ isDefault: true }),
      isGeneralArchived: false,
      defaultId: ids.secondProject,
      otherId: ids.project,
    },
    {
      label: "the oldest project still active when an older one is archived",
      second: secondProject(),
      isGeneralArchived: true,
      defaultId: ids.secondProject,
      otherId: ids.project,
    },
  ])("draws $label with the default pair and the other with its assigned pair", async ({ second, isGeneralArchived, defaultId, otherId }) => {
    const projects = new MemoryProjects();
    projects.records.push(second);
    for (const record of projects.records) {
      if (record.id === ids.project) record.archived = isGeneralArchived;
    }
    const app = createTestApp(projects);

    const listed = await app.request("http://api.test/projects?includeArchived=true", { headers: { authorization: bearerHeader } });

    const { projects: items } = (await listed.json()) as { projects: { id: string; icon: string; color: string }[] };
    expect(items.find((item) => item.id === defaultId)).toMatchObject(DEFAULT_PROJECT_APPEARANCE);
    expect(items.find((item) => item.id === otherId))
      .toMatchObject(projectAppearance({ id: otherId, isDefault: false, icon: null, color: null }));
  });

  it("answers a new project with the pair its id assigns, and every member reads that same pair", async () => {
    const projects = new MemoryProjects();
    projects.records.push(secondProject({ isDefault: true }));
    const app = createTestApp(projects);

    const created = await app.request("http://api.test/projects", {
      method: "POST",
      headers: { authorization: bearerHeader, "content-type": "application/json" },
      body: JSON.stringify({ name: "Field work" }),
    });
    const project = (await created.json()) as { id: string };
    const reads = await Promise.all([bearerHeader, adminBearerHeader, bearerHeader].map(async (authorization) => {
      const listed = await app.request("http://api.test/projects", { headers: { authorization } });
      return ((await listed.json()) as { projects: { id: string; icon: string; color: string }[] }).projects
        .find((item) => item.id === project.id);
    }));

    const assigned = projectAppearance({ id: project.id, isDefault: false, icon: null, color: null });
    expect(project).toMatchObject(assigned);
    expect(reads).toEqual([expect.objectContaining(assigned), expect.objectContaining(assigned), expect.objectContaining(assigned)]);
  });
});
