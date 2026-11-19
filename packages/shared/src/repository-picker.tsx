import { useId } from "react";

import type { RepositoryChoice } from "./contracts.js";

/** The repositories whose name holds what was typed, ignoring case; all of them before anything is typed. */
export const filterRepositoryChoices = (repositories: readonly RepositoryChoice[], query: string): RepositoryChoice[] => {
  const wanted = query.trim().toLowerCase();
  return wanted === "" ? [...repositories] : repositories.filter((repository) => repository.name.toLowerCase().includes(wanted));
};

/** Where a repository lives, as its owner reads it: the remote when it has one, else its folder. */
const repositoryPlace = (repository: RepositoryChoice): string => repository.remote ?? repository.repoRoot;

/**
 * The part of both apps' New project box that ties the project to a
 * repository. It lists the caller's own repositories no folder link claims
 * yet, filtered by the name being typed, and once one is picked it says what
 * the link does and offers to drop it. With no repositories it draws nothing,
 * so the box is the plain name field it always was.
 */
export const RepositoryPicker = ({
  repositories,
  query,
  picked,
  isBusy,
  onPick,
}: {
  repositories: readonly RepositoryChoice[];
  /** The name typed so far, which is also the filter. */
  query: string;
  picked: RepositoryChoice | null;
  isBusy: boolean;
  onPick: (repository: RepositoryChoice | null) => void;
}) => {
  const labelId = useId();
  if (picked !== null) {
    return (
      <div className="repo-pick is-picked" data-testid="repo-pick">
        <p className="repo-pick-linked">
          <span>Linked to <strong>{picked.name}</strong></span>
          <span className="repo-pick-where">{repositoryPlace(picked)}</span>
        </p>
        <p className="repo-pick-note">Agent time in this repository lands on the new project from now on.</p>
        <button className="repo-pick-clear" type="button" disabled={isBusy} onClick={() => onPick(null)}>Do not link a repository</button>
      </div>
    );
  }
  if (repositories.length === 0) return null;
  const matches = filterRepositoryChoices(repositories, query);
  return (
    <div className="repo-pick" data-testid="repo-pick">
      <p className="repo-pick-label" id={labelId}>Or pick a repository your agents worked in</p>
      {matches.length === 0 ? (
        <p className="repo-pick-note">No repository has that name, so this makes a plain project.</p>
      ) : (
        <ul className="repo-pick-list" aria-labelledby={labelId}>
          {matches.map((repository) => (
            <li key={repository.repoKey}>
              <button className="repo-pick-choice" type="button" disabled={isBusy} onClick={() => onPick(repository)}>
                <span className="repo-pick-name">{repository.name}</span>
                <span className="repo-pick-where">{repositoryPlace(repository)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
