/**
 * Shown while macOS runs SIQshift from a temporary copy (App Translocation),
 * which it does for an app opened straight from its disk image or copied into
 * Applications by anything but the Finder. That copy is gone once the app
 * quits, so the app cannot start at login from it.
 */
export const MoveToApplicationsNotice = () => (
  <p className="translocation-notice" role="status" data-testid="move-to-applications">
    SIQshift is running from a temporary copy, so it won&apos;t start when you log in. Quit SIQshift, drag it into
    your Applications folder in Finder, and open it from there.
  </p>
);
