import { describe, expect, it } from "vitest";

import { AppError } from "../errors.js";
import type { AgentRecord, PathMappingRecord } from "../repositories.js";
import { resolveProjectForCwd, resolveProjectForRemote } from "./attribution.js";
import { listRepositoryChoices, repositoryFolderLink, type RepositoryChoiceSources } from "./project-repositories.js";

const ORGANIZATION = "0e59dfd6-3d1f-4795-9420-3ab65f0df843";
const MEMBER = "e1c7e513-b094-4d4c-ae55-21790ae019a4";
const TEAMMATE = "e3c7e513-b094-4d4c-ae55-21790ae019a4";
const PROJECT = "a1c7e513-b094-4d4c-ae55-21790ae019a4";
const member = { organizationId: ORGANIZATION, userId: MEMBER, role: "member" as const };
const admin = { ...member, role: "admin" as const };

let agentCount = 0;
function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  agentCount += 1;
  return {
    id: `b${String(agentCount).padStart(7, "0")}-b094-4d4c-ae55-21790ae019a4`,
    organizationId: ORGANIZATION,
    name: "Claude Code @ clock-in",
    source: "claude_code",
    status: "registered",
    owner: { id: MEMBER, name: "Alex" },
    project: null,
    repoRoot: "C:/dev/clock-in",
    repoKey: "github.com/acme/clock-in",
    createdAt: new Date("2026-08-10T12:00:00.000Z"),
    ...overrides,
  };
}

function folderLink(overrides: Partial<PathMappingRecord> = {}): PathMappingRecord {
  return {
    id: "c1c7e513-b094-4d4c-ae55-21790ae019a4",
    organizationId: ORGANIZATION,
    userId: MEMBER,
    kind: "path_prefix",
    pathPrefix: "C:/dev/elsewhere",
    repoUrl: null,
    projectId: PROJECT,
    ...overrides,
  };
}

function sources(agents: AgentRecord[], mappings: PathMappingRecord[] = []): RepositoryChoiceSources {
  return {
    agents: { listForOrganization: async () => agents },
    pathMappings: { listForSubject: async () => mappings },
  };
}

async function refusal(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  if (!(error instanceof AppError)) throw new Error(`expected an AppError, got ${String(error)}`);
  return error;
}

describe("repository choices for a new project", () => {
  it("lists the member's own repositories by name, one entry for every runtime that worked one", async () => {
    // Arrange
    const agents = [
      agent({ repoKey: "github.com/acme/web-shop", repoRoot: "C:/dev/web-shop" }),
      agent({ source: "codex", repoRoot: null, createdAt: new Date("2026-08-09T12:00:00.000Z") }),
      agent({ createdAt: new Date("2026-08-10T12:00:00.000Z") }),
      agent({ source: "codex", repoKey: "path:D:/work/Api-Notes", repoRoot: "D:/work/Api-Notes" }),
    ];

    // Act
    const choices = await listRepositoryChoices(sources(agents), member);

    // Assert
    expect(choices).toEqual([
      { repoKey: "path:D:/work/Api-Notes", name: "Api-Notes", remote: null, repoRoot: "D:/work/Api-Notes" },
      { repoKey: "github.com/acme/clock-in", name: "clock-in", remote: "github.com/acme/clock-in", repoRoot: "C:/dev/clock-in" },
      { repoKey: "github.com/acme/web-shop", name: "web-shop", remote: "github.com/acme/web-shop", repoRoot: "C:/dev/web-shop" },
    ]);
  });

  it.each([
    ["a teammate's agent, to a member", member, agent({ owner: { id: TEAMMATE, name: "Sam" } })],
    ["a teammate's agent, even to an admin", admin, agent({ owner: { id: TEAMMATE, name: "Sam" } })],
    ["a retired agent", member, agent({ status: "retired" })],
    ["the unassigned bucket", member, agent({ repoKey: null, repoRoot: null })],
    ["a remote with no recorded root", member, agent({ repoRoot: null })],
    ["a local repository in the home folder", member, agent({ repoKey: "path:C:/Users/alex", repoRoot: "C:/Users/alex" })],
    ["a local repository in the temp tree", member, agent({ repoKey: "path:/tmp/fixture-repo", repoRoot: "/tmp/fixture-repo" })],
    ["a root longer than a folder link holds", member, agent({ repoRoot: `C:/dev/${"a".repeat(500)}` })],
  ])("does not offer %s", async (_case, subject, record) => {
    await expect(listRepositoryChoices(sources([record]), subject)).resolves.toEqual([]);
  });

  it.each([
    ["the repository's own folder", folderLink({ pathPrefix: "c:\\dev\\clock-in\\" })],
    ["a folder above it", folderLink({ pathPrefix: "C:/dev" })],
    ["its remote, spelled another way", folderLink({ repoUrl: "git@github.com:Acme/clock-in.git" })],
  ])("leaves out a repository a folder link already claims through %s", async (_case, mapping) => {
    await expect(listRepositoryChoices(sources([agent()], [mapping]), member)).resolves.toEqual([]);
  });

  it.each([
    ["a sibling folder sharing its name's start", folderLink({ pathPrefix: "C:/dev/clock-in-extra" })],
    ["a browser rule", folderLink({ kind: "url_rule", pathPrefix: "github.com/acme/*" })],
    ["another repository's remote", folderLink({ repoUrl: "https://github.com/acme/web-shop" })],
  ])("still offers a repository next to %s", async (_case, mapping) => {
    const choices = await listRepositoryChoices(sources([agent()], [mapping]), member);
    expect(choices.map((choice) => choice.repoKey)).toEqual(["github.com/acme/clock-in"]);
  });

  it("is empty for a member whose agents worked nowhere", async () => {
    await expect(listRepositoryChoices(sources([]), member)).resolves.toEqual([]);
  });
});

describe("the folder link a picked repository creates", () => {
  it("names the repository's root and a remote that attribution reads back to the same repository", async () => {
    // Arrange
    const link = await repositoryFolderLink(sources([agent()]), member, "github.com/acme/clock-in");
    const mapping = { id: "m", kind: "path_prefix" as const, projectId: PROJECT, ...link };

    // Act
    const fromWorktree = resolveProjectForRemote("git@github.com:acme/clock-in.git", [mapping]);
    const fromCheckout = resolveProjectForCwd("C:/dev/clock-in/src", [mapping]);

    // Assert
    expect(link).toEqual({ pathPrefix: "C:/dev/clock-in", repoUrl: "https://github.com/acme/clock-in" });
    expect(fromWorktree).toBe(PROJECT);
    expect(fromCheckout).toBe(PROJECT);
  });

  it("carries no remote for a local-only repository", async () => {
    const local = agent({ repoKey: "path:D:/work/notes", repoRoot: "D:/work/notes" });
    await expect(repositoryFolderLink(sources([local]), member, "path:D:/work/notes"))
      .resolves.toEqual({ pathPrefix: "D:/work/notes", repoUrl: null });
  });

  it("refuses a repository only a teammate's agents worked in", async () => {
    const theirs = agent({ owner: { id: TEAMMATE, name: "Sam" } });
    const error = await refusal(repositoryFolderLink(sources([theirs]), admin, "github.com/acme/clock-in"));
    expect(error.code).toBe("not_found");
  });

  it("refuses a repository a folder link claimed since the box opened", async () => {
    const error = await refusal(repositoryFolderLink(sources([agent()], [folderLink({ pathPrefix: "C:/dev/clock-in" })]), member, "github.com/acme/clock-in"));
    expect(error.code).toBe("conflict");
  });
});
