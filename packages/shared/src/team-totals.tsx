/** One tile of the totals row: what it counts, the figure, and a few words on the figure's unit. */
export type TeamTotal = {
  label: string;
  value: string;
  note: string;
  isAgent?: boolean;
  /** The exact figure behind a short one, read on hover. */
  title?: string;
};

/** The row of totals that opens each team view page, before anything is broken down. */
export const TeamTotals = ({ label, totals }: { label: string; totals: readonly TeamTotal[] }) => (
  <dl className="tv-totals" aria-label={label}>
    {totals.map((total) => (
      <div key={total.label} className={total.isAgent === true ? "tv-total is-agent" : "tv-total"} title={total.title}>
        <dt>{total.label}</dt>
        <dd>
          <b>{total.value}</b>
          <small>{total.note}</small>
        </dd>
      </div>
    ))}
  </dl>
);
