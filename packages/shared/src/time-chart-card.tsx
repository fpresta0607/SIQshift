import { useId, useState } from "react";

import { SegmentedControl } from "./segmented-control.js";
import { HourlyGraph, type ChartHourlyBucket, type TimeMeasure } from "./ui.js";

const MEASURE_OPTIONS = [
  { value: "both", label: "Both" },
  { value: "active", label: "Active time" },
  { value: "agent", label: "Agent time" },
] as const;

/**
 * The team view's chart of time: active time and agent time by the hour, in a
 * card of its own on the Humans page and inside a person's card under it. Its
 * one toggle picks what the chart shows, both lines or either one alone.
 * Nothing to plot, such as an all-time range, draws no card at all.
 */
export const TimeChartCard = ({
  buckets,
  isFramed = true,
}: {
  buckets: readonly ChartHourlyBucket[];
  /** False inside another card, which already draws the frame. */
  isFramed?: boolean;
}) => {
  const titleId = useId();
  const [measure, setMeasure] = useState<TimeMeasure>("both");
  if (buckets.length === 0) return null;
  return (
    <section className={isFramed ? "tv-card tv-chart" : "tv-chart"} aria-labelledby={titleId}>
      <div className="tv-card-head">
        <h4 id={titleId}>Over time</h4>
        <SegmentedControl label="What the chart shows" options={MEASURE_OPTIONS} value={measure} onChange={setMeasure} />
      </div>
      <HourlyGraph buckets={buckets} measure={measure} />
      <p className="tv-card-foot">Each point is one hour.</p>
    </section>
  );
};
