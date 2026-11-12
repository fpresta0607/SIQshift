import type { PermissionId, PermissionState, PermissionStatus } from "./bridge.js";

type PermissionCopy = {
  title: string;
  /// What goes unrecorded while the grant is missing.
  withoutIt: string;
  /// The button that opens the System Settings pane holding the grant.
  settingsLabel: string;
};

const COPY: Record<PermissionId, PermissionCopy> = {
  "login-item": {
    title: "Start at login",
    withoutIt: "SIQshift won't start when you log in, so nothing is recorded until you open it.",
    settingsLabel: "Open Login Items",
  },
  "protected-folders": {
    title: "Documents, Desktop and Downloads",
    withoutIt: "Commits in code repositories kept in these folders aren't linked to your shifts.",
    settingsLabel: "Open Files and Folders",
  },
};

const STATE_LABEL: Record<PermissionState, string> = {
  granted: "Allowed",
  missing: "Not allowed",
  "not-asked": "Not asked yet",
  declined: "Not needed",
};

export type PermissionsListProps = {
  permissions: readonly PermissionStatus[];
  /// The permission whose prompt or answer is in flight; its buttons wait.
  busy: PermissionId | undefined;
  onAsk: (id: PermissionId) => void;
  onDecline: (id: PermissionId) => void;
  onOpenSettings: (id: PermissionId) => void;
};

/**
 * One row per macOS grant: whether it is in place, what goes unrecorded
 * without it, and the button that fixes it. The folders cannot be granted
 * from System Settings before SIQshift has asked (the pane lists only apps
 * that asked), so until then the row offers the ask instead.
 */
export const PermissionsList = ({ permissions, busy, onAsk, onDecline, onOpenSettings }: PermissionsListProps) => (
  <ul className="permission-list">
    {permissions.map((permission) => {
      const copy = COPY[permission.id];
      const isBusy = busy === permission.id;
      const isUnasked = permission.state === "not-asked" || permission.state === "declined";
      return (
        <li key={permission.id} className={`permission-row is-${permission.state}`} data-testid={`permission-${permission.id}`}>
          <div className="permission-head">
            <span className="permission-title">{copy.title}</span>
            <span className="permission-state">{STATE_LABEL[permission.state]}</span>
          </div>
          {(permission.state === "missing" || permission.state === "not-asked") && (
            <p className="permission-impact">{copy.withoutIt}</p>
          )}
          <div className="permission-actions">
            {isUnasked ? (
              <button className="outline-button" type="button" disabled={isBusy} onClick={() => onAsk(permission.id)}>
                {isBusy ? "Waiting for macOS…" : "Ask now"}
              </button>
            ) : (
              <button className="outline-button" type="button" onClick={() => onOpenSettings(permission.id)}>
                {copy.settingsLabel}
              </button>
            )}
            {permission.state === "not-asked" && (
              <button className="link-button permission-decline" type="button" disabled={isBusy} onClick={() => onDecline(permission.id)}>
                My code isn&apos;t kept there
              </button>
            )}
          </div>
        </li>
      );
    })}
  </ul>
);
