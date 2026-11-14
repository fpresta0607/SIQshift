import { type ReactNode } from "react";

import { PictureFileError, readPictureFile } from "./picture-file.js";
import { ProjectGlyph } from "./project-glyph.js";

/**
 * A member's own picture and the controls that change it: a file picker that
 * turns a JPEG, PNG or WebP into a small square, and Remove once there is one.
 * Whether there is a picture comes in apart from the picture itself, which
 * may still be loading.
 */
export const PictureField = ({
  picture,
  hasPicture,
  fallback,
  hint,
  isBusy,
  onPick,
  onRemove,
  onError,
}: {
  /** The picture as a data URL, undefined until there is one to draw. */
  picture: string | undefined;
  hasPicture: boolean;
  /** What stands in for a picture: the member's initials, or a camera before there is a member. */
  fallback?: ReactNode;
  hint?: string | undefined;
  isBusy: boolean;
  onPick: (bytes: Uint8Array<ArrayBuffer>) => void;
  onRemove: () => void;
  onError: (message: string) => void;
}) => (
  <div className="picture-field">
    {picture !== undefined
      ? <img className="member-avatar" src={picture} alt="" />
      : fallback ?? (
        <span className="picture-drop" aria-hidden="true">
          <svg viewBox="0 0 24 24"><ProjectGlyph icon="camera" /></svg>
        </span>
      )}
    <div>
      <div className="picture-field-actions">
        <label className="ghost picture-pick">
          {hasPicture ? "Change picture" : "Add a picture"}
          <input
            type="file"
            className="visually-hidden"
            accept="image/jpeg,image/png,image/webp"
            disabled={isBusy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              // Cleared so picking the same file again still reads it.
              event.currentTarget.value = "";
              if (file === undefined) return;
              void readPictureFile(file).then(onPick, (error: unknown) => {
                onError(error instanceof PictureFileError ? error.message : "That picture could not be read. Try another.");
              });
            }}
          />
        </label>
        {hasPicture && <button type="button" className="ghost" disabled={isBusy} onClick={onRemove}>Remove</button>}
      </div>
      {hint !== undefined && <p className="picture-field-hint">{hint}</p>}
    </div>
  </div>
);
