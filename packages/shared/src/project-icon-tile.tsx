import { type ProjectAppearance } from "./project-appearance.js";
import { ProjectGlyph } from "./project-glyph.js";

/**
 * A project's icon: its glyph in dark ink on a tile of its color. Its name
 * always sits beside it, so the tile is decoration to a screen reader. Each
 * place that draws one sizes it.
 */
export const ProjectIconTile = ({ appearance }: { appearance: ProjectAppearance }) => (
  <svg className="project-icon" viewBox="0 0 32 32" data-icon={appearance.icon} aria-hidden="true">
    <rect width="32" height="32" rx="9" fill={appearance.color} />
    <g
      transform="translate(4 4)"
      fill="none"
      stroke="var(--project-icon-ink)"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <ProjectGlyph icon={appearance.icon} />
    </g>
  </svg>
);
