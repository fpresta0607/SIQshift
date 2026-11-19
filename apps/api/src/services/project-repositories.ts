import type { RepositoryChoice } from "@siqshift/shared";

import type { AuthenticatedSubject } from "../auth.js";
import { AppError } from "../errors.js";
import type { AgentRepository, PathMappingRepository } from "../repositories.js";
import { isHomeOrTempDirectory, repoKeyPath, resolveProjectForCwd, resolveProjectForRemote, shiftCodebaseLabel } from "./attribution.js";

export interface RepositoryChoiceSources {
  agents: Pick<AgentRepository, "listForOrganization">;
  pathMappings: Pick<PathMappingRepository, "listForSubject">;
}

/** The folder link a project is created with: the repository's root, and its remote when it has one. */
export interface RepositoryFolderLink {
  pathPrefix: string;
  repoUrl: string | null;
}

interface OwnRepository {
  choice: RepositoryChoice;
  isClaimed: boolean;
}

/**
 * A remote key (`github.com/owner/repo`) as a URL `normalizeRemote` reads
 * back to the same key, which is all a mapping's `repo_url` is ever used for.
 */
function remoteUrl(remote: string): string {
  return `https://${remote}`;
}

function isUsableRoot(root: string | null): root is string {
  // A folder link's prefix holds 500 characters and a root up to 1000.
  return root !== null && root.length <= 500 && !isHomeOrTempDirectory(root);
}

function compareChoices(left: RepositoryChoice, right: RepositoryChoice): number {
  const byName = left.name.toLowerCase().localeCompare(right.name.toLowerCase());
  if (byName !== 0) return byName;
  if (left.repoKey === right.repoKey) return 0;
  return left.repoKey < right.repoKey ? -1 : 1;
}

/**
 * Every repository the caller's own agents worked in, one entry per identity
 * key, each marked by whether one of the caller's folder links already
 * claims it. Only the caller's agents are read, whatever the caller's role:
 * an admin may read a teammate's repo root on the roster, but a project is
 * one person's folder link, and the box offers only what that person worked.
 *
 * A link claims a repository when attribution would already place it there:
 * its path prefix reaches the repository's root, or its remote names the
 * repository's. Mappings are per person, and attribution reads only the
 * uploader's own, so a teammate's link never claims this person's work.
 *
 * A repository needs a root to be offered, because a folder link needs a
 * prefix. A root in the home folder or the temp tree is not offered whatever
 * the key, because a link there would claim every unmapped folder below it.
 */
async function ownRepositories(sources: RepositoryChoiceSources, subject: AuthenticatedSubject): Promise<OwnRepository[]> {
  const [agents, mappings] = await Promise.all([
    sources.agents.listForOrganization(subject),
    sources.pathMappings.listForSubject(subject),
  ]);
  const folderLinks = mappings.filter((mapping) => mapping.kind === "path_prefix");
  const byKey = new Map<string, OwnRepository>();
  const oldestFirst = agents
    .filter((agent) => agent.owner.id === subject.userId && agent.status !== "retired")
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  for (const agent of oldestFirst) {
    const repoKey = agent.repoKey;
    if (repoKey === null || byKey.has(repoKey)) continue;
    const name = shiftCodebaseLabel(null, repoKey);
    const localRoot = repoKeyPath(repoKey);
    const remote = localRoot === null ? repoKey : null;
    // Several runtimes on one repository are several agents; the oldest one
    // that recorded a usable root names it, so the choice is stable between reads.
    const repoRoot = localRoot ?? oldestFirst.find((candidate) => candidate.repoKey === repoKey && isUsableRoot(candidate.repoRoot))?.repoRoot ?? null;
    if (name === null || !isUsableRoot(repoRoot)) continue;
    const isClaimed = folderLinks.some((link) =>
      resolveProjectForCwd(repoRoot, [link]) !== null
      || (remote !== null && resolveProjectForRemote(remoteUrl(remote), [link]) !== null));
    byKey.set(repoKey, { choice: { repoKey, name, remote, repoRoot }, isClaimed });
  }
  return [...byKey.values()];
}

/** The caller's own repositories that no folder link of theirs claims yet, by name. */
export async function listRepositoryChoices(sources: RepositoryChoiceSources, subject: AuthenticatedSubject): Promise<RepositoryChoice[]> {
  return (await ownRepositories(sources, subject))
    .filter((repository) => !repository.isClaimed)
    .map((repository) => repository.choice)
    .sort(compareChoices);
}

/**
 * The folder link for one of the caller's unclaimed repositories. The key is
 * looked up again rather than trusted, so a key from another person's roster,
 * or one a link claimed since the box was opened, is refused.
 */
export async function repositoryFolderLink(
  sources: RepositoryChoiceSources,
  subject: AuthenticatedSubject,
  repoKey: string,
): Promise<RepositoryFolderLink> {
  const repository = (await ownRepositories(sources, subject)).find((candidate) => candidate.choice.repoKey === repoKey);
  if (repository === undefined) throw new AppError("not_found", "That repository is not one your agents worked in.");
  if (repository.isClaimed) throw new AppError("conflict", "Another project already has that repository.");
  const { repoRoot, remote } = repository.choice;
  return { pathPrefix: repoRoot, repoUrl: remote === null ? null : remoteUrl(remote) };
}
