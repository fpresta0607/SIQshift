const APP_TONES = ["slate", "sky", "amber", "rose"] as const;

/** The same app gets the same tone wherever it is listed. */
const toneOf = (label: string): string => {
  let total = 0;
  for (const character of label) total += character.charCodeAt(0);
  return APP_TONES[total % APP_TONES.length] ?? APP_TONES[0];
};

/**
 * An app's mark: the OS icon when the host could read one, else the app's
 * initial on a square outlined tile. People are round and projects are solid
 * glyph tiles, so an app reads as an app beside either. The name always sits
 * beside it, so the mark is decoration to a screen reader.
 */
export const AppMark = ({ label, iconUrl }: { label: string; iconUrl?: string | undefined }) => (
  iconUrl === undefined
    ? <span className="app-mark app-letter" data-tone={toneOf(label)} aria-hidden="true">{label.charAt(0).toUpperCase()}</span>
    : <img className="app-mark" src={iconUrl} alt="" />
);
