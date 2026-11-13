import { type ReactNode } from "react";

/**
 * The team view's one header row: the workspace's name, the range under it,
 * and the page's controls on the right. Both pages and the home page's example
 * draw it, so the line every reader starts from never changes between them.
 */
export const TeamViewHead = ({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  /** The controls: which page, which range, and closing it. */
  children?: ReactNode;
}) => (
  <header className="tv-head">
    <div className="tv-title">
      <h3>{title}</h3>
      <p>{subtitle}</p>
    </div>
    {children}
  </header>
);
