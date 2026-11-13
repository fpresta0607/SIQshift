//! The macOS grants recording depends on, read without ever prompting.
//!
//! The recorder itself needs no privacy grant on macOS: the app in front, the
//! time since the last input, and the lock and sleep broadcasts are all
//! readable without one (see `monitor/macos.rs`). Two grants still decide
//! what reaches the server:
//!
//! - The login item. macOS 13 and later let a person switch off an app's
//!   background item in System Settings; switched off, SIQshift does not start
//!   at login, and nothing is recorded until it is opened by hand.
//! - Files and folders. Documents, Desktop and Downloads are protected; without
//!   access SIQshift cannot read the git history of a repository kept there,
//!   so that repository's commits are not linked to shifts.
//!
//! Every other platform reports no permissions, and the main screen lists none.

use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::api::{ApiResult, BridgeError, ErrorKind};

/// The folders macOS guards behind a Files and Folders grant, in the home folder.
const PROTECTED_FOLDERS: [&str; 3] = ["Desktop", "Documents", "Downloads"];

/// `SMAppServiceStatusRequiresApproval`: registered, but switched off in
/// System Settings.
const LOGIN_ITEM_REQUIRES_APPROVAL: isize = 2;

/// The folders answer file's contents: SIQshift asked (so probing raises no
/// new prompt), or the person said the folders are not needed (so SIQshift
/// must never probe them).
const FOLDERS_ASKED: &[u8] = b"asked";
const FOLDERS_DECLINED: &[u8] = b"declined";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionId {
    LoginItem,
    ProtectedFolders,
}

impl PermissionId {
    pub fn from_id(id: &str) -> ApiResult<Self> {
        match id {
            "login-item" => Ok(Self::LoginItem),
            "protected-folders" => Ok(Self::ProtectedFolders),
            _ => Err(BridgeError::new(
                ErrorKind::Validation,
                "Unknown permission.",
            )),
        }
    }

    /// The System Settings pane that holds this grant.
    pub fn settings_url(self) -> &'static str {
        match self {
            Self::LoginItem => "x-apple.systempreferences:com.apple.LoginItems-Settings.extension",
            Self::ProtectedFolders => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders"
            }
        }
    }
}

/// `NotAsked` and `Declined` exist for the folders alone: macOS has no way to
/// learn whether access was granted without asking the person, so until
/// SIQshift has asked once it does not know, and a person whose code lives
/// elsewhere can say it is not needed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionState {
    Granted,
    Missing,
    NotAsked,
    Declined,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionStatus {
    pub id: PermissionId,
    pub state: PermissionState,
}

/// Where the grants are visible on disk, resolved by the caller.
pub struct PermissionPaths {
    /// The plist the autostart plugin writes to ~/Library/LaunchAgents.
    pub login_item_plist: PathBuf,
    /// The person's answer about the protected folders; absent until asked.
    pub folders_answer: PathBuf,
    /// The home folder the protected folders sit in.
    pub home: PathBuf,
}

/// Every grant's state, for the main screen. Never raises a prompt.
pub fn statuses(paths: &PermissionPaths) -> Vec<PermissionStatus> {
    if !cfg!(target_os = "macos") {
        return Vec::new();
    }
    vec![
        PermissionStatus {
            id: PermissionId::LoginItem,
            state: login_item_state(
                paths.login_item_plist.exists(),
                login_item_approval(&paths.login_item_plist),
            ),
        },
        PermissionStatus {
            id: PermissionId::ProtectedFolders,
            state: folders_state(paths),
        },
    ]
}

/// Asks for the protected folders, then reports every grant. Reading a folder
/// raises macOS's own prompt the first time, and only then, and blocks until
/// the person answers, so callers run this off the async runtime. The login
/// item has no prompt: its switch lives in System Settings.
pub fn request(paths: &PermissionPaths, id: PermissionId) -> ApiResult<Vec<PermissionStatus>> {
    if cfg!(target_os = "macos") && id == PermissionId::ProtectedFolders {
        for folder in protected_folders(&paths.home) {
            folder_is_accessible(&folder);
        }
        save_folders_answer(paths, FOLDERS_ASKED)?;
    }
    Ok(statuses(paths))
}

/// Records that the protected folders are not needed, so SIQshift stops
/// offering to ask; asking later is still possible. Only the folders can be
/// declined: the login item is what recording starts from.
pub fn decline(paths: &PermissionPaths, id: PermissionId) -> ApiResult<Vec<PermissionStatus>> {
    if id != PermissionId::ProtectedFolders {
        return Err(BridgeError::new(
            ErrorKind::Validation,
            "Only the folders permission can be skipped.",
        ));
    }
    if cfg!(target_os = "macos") {
        save_folders_answer(paths, FOLDERS_DECLINED)?;
    }
    Ok(statuses(paths))
}

fn save_folders_answer(paths: &PermissionPaths, answer: &[u8]) -> ApiResult<()> {
    std::fs::write(&paths.folders_answer, answer)
        .map_err(|_| BridgeError::unknown("SIQshift could not save your answer."))
}

/// The plist is what launchd starts SIQshift from; without it there is no
/// login start at all. With it, only an explicit "switched off" answer counts
/// as missing: before macOS 13 there was no switch, and any other answer
/// leaves launchd starting the app.
fn login_item_state(plist_exists: bool, approval: Option<isize>) -> PermissionState {
    match (plist_exists, approval) {
        (false, _) | (true, Some(LOGIN_ITEM_REQUIRES_APPROVAL)) => PermissionState::Missing,
        _ => PermissionState::Granted,
    }
}

fn folders_state(paths: &PermissionPaths) -> PermissionState {
    match std::fs::read(&paths.folders_answer) {
        Err(_) => return PermissionState::NotAsked,
        Ok(answer) if answer == FOLDERS_DECLINED => return PermissionState::Declined,
        Ok(_) => {}
    }
    if protected_folders(&paths.home).all(|folder| folder_is_accessible(&folder)) {
        PermissionState::Granted
    } else {
        PermissionState::Missing
    }
}

fn protected_folders(home: &Path) -> impl Iterator<Item = PathBuf> + '_ {
    PROTECTED_FOLDERS.iter().map(move |name| home.join(name))
}

/// Whether SIQshift may list the folder. Listing an undecided folder is what
/// raises the prompt, so this runs only after the person asked for it. A
/// folder that does not exist protects nothing.
fn folder_is_accessible(folder: &Path) -> bool {
    match std::fs::read_dir(folder) {
        Ok(_) => true,
        Err(error) => error.kind() == io::ErrorKind::NotFound,
    }
}

/// `SMAppService.statusForLegacyURL`, the approval switch for a LaunchAgent
/// plist; `None` before macOS 13, which had no switch.
#[cfg(target_os = "macos")]
fn login_item_approval(plist: &Path) -> Option<isize> {
    use objc2::msg_send;
    use objc2::rc::autoreleasepool;
    use objc2::runtime::AnyClass;
    use objc2_foundation::{NSString, NSURL};

    #[link(name = "ServiceManagement", kind = "framework")]
    extern "C" {}

    let class = AnyClass::get(c"SMAppService")?;
    let path = plist.to_str()?;
    // Commands run on tokio workers, which have no autorelease pool.
    autoreleasepool(|_| {
        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        Some(unsafe { msg_send![class, statusForLegacyURL: &*url] })
    })
}

#[cfg(not(target_os = "macos"))]
fn login_item_approval(_plist: &Path) -> Option<isize> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths_in(dir: &Path) -> PermissionPaths {
        PermissionPaths {
            login_item_plist: dir.join("SIQshift.plist"),
            folders_answer: dir.join("protected-folders-answer"),
            home: dir.join("home"),
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "siqshift-permissions-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(dir.join("home")).expect("temp home");
        dir
    }

    #[test]
    fn login_item_state_is_missing_without_a_plist_or_when_switched_off() {
        let cases = [
            (false, None, PermissionState::Missing),
            (false, Some(1), PermissionState::Missing),
            (
                true,
                Some(LOGIN_ITEM_REQUIRES_APPROVAL),
                PermissionState::Missing,
            ),
            // Enabled, not registered, not found: launchd still starts it.
            (true, Some(1), PermissionState::Granted),
            (true, Some(0), PermissionState::Granted),
            (true, Some(3), PermissionState::Granted),
            // Before macOS 13 there is no switch to read.
            (true, None, PermissionState::Granted),
        ];
        for (plist_exists, approval, expected) in cases {
            // Act
            let state = login_item_state(plist_exists, approval);

            // Assert
            assert_eq!(state, expected, "{plist_exists} {approval:?}");
        }
    }

    #[test]
    fn folders_state_is_not_asked_until_siqshift_has_asked() {
        // Arrange
        let dir = temp_dir("not-asked");
        let paths = paths_in(&dir);

        // Act
        let state = folders_state(&paths);

        // Assert
        assert_eq!(state, PermissionState::NotAsked);
    }

    #[test]
    fn folders_state_is_declined_without_reading_any_folder() {
        // Arrange: a Documents folder that is not even a folder, which any
        // read would report as missing.
        let dir = temp_dir("declined");
        let paths = paths_in(&dir);
        std::fs::write(paths.home.join("Documents"), b"").expect("documents");
        std::fs::write(&paths.folders_answer, FOLDERS_DECLINED).expect("answer");

        // Act
        let state = folders_state(&paths);

        // Assert
        assert_eq!(state, PermissionState::Declined);
    }

    #[test]
    fn only_the_folders_can_be_declined() {
        // Arrange
        let dir = temp_dir("decline-login");
        let paths = paths_in(&dir);

        // Act
        let declined = decline(&paths, PermissionId::LoginItem);

        // Assert
        assert!(declined.is_err());
        assert!(!paths.folders_answer.exists());
    }

    #[test]
    fn folders_state_is_granted_when_every_folder_lists_or_is_absent() {
        // Arrange: Documents exists, Desktop and Downloads do not.
        let dir = temp_dir("granted");
        let paths = paths_in(&dir);
        std::fs::create_dir_all(paths.home.join("Documents")).expect("documents");
        std::fs::write(&paths.folders_answer, FOLDERS_ASKED).expect("answer");

        // Act
        let state = folders_state(&paths);

        // Assert
        assert_eq!(state, PermissionState::Granted);
    }

    #[cfg(unix)]
    #[test]
    fn folders_state_is_missing_when_a_folder_refuses_listing() {
        use std::os::unix::fs::PermissionsExt;

        // Arrange
        let dir = temp_dir("missing");
        let paths = paths_in(&dir);
        let documents = paths.home.join("Documents");
        std::fs::create_dir_all(&documents).expect("documents");
        std::fs::set_permissions(&documents, std::fs::Permissions::from_mode(0o000))
            .expect("lock documents");
        std::fs::write(&paths.folders_answer, FOLDERS_ASKED).expect("answer");

        // Act
        let state = folders_state(&paths);

        // Assert
        std::fs::set_permissions(&documents, std::fs::Permissions::from_mode(0o755))
            .expect("unlock documents");
        assert_eq!(state, PermissionState::Missing);
    }

    #[test]
    fn permission_ids_round_trip_and_reject_unknown_ids() {
        let cases = [
            ("login-item", Some(PermissionId::LoginItem)),
            ("protected-folders", Some(PermissionId::ProtectedFolders)),
            ("screen-recording", None),
            ("", None),
        ];
        for (id, expected) in cases {
            // Act
            let parsed = PermissionId::from_id(id).ok();

            // Assert
            assert_eq!(parsed, expected, "{id}");
            if let Some(parsed) = parsed {
                assert_eq!(serde_json::to_value(parsed).expect("id"), id);
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn other_platforms_report_and_request_nothing() {
        // Arrange
        let dir = temp_dir("other-os");
        let paths = paths_in(&dir);

        // Act
        let statuses = statuses(&paths);
        let requested = request(&paths, PermissionId::ProtectedFolders).expect("request");
        let declined = decline(&paths, PermissionId::ProtectedFolders).expect("decline");

        // Assert
        assert!(statuses.is_empty());
        assert!(requested.is_empty());
        assert!(declined.is_empty());
        assert!(!paths.folders_answer.exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn asking_for_the_folders_records_the_ask_and_reports_every_grant() {
        // Arrange: a temp home, so no real protected folder is touched.
        let dir = temp_dir("ask");
        let paths = paths_in(&dir);

        // Act
        let statuses = request(&paths, PermissionId::ProtectedFolders).expect("request");

        // Assert
        assert_eq!(
            std::fs::read(&paths.folders_answer).expect("answer"),
            FOLDERS_ASKED
        );
        assert_eq!(
            statuses,
            vec![
                PermissionStatus {
                    id: PermissionId::LoginItem,
                    state: PermissionState::Missing,
                },
                PermissionStatus {
                    id: PermissionId::ProtectedFolders,
                    state: PermissionState::Granted,
                },
            ]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn declining_the_folders_records_the_answer() {
        // Arrange
        let dir = temp_dir("decline");
        let paths = paths_in(&dir);

        // Act
        let statuses = decline(&paths, PermissionId::ProtectedFolders).expect("decline");

        // Assert
        assert_eq!(
            std::fs::read(&paths.folders_answer).expect("answer"),
            FOLDERS_DECLINED
        );
        assert_eq!(statuses[1].state, PermissionState::Declined);
    }

    // CI's macOS runners are macOS 14 or later, where SMAppService exists; a
    // `None` here means the ServiceManagement framework never loaded.
    #[cfg(target_os = "macos")]
    #[test]
    fn login_item_approval_reads_service_management() {
        // Arrange
        let dir = temp_dir("approval");

        // Act
        let approval = login_item_approval(&dir.join("SIQshift.plist"));

        // Assert
        assert!(approval.is_some());
    }
}
