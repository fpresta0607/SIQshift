import { useId } from "react";

import { HourlyGraph, type ChartHourlyBucket } from "./ui.js";

/**
 * The team view's chart of time: active time and agent time by the hour, in a
 * card of its own on the Humans page and inside a person's card under it.
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
  if (buckets.length === 0) return null;
  return (
    <section className={isFramed ? "tv-card tv-chart" : "tv-chart"} aria-labelledby={titleId}>
      <div className="tv-card-head">
        <h4 id={titleId}>Over time</h4>
      </div>
      <HourlyGraph buckets={buckets} personLabel="Active time" />
      <p className="tv-card-foot">Each point is one hour.</p>
    </section>
  );
};
