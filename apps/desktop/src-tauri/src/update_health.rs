//! Whether this copy has stopped being able to update itself.
//!
//! One failed update check is ordinary and says nothing. A copy that can never
//! update (a manifest with no build for this platform, a bundle the person
//! cannot write, any install error that repeats) fails every check the same
//! way, and only a run of failures tells the two apart. The run is kept on
//! disk, so a machine restarted every day still reaches it.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// Failed attempts in a row before the window says this copy cannot update
/// itself. An attempt runs at every launch and every `UPDATE_CHECK_INTERVAL`
/// after it, so this counts attempts, not time: three quick restarts during a
/// short outage can reach it, and the next successful check takes it down.
pub const FAILED_ATTEMPTS_BEFORE_NOTICE: u32 = 3;

/// How one update attempt ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpdateOutcome {
    /// A newer build was downloaded and installed.
    Staged,
    /// The release host answered and this build is the newest.
    UpToDate,
    /// The release host could not be reached, which proves nothing about this
    /// copy: an offline laptop is not a copy that cannot update.
    Unreachable,
    /// The check or the install failed with the host reachable.
    Failed,
}

impl UpdateOutcome {
    /// Sorts an updater error into a reachability failure, which leaves the
    /// run of failures as it is, and every other failure, which adds to it.
    pub fn of_error(error: &tauri_plugin_updater::Error) -> Self {
        match error {
            tauri_plugin_updater::Error::Reqwest(error)
                if error.is_connect() || error.is_timeout() =>
            {
                Self::Unreachable
            }
            _ => Self::Failed,
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdateHealth {
    consecutive_failures: u32,
}

impl UpdateHealth {
    /// A missing or unreadable file reads as no failures: the worst it costs
    /// is a few more checks before the notice.
    pub fn load(path: &Path) -> Self {
        std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, serde_json::to_vec(self)?)
    }

    pub fn record(&mut self, outcome: UpdateOutcome) {
        match outcome {
            UpdateOutcome::Staged | UpdateOutcome::UpToDate => self.consecutive_failures = 0,
            UpdateOutcome::Unreachable => {}
            UpdateOutcome::Failed => {
                self.consecutive_failures = self.consecutive_failures.saturating_add(1)
            }
        }
    }

    pub fn is_failing(&self) -> bool {
        self.consecutive_failures >= FAILED_ATTEMPTS_BEFORE_NOTICE
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    use UpdateOutcome::{Failed, Staged, Unreachable, UpToDate};

    fn health_after(outcomes: &[UpdateOutcome]) -> UpdateHealth {
        let mut health = UpdateHealth::default();
        for outcome in outcomes {
            health.record(*outcome);
        }
        health
    }

    fn temp_file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "siqshift-update-health-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("update-health.json")
    }

    #[test]
    fn the_notice_turns_on_at_the_failure_count_and_not_before() {
        let cases: [(&[UpdateOutcome], bool); 5] = [
            (&[], false),
            (&[Failed, Failed], false),
            (&[Failed, Failed, Failed], true),
            (&[Failed, Failed, Failed, Failed], true),
            (&[Failed, UpToDate, Failed, Failed], false),
        ];
        for (outcomes, expected) in cases {
            assert_eq!(
                health_after(outcomes).is_failing(),
                expected,
                "{outcomes:?}"
            );
        }
    }

    #[test]
    fn a_successful_check_turns_the_notice_off() {
        for success in [UpToDate, Staged] {
            let mut health = health_after(&[Failed, Failed, Failed]);
            assert!(health.is_failing());

            health.record(success);

            assert!(!health.is_failing(), "{success:?}");
            assert_eq!(health, UpdateHealth::default(), "{success:?}");
        }
    }

    #[test]
    fn an_unreachable_host_neither_adds_to_the_run_nor_ends_it() {
        assert!(!health_after(&[Failed, Failed, Unreachable, Unreachable]).is_failing());
        assert!(health_after(&[Failed, Failed, Unreachable, Failed]).is_failing());
        assert!(health_after(&[Failed, Failed, Failed, Unreachable]).is_failing());
    }

    #[test]
    fn a_manifest_without_this_platform_counts_as_a_failure() {
        let errors = [
            tauri_plugin_updater::Error::TargetsNotFound(vec!["darwin-aarch64".to_string()]),
            tauri_plugin_updater::Error::ReleaseNotFound,
            tauri_plugin_updater::Error::Io(std::io::Error::from(
                std::io::ErrorKind::PermissionDenied,
            )),
        ];
        for error in errors {
            assert_eq!(UpdateOutcome::of_error(&error), Failed, "{error}");
        }
    }

    /// A real `reqwest` answer, so the test rests on reqwest's own idea of a
    /// connect error rather than on one built by hand.
    fn reqwest_error(url: String) -> tauri_plugin_updater::Error {
        // As the updater's own check does; a second install is refused, and
        // whichever test got there first already installed the same provider.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime builds");
        let error = runtime
            .block_on(updater_reqwest::Client::new().get(url).send())
            .expect_err("the request fails");
        tauri_plugin_updater::Error::Reqwest(error)
    }

    #[test]
    fn a_host_that_refuses_the_connection_reads_as_unreachable() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("port binds");
        let closed_port = listener.local_addr().expect("port has an address").port();
        drop(listener);

        let error = reqwest_error(format!("http://127.0.0.1:{closed_port}/latest.json"));

        assert_eq!(UpdateOutcome::of_error(&error), Unreachable, "{error}");
    }

    #[test]
    fn a_request_error_that_is_not_about_reaching_the_host_counts_as_a_failure() {
        let error = reqwest_error("not a url".to_string());

        assert_eq!(UpdateOutcome::of_error(&error), Failed, "{error}");
    }

    #[test]
    fn the_run_of_failures_outlives_a_restart() {
        let path = temp_file("restart");
        health_after(&[Failed, Failed, Failed])
            .save(&path)
            .expect("health saves");

        let loaded = UpdateHealth::load(&path);

        assert!(loaded.is_failing());
        let _ = std::fs::remove_dir_all(path.parent().expect("file has a parent"));
    }

    #[test]
    fn a_missing_or_unreadable_file_reads_as_no_failures() {
        let path = temp_file("unreadable");
        assert_eq!(UpdateHealth::load(&path), UpdateHealth::default());

        std::fs::create_dir_all(path.parent().expect("file has a parent")).expect("dir creates");
        std::fs::write(&path, b"not json").expect("file writes");

        assert_eq!(UpdateHealth::load(&path), UpdateHealth::default());
        let _ = std::fs::remove_dir_all(path.parent().expect("file has a parent"));
    }
}
