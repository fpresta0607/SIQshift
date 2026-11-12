import { useState } from "react";

interface WorkspaceNameProps {
  name: string;
  /** Renames the workspace; resolves to the reason when the rename did not happen. */
  onRename: (name: string) => Promise<string | undefined>;
}

/** The workspace's name at the head of the Team section, and the form that renames it. */
export const WorkspaceName = ({ name, onRename }: WorkspaceNameProps) => {
  const [draft, setDraft] = useState<string | undefined>();
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  if (draft === undefined) {
    return (
      <div className="team-code-row">
        <strong className="workspace-name">{name}</strong>
        <button className="ghost" type="button" onClick={() => { setDraft(name); setError(undefined); }}>
          Rename<span className="visually-hidden"> the workspace</span>
        </button>
      </div>
    );
  }

  const trimmed = draft.trim();
  return (
    <form
      className="workspace-rename"
      onSubmit={(event) => {
        event.preventDefault();
        if (isBusy || trimmed === "") return;
        setIsBusy(true);
        void onRename(trimmed).then((failure) => {
          setIsBusy(false);
          setError(failure);
          if (failure === undefined) setDraft(undefined);
        });
      }}
    >
      <label>
        <span className="visually-hidden">New name for the workspace</span>
        <input value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={80} required />
      </label>
      <button className="primary" type="submit" disabled={isBusy || trimmed === ""}>{isBusy ? "Saving…" : "Save"}</button>
      <button className="ghost" type="button" disabled={isBusy} onClick={() => setDraft(undefined)}>Cancel</button>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
};
