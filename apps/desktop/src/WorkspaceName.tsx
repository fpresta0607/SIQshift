import { useState } from "react";

type WorkspaceNameProps = {
  name: string;
  /// Resolves to the sentence to show when the rename did not land, or
  /// undefined once it did.
  onRename: (name: string) => Promise<string | undefined>;
};

/// The workspace's name in the Team group, with the control that changes it.
/// Rename is offered to every member: whether this one may is the server's
/// call, and its refusal is shown in its own words under the row.
export const WorkspaceName = ({ name, onRename }: WorkspaceNameProps) => {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();

  const startEditing = (): void => {
    setDraft(name);
    setFailure(undefined);
    setIsEditing(true);
  };

  const cancel = (): void => {
    setFailure(undefined);
    setIsEditing(false);
  };

  const save = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmed = draft.trim();
    if (isSaving || trimmed === "") return;
    setIsSaving(true);
    setFailure(undefined);
    const refusal = await onRename(trimmed);
    setIsSaving(false);
    setFailure(refusal);
    if (refusal === undefined) setIsEditing(false);
  };

  if (!isEditing) {
    return (
      <div className="team-code-row">
        <strong className="workspace-name">{name}</strong>
        {/* The Projects group has Rename buttons of its own, so this one
            names what it renames for anyone not looking at the row. */}
        <button className="outline-button" type="button" onClick={startEditing}>
          Rename<span className="visually-hidden"> the workspace</span>
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={(event) => void save(event)}>
      <div className="team-code-row">
        <label className="team-join-label">
          <span className="visually-hidden">New name for the workspace</span>
          <input value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={80} autoComplete="off" autoFocus required />
        </label>
        <button className="signal-button" type="submit" disabled={isSaving || draft.trim() === ""}>
          {isSaving ? "Saving…" : "Save"}
        </button>
        <button className="outline-button" type="button" disabled={isSaving} onClick={cancel}>Cancel</button>
      </div>
      {failure && <p className="form-error" role="alert">{failure}</p>}
    </form>
  );
};
