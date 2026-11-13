import { type ReactNode } from "react";

export type SegmentedOption<Value extends string> = {
  value: Value;
  label: string;
  icon?: ReactNode;
};

/**
 * The team view's one control for an either-or choice: a row of buttons, the
 * picked one pressed. Every switch on the page is this control, so a reader
 * learns it once and no two controls on one card can disagree.
 */
export const SegmentedControl = <Value extends string>({
  label,
  options,
  value,
  onChange,
  isPrimary = false,
}: {
  label: string;
  options: readonly SegmentedOption<Value>[];
  value: Value;
  onChange: (value: Value) => void;
  isPrimary?: boolean;
}) => (
  <div className={isPrimary ? "seg is-primary" : "seg"} role="group" aria-label={label}>
    {options.map((option) => (
      <button key={option.value} type="button" aria-pressed={option.value === value} onClick={() => onChange(option.value)}>
        {option.icon}
        {option.label}
      </button>
    ))}
  </div>
);
