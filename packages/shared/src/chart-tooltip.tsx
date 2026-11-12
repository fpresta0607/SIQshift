/// The tooltip both charts share: the hovered or keyboard-focused moment, and
/// each series' value there. Positioned as a percentage of the plot width so
/// the SVG's viewBox scaling never desyncs it.
export const ChartTooltip = ({
  left,
  title,
  rows,
}: {
  left: number;
  title: string;
  rows: readonly { color: string; label: string; value: string }[];
}) => (
  <div className="graph-tooltip" style={{ left: `${left}%` }}>
    <p className="graph-tooltip-title">{title}</p>
    {rows.map((row) => (
      <p key={row.label} className="graph-tooltip-row">
        <span className="legend-line" style={{ background: row.color }} aria-hidden="true" />
        {row.label} {row.value}
      </p>
    ))}
  </div>
);
