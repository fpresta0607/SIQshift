import {
  projectCreateRequestSchema,
  projectDeleteRequestSchema,
  projectListItemSchema,
  projectListResponseSchema,
  projectUpdateRequestSchema,
  projectUsageResponseSchema,
  repositoryChoiceListResponseSchema,
} from "@siqshift/shared";
import { Hono } from "hono";

import { getAuthenticatedSubject, type ApiEnvironment } from "../app.js";
import { AppError } from "../errors.js";
import type { ProjectRepository } from "../repositories.js";
import { listRepositoryChoices, repositoryFolderLink, type RepositoryChoiceSources } from "../services/project-repositories.js";
import { createProject, deleteProject, listProjects, projectUsage, updateProject } from "../services/projects.js";

async function requestBody(context: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    throw new AppError("validation_error", "Invalid request body.");
  }
}

/**
 * `repositories` is what the New project box offers; without it the box lists
 * nothing and a create naming a repository is refused, as no repository can
 * be the caller's.
 */
export function createProjectRoutes(repository: ProjectRepository, repositories?: RepositoryChoiceSources): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  // `?includeArchived=true` still lists archived projects so an archive can be
  // undone through the API; the dashboard's management surface no longer asks
  // for it, and pickers never offer an archived project.
  routes.get("/", async (context) => context.json(projectListResponseSchema.parse(
    await listProjects(repository, getAuthenticatedSubject(context), context.req.query("includeArchived") === "true"),
  )));
  routes.get("/repositories", async (context) => context.json(repositoryChoiceListResponseSchema.parse({
    repositories: repositories === undefined ? [] : await listRepositoryChoices(repositories, getAuthenticatedSubject(context)),
  })));
  routes.post("/", async (context) => {
    const input = projectCreateRequestSchema.safeParse(await requestBody(context));
    if (!input.success) throw new AppError("validation_error", "Invalid request body.");
    const subject = getAuthenticatedSubject(context);
    const { name, repoKey } = input.data;
    if (repoKey !== undefined && repositories === undefined) {
      throw new AppError("not_found", "That repository is not one your agents worked in.");
    }
    const folderLink = repoKey === undefined || repositories === undefined
      ? undefined
      : await repositoryFolderLink(repositories, subject, repoKey);
    const created = await createProject(repository, subject, name, folderLink);
    return context.json(projectListItemSchema.parse(created), 201);
  });
  routes.patch("/:id", async (context) => {
    const input = projectUpdateRequestSchema.safeParse(await requestBody(context));
    if (!input.success) throw new AppError("validation_error", "Invalid request body.");
    const updated = await updateProject(repository, getAuthenticatedSubject(context), context.req.param("id"), input.data);
    return context.json(projectListItemSchema.parse(updated));
  });
  routes.get("/:id/usage", async (context) => context.json(projectUsageResponseSchema.parse(
    await projectUsage(repository, getAuthenticatedSubject(context), context.req.param("id")),
  )));
  routes.delete("/:id", async (context) => {
    const input = projectDeleteRequestSchema.safeParse(await requestBody(context));
    if (!input.success) throw new AppError("validation_error", "Invalid request body.");
    await deleteProject(repository, getAuthenticatedSubject(context), context.req.param("id"), input.data.reassignTo);
    return context.body(null, 204);
  });
  return routes;
}
