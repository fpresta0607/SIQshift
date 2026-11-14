import { DEFAULT_PROJECT_APPEARANCE, projectAppearance } from "@siqshift/shared";
import { describe, expect, it } from "vitest";

import { createProject, listProjects, type ProjectRepository } from "./projects.js";

const subject = {
  organizationId: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  userId: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
  role: "member" as const,
};

const assigned = (id: string) => projectAppearance({ id, isDefault: false, icon: null, color: null });

describe("project service", () => {
  it("lists only active projects accessible to the authenticated member in deterministic order", async () => {
    const repository: ProjectRepository = {
      listForMember: async () => [
        { id: "c1e7c513-b094-4d4c-ae55-21790ae019a4", organizationId: subject.organizationId, name: "alpha", archived: false, createdAt: new Date("2026-08-10T12:00:00.000Z") },
        { id: "b1e7c513-b094-4d4c-ae55-21790ae019a4", organizationId: subject.organizationId, name: "Alpha", archived: false, createdAt: new Date("2026-08-10T12:00:00.000Z") },
        { id: "e1e7c513-b094-4d4c-ae55-21790ae019a4", organizationId: subject.organizationId, name: "Álpha", archived: false, createdAt: new Date("2026-08-10T12:00:00.000Z") },
        { id: "d1e7c513-b094-4d4c-ae55-21790ae019a4", organizationId: subject.organizationId, name: "Zebra", archived: false, createdAt: new Date("2026-08-10T12:00:00.000Z") },
        { id: "a1e7c513-b094-4d4c-ae55-21790ae019a4", organizationId: subject.organizationId, name: "Alpha", archived: false, createdAt: new Date("2026-08-10T12:00:00.000Z") },
      ],
      findForMember: async () => null,
      createForMember: async () => { throw new Error("not implemented"); },
      defaultIdForOrganization: async () => "a1e7c513-b094-4d4c-ae55-21790ae019a4",
    };

    await expect(listProjects(repository, subject)).resolves.toEqual({
      projects: [
        { id: "a1e7c513-b094-4d4c-ae55-21790ae019a4", name: "Alpha", ...DEFAULT_PROJECT_APPEARANCE, createdAt: "2026-08-10T12:00:00.000Z", isArchived: false },
        { id: "b1e7c513-b094-4d4c-ae55-21790ae019a4", name: "Alpha", ...assigned("b1e7c513-b094-4d4c-ae55-21790ae019a4"), createdAt: "2026-08-10T12:00:00.000Z", isArchived: false },
        { id: "d1e7c513-b094-4d4c-ae55-21790ae019a4", name: "Zebra", ...assigned("d1e7c513-b094-4d4c-ae55-21790ae019a4"), createdAt: "2026-08-10T12:00:00.000Z", isArchived: false },
        { id: "c1e7c513-b094-4d4c-ae55-21790ae019a4", name: "alpha", ...assigned("c1e7c513-b094-4d4c-ae55-21790ae019a4"), createdAt: "2026-08-10T12:00:00.000Z", isArchived: false },
        { id: "e1e7c513-b094-4d4c-ae55-21790ae019a4", name: "Álpha", ...assigned("e1e7c513-b094-4d4c-ae55-21790ae019a4"), createdAt: "2026-08-10T12:00:00.000Z", isArchived: false },
      ],
    });
  });

  it("creates a project for the member and returns the list-item shape", async () => {
    const created = {
      id: "f1e7c513-b094-4d4c-ae55-21790ae019a4",
      organizationId: subject.organizationId,
      name: "Field work",
      archived: false,
      createdAt: new Date("2026-08-10T12:00:00.000Z"),
    };
    const calls: Array<{ organizationId: string; userId: string; name: string }> = [];
    const repository: ProjectRepository = {
      listForMember: async () => [],
      findForMember: async () => null,
      createForMember: async (callSubject, name) => {
        calls.push({ organizationId: callSubject.organizationId, userId: callSubject.userId, name });
        return created;
      },
      defaultIdForOrganization: async () => "a1e7c513-b094-4d4c-ae55-21790ae019a4",
    };

    await expect(createProject(repository, subject, "Field work")).resolves.toEqual({
      id: created.id,
      name: "Field work",
      ...assigned(created.id),
      createdAt: "2026-08-10T12:00:00.000Z",
      isArchived: false,
    });
    expect(calls).toEqual([{ organizationId: subject.organizationId, userId: subject.userId, name: "Field work" }]);
  });
});
