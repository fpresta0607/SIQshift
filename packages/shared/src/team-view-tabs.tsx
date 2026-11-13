import { SegmentedControl } from "./segmented-control.js";

export type TeamViewTab = "humans" | "agents";

const PERSON_ICON = (
  <svg className="seg-icon" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="8" r="3.6" />
    <path d="M4.8 20c.9-3.9 3.7-5.8 7.2-5.8s6.3 1.9 7.2 5.8" />
  </svg>
);

const SPARK_ICON = (
  <svg className="seg-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 3.5v5M12 15.5v5M3.5 12h5M15.5 12h5M6 6l3.3 3.3M14.7 14.7 18 18M18 6l-3.3 3.3M9.3 14.7 6 18" />
  </svg>
);

const TAB_OPTIONS = [
  { value: "humans", label: "Humans", icon: PERSON_ICON },
  { value: "agents", label: "Agents", icon: SPARK_ICON },
] as const;

/** The team view's page switch, the largest control in its head. */
export const TeamViewTabs = ({ value, onChange }: { value: TeamViewTab; onChange: (tab: TeamViewTab) => void }) => (
  <SegmentedControl label="Humans or agents" options={TAB_OPTIONS} value={value} onChange={onChange} isPrimary />
);
