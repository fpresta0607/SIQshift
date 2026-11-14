/**
 * The built-in icons and colors a project can wear. A project stores one name
 * from each list, and one that stores none is given a pair from its id, so
 * every member sees the same icon without anything being written for it.
 */
export const PROJECT_ICONS = [
  "grid",
  "compass",
  "bolt",
  "globe",
  "rocket",
  "flask",
  "book",
  "briefcase",
  "chart",
  "code",
  "cube",
  "flag",
  "heart",
  "home",
  "leaf",
  "pin",
  "pen",
  "shield",
  "star",
  "terminal",
  "layers",
  "music",
  "camera",
  "cart",
] as const;

export type ProjectIcon = (typeof PROJECT_ICONS)[number];

export const PROJECT_COLORS = [
  "#62e4ba",
  "#85c6ff",
  "#c6a1f4",
  "#f5c26b",
  "#ff9d8a",
  "#f49ac1",
  "#5fd4e0",
  "#a3b3c2",
] as const;

export type ProjectColor = (typeof PROJECT_COLORS)[number];

export const PROJECT_COLOR_NAMES: Readonly<Record<ProjectColor, string>> = {
  "#62e4ba": "Mint",
  "#85c6ff": "Sky",
  "#c6a1f4": "Violet",
  "#f5c26b": "Amber",
  "#ff9d8a": "Coral",
  "#f49ac1": "Pink",
  "#5fd4e0": "Teal",
  "#a3b3c2": "Slate",
};

export type ProjectAppearance = { icon: ProjectIcon; color: ProjectColor };

/** The default project's own pair, which no other project is given unasked. */
export const DEFAULT_PROJECT_APPEARANCE: ProjectAppearance = { icon: "grid", color: "#a3b3c2" };

const ASSIGNED_ICONS = PROJECT_ICONS.filter((icon) => icon !== DEFAULT_PROJECT_APPEARANCE.icon);
const ASSIGNED_COLORS = PROJECT_COLORS.filter((color) => color !== DEFAULT_PROJECT_APPEARANCE.color);

const isProjectIcon = (value: string | null | undefined): value is ProjectIcon =>
  PROJECT_ICONS.some((icon) => icon === value);

const isProjectColor = (value: string | null | undefined): value is ProjectColor =>
  PROJECT_COLORS.some((color) => color === value);

/** FNV-1a over the id: the same project lands on the same pair on every server and every read. */
const hashOf = (text: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

/** The icon and color a project shows: what a member chose, or the pair its id assigns. */
export const projectAppearance = (project: {
  id: string;
  isDefault: boolean;
  icon: string | null | undefined;
  color: string | null | undefined;
}): ProjectAppearance => {
  const hash = hashOf(project.id);
  const assigned: ProjectAppearance = project.isDefault
    ? DEFAULT_PROJECT_APPEARANCE
    : {
      icon: ASSIGNED_ICONS[hash % ASSIGNED_ICONS.length] ?? DEFAULT_PROJECT_APPEARANCE.icon,
      color: ASSIGNED_COLORS[(hash >>> 8) % ASSIGNED_COLORS.length] ?? DEFAULT_PROJECT_APPEARANCE.color,
    };
  return {
    icon: isProjectIcon(project.icon) ? project.icon : assigned.icon,
    color: isProjectColor(project.color) ? project.color : assigned.color,
  };
};
