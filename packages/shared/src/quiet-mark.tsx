/// The Quiet time row's mark. Quiet time is no app, so there is no OS icon to
/// load for it; a drawn moon stands in, in the same box an app icon fills.
export const QuietMark = () => (
  <svg className="app-mark quiet-mark" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
    <path d="M12 4.3A6 6 0 1 0 14.64 11.55A4.5 4.5 0 0 1 12 4.3Z" fill="currentColor" />
  </svg>
);
