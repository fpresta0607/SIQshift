import { useState } from "react";

import { type ProjectAppearance } from "./project-appearance.js";
import { ProjectIconTile } from "./project-icon-tile.js";
import { SegmentedControl, type SegmentedOption } from "./segmented-control.js";

/// Calendar days on the viewer's own clock, both ends included, as a date input writes them.
export type DashboardDays = { from: string; to: string };

/// A project the filter can narrow to, with the first day it can have work on.
export type DashboardFilterProject = { id: string; name: string; appearance: ProjectAppearance; firstDay: string };

const CUSTOM = "custom";

/// The most days the reports read at once: they take up to 367 days of instants, and a daylight-saving hour must still fit.
const MAX_SPAN_DAYS = 366;

/// "All projects" wears four tiles where a project wears its one.
const ALL_PROJECTS_MARK = (
  <svg className="tv-all-projects" viewBox="0 0 24 24" aria-hidden="true">
    <g fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="3" width="7.5" height="7.5" rx="2" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="2" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="2" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2" />
    </g>
  </svg>
);

/// A date input's value for a local calendar day.
export const localDay = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/// The calendar day `offset` days from `day`.
const shiftedDay = (day: string, offset: number): string => {
  const [year, month, date] = day.split("-").map(Number);
  return localDay(new Date(year!, month! - 1, date! + offset));
};

const laterDay = (first: string, second: string): string => (first > second ? first : second);

/// A project's lifetime as custom days: from its first day to today, or its last `MAX_SPAN_DAYS` once it is older.
const lifetimeDays = (firstDay: string, today: string): DashboardDays =>
  ({ from: laterDay(firstDay, shiftedDay(today, 1 - MAX_SPAN_DAYS)), to: today });

/// A whole date with a four-digit year, as a date input writes one once every part of it is typed.
const WHOLE_DAY = /^[1-9]\d{3}-\d{2}-\d{2}$/;

/// Days the reports read: both whole, From on or before To, and at most `MAX_SPAN_DAYS` of them.
const isReadable = (days: DashboardDays): boolean =>
  WHOLE_DAY.test(days.from) && WHOLE_DAY.test(days.to) && days.from <= days.to && days.from >= shiftedDay(days.to, 1 - MAX_SPAN_DAYS);

/// What the page head calls custom days: "Custom", unless they are a project's lifetime cut to what the reports read.
export const customRangeName = (days: DashboardDays, firstDay: string | undefined): string => {
  if (firstDay === undefined) return "Custom";
  const lifetime = lifetimeDays(firstDay, localDay(new Date()));
  const isCutLifetime = lifetime.from !== firstDay && days.from === lifetime.from && days.to === lifetime.to;
  return isCutLifetime ? `Project's last ${MAX_SPAN_DAYS} days` : "Custom";
};

/**
 * Instant bounds for calendar days on the viewer's own clock: from the first
 * day's local midnight to the midnight after the last day. Calendar-date
 * params would be read as UTC days, which roll over mid-afternoon west of
 * Greenwich, so the page always sends instants.
 */
export const dayBounds = (days: DashboardDays): { fromAt: string; toExclusiveAt: string } => {
  const [fromYear, fromMonth, fromDay] = days.from.split("-").map(Number);
  const [toYear, toMonth, toDay] = days.to.split("-").map(Number);
  return {
    fromAt: new Date(fromYear!, fromMonth! - 1, fromDay!).toISOString(),
    toExclusiveAt: new Date(toYear!, toMonth! - 1, toDay! + 1).toISOString(),
  };
};

/**
 * The dashboard's one filter, drawn in its head: the range - a preset, or
 * custom days - and the project. Every card, the chart and the board read
 * under it, so there is one place to change what the page measures. A picked
 * project offers its whole lifetime as the custom days, from the day it was
 * created to today, and Custom opens on it. Each date input writes only its
 * own day, and the page reads the days only once they are ones the reports
 * read; until then it keeps the last such days and says what to pick.
 */
export const DashboardFilter = <Preset extends string>({
  presets,
  range,
  onRange,
  days,
  onDays,
  projects,
  project,
  onProject,
}: {
  presets: readonly SegmentedOption<Preset>[];
  /// A preset, or "custom" for `days`.
  range: Preset | typeof CUSTOM;
  onRange: (range: Preset | typeof CUSTOM) => void;
  days: DashboardDays;
  onDays: (days: DashboardDays) => void;
  /// Absent where the page has no projects to narrow to.
  projects?: readonly DashboardFilterProject[] | undefined;
  /// "all", or the id of the project the page reads.
  project: string;
  onProject: (project: string) => void;
}) => {
  const [isPickerOpen, setPickerOpen] = useState(false);
  const [draft, setDraft] = useState(days);
  const today = localDay(new Date());
  const picked = projects?.find((entry) => entry.id === project);
  const options: readonly SegmentedOption<Preset | typeof CUSTOM>[] = [...presets, { value: CUSTOM, label: "Custom" }];
  const lifetime = picked === undefined ? undefined : lifetimeDays(picked.firstDay, today);
  const isLifetime = lifetime !== undefined && range === CUSTOM && draft.from === lifetime.from && draft.to === lifetime.to;
  const choose = (next: DashboardDays): void => {
    setDraft(next);
    if (isReadable(next)) onDays(next);
  };

  return (
    <div className="tv-filter">
      <SegmentedControl
        label="Date range"
        options={options}
        value={range}
        onChange={(next) => {
          // Custom opens on the picked project's whole lifetime: the range a
          // project's own question is most often about.
          if (next === CUSTOM && range !== CUSTOM) choose(lifetime ?? days);
          onRange(next);
        }}
      />
      {projects !== undefined && (
        <div className="tv-project-filter">
          <button
            type="button"
            className="tv-project-button"
            aria-label={`Project: ${picked?.name ?? "All projects"}`}
            aria-expanded={isPickerOpen}
            onClick={() => setPickerOpen((open) => !open)}
          >
            {picked === undefined ? ALL_PROJECTS_MARK : <ProjectIconTile appearance={picked.appearance} />}
            <span>{picked?.name ?? "All projects"}</span>
          </button>
          {isPickerOpen && (
            <div className="tv-project-menu" role="radiogroup" aria-label="Project">
              {[undefined, ...projects].map((entry) => (
                <button
                  key={entry?.id ?? "all"}
                  type="button"
                  role="radio"
                  aria-checked={(entry?.id ?? "all") === project}
                  onClick={() => {
                    onProject(entry?.id ?? "all");
                    setPickerOpen(false);
                  }}
                >
                  {entry === undefined ? ALL_PROJECTS_MARK : <ProjectIconTile appearance={entry.appearance} />}
                  <span>{entry?.name ?? "All projects"}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {range === CUSTOM && (
        <div className="tv-days">
          <label>
            From
            <input
              type="date"
              value={draft.from}
              max={draft.to}
              onChange={(event) => choose({ from: event.target.value, to: draft.to })}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={draft.to}
              min={draft.from}
              max={today}
              onChange={(event) => choose({ from: draft.from, to: event.target.value })}
            />
          </label>
          {lifetime !== undefined && (
            <button
              type="button"
              className="ghost"
              aria-pressed={isLifetime}
              onClick={() => choose(lifetime)}
            >
              Project lifetime
            </button>
          )}
          {!isReadable(draft) && (
            <p className="tv-days-note" role="status">Pick a From day on or before To, at most {MAX_SPAN_DAYS} days in all.</p>
          )}
        </div>
      )}
    </div>
  );
};
