const AVATAR_TONES = ["mint", "blue", "purple"] as const;

const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter((word) => word !== "")
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");

/** The same member gets the same tone on every list, whatever their rank on it. */
const toneOf = (id: string): string => {
  let total = 0;
  for (const character of id) total += character.charCodeAt(0);
  return AVATAR_TONES[total % AVATAR_TONES.length] ?? AVATAR_TONES[0];
};

/**
 * A member's mark on the team view: their picture, or their initials on a soft
 * tone until they add one or while it loads. The name always sits beside it,
 * so the picture is decoration to a screen reader.
 */
export const MemberAvatar = ({ id, name, picture }: { id: string; name: string; picture?: string | undefined }) => (
  picture === undefined
    ? <span className={`member-avatar ${toneOf(id)}`} aria-hidden="true">{initialsOf(name)}</span>
    : <img className="member-avatar" src={picture} alt="" />
);
