import { PermissionsList, type PermissionsListProps } from "./PermissionsList.js";

type PermissionsCardProps = PermissionsListProps & {
  error: string | undefined;
};

/**
 * The main screen's macOS permission card. It stays up while any grant is
 * missing or still unasked, so a missing permission is never silent, and it
 * says what keeps recording regardless. Once every grant is settled it steps
 * aside; the "what's recorded" panel keeps listing them. Other platforms
 * report no permissions, so the card never appears there.
 */
export const PermissionsCard = ({ error, ...listProps }: PermissionsCardProps) => {
  const needsAttention = listProps.permissions.some(
    (permission) => permission.state === "missing" || permission.state === "not-asked",
  );
  if (!needsAttention) return null;
  return (
    <section className="card permissions-card" aria-labelledby="permissions-title" data-testid="permissions-card">
      <div className="panel-head">
        <h2 id="permissions-title">macOS permissions</h2>
      </div>
      <p className="subtle permissions-note">
        The app in front of you and when you were last active are recorded without any permission. SIQshift never asks
        for Screen Recording, Accessibility, Input Monitoring, or your microphone.
      </p>
      <PermissionsList {...listProps} />
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
};
