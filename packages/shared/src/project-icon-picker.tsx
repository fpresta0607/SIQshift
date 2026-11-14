import { useId, useState, type CSSProperties } from "react";

import { PROJECT_COLOR_NAMES, PROJECT_COLORS, PROJECT_ICONS, type ProjectAppearance } from "./project-appearance.js";
import { ProjectGlyph } from "./project-glyph.js";
import { ProjectIconTile } from "./project-icon-tile.js";

const iconLabel = (icon: string): string => `${icon.charAt(0).toUpperCase()}${icon.slice(1)}`;

/**
 * Picks a project's icon and color from the built-in sets. Any member may,
 * and the pick is the whole team's, so the picker says so. It holds the draft
 * itself and hands the pair over on Save.
 */
export const ProjectIconPicker = ({
  projectName,
  appearance,
  isBusy,
  onSave,
  onCancel,
}: {
  projectName: string;
  appearance: ProjectAppearance;
  isBusy: boolean;
  onSave: (appearance: ProjectAppearance) => void;
  onCancel: () => void;
}) => {
  const iconLabelId = useId();
  const colorLabelId = useId();
  const [icon, setIcon] = useState(appearance.icon);
  const [color, setColor] = useState(appearance.color);
  return (
    <form
      className="icon-picker"
      aria-label={`Icon for ${projectName}`}
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ icon, color });
      }}
    >
      <div className="icon-picker-head">
        <ProjectIconTile appearance={{ icon, color }} />
        <div>
          <strong>{projectName}</strong>
          <p>Pick an icon and a color. The whole team sees it.</p>
        </div>
      </div>
      <p className="icon-picker-label" id={iconLabelId}>Icon</p>
      <div className="icon-grid" role="group" aria-labelledby={iconLabelId}>
        {PROJECT_ICONS.map((choice) => (
          <button
            key={choice}
            type="button"
            className="icon-choice"
            aria-label={iconLabel(choice)}
            aria-pressed={choice === icon}
            onClick={() => setIcon(choice)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><ProjectGlyph icon={choice} /></svg>
          </button>
        ))}
      </div>
      <p className="icon-picker-label" id={colorLabelId}>Color</p>
      <div className="color-row" role="group" aria-labelledby={colorLabelId}>
        {PROJECT_COLORS.map((choice) => (
          <button
            key={choice}
            type="button"
            className="color-choice"
            aria-label={PROJECT_COLOR_NAMES[choice]}
            aria-pressed={choice === color}
            style={{ "--swatch": choice } as CSSProperties}
            onClick={() => setColor(choice)}
          />
        ))}
      </div>
      <div className="icon-picker-foot">
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary" disabled={isBusy}>Save</button>
      </div>
    </form>
  );
};
