//! End-to-end checks for the `siqshift-hook` binary: valid input lands as one
//! canonical spool line, invalid input exits non-zero and writes nothing.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use siqshift_desktop_lib::spool::{self, MAX_SPOOL_RECORD_BYTES};

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("siqshift-hook-test-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir is created");
    dir
}

fn active_agent_spool(root: &Path) -> PathBuf {
    let identity =
        spool::EvidenceIdentity::new("cli-user", "cli-organization").expect("identity is valid");
    let dir = root
        .join("evidence")
        .join(&identity.account_id)
        .join(&identity.organization_id);
    std::fs::create_dir_all(&dir).expect("active evidence namespace creates");
    std::fs::write(
        root.join("active-identity.json"),
        serde_json::to_vec(&identity).expect("active identity serializes"),
    )
    .expect("active identity writes");
    dir.join("agent-spool.jsonl")
}

fn run_hook(root: &Path, args: &[&str], stdin: Option<&str>) -> std::process::Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_siqshift-hook"))
        .args(args)
        .env("SIQSHIFT_SPOOL", root.join("agent-spool.jsonl"))
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stderr(Stdio::piped())
        .spawn()
        .expect("hook binary spawns");
    if let Some(input) = stdin {
        child
            .stdin
            .take()
            .expect("stdin is piped")
            .write_all(input.as_bytes())
            .expect("stdin writes");
    }
    child.wait_with_output().expect("hook exits")
}

#[test]
fn an_event_lands_in_the_default_spool_when_no_identity_is_active() {
    // The state every real install is in: nothing activates a namespaced
    // evidence identity, so the hook must write the spool the desktop uploader
    // drains. Getting this wrong is silent — the hook exits 0 and the whole
    // agent-attribution path simply reports that no agents ever ran.
    let dir = temp_dir("no-identity");
    let spool = dir.join("agent-spool.jsonl");

    let output = run_hook(
        &dir,
        &[
            "--source",
            "pi",
            "--event",
            "session-start",
            "--session-id",
            "s1",
            "--cwd",
            "/home/dev/SIQshift",
            "--model",
            "deepseek-v4-pro",
        ],
        None,
    );

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let content = std::fs::read_to_string(&spool).expect("the default spool reads");
    let value: serde_json::Value =
        serde_json::from_str(content.lines().next().expect("one line")).expect("line parses");
    assert_eq!(value["source"], "pi");
    assert_eq!(value["model"], "deepseek-v4-pro");
    assert_eq!(value["cwd"], "/home/dev/SIQshift");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn concurrent_runtimes_each_land_as_their_own_line() {
    // Several agent CLIs run at once on one machine. Two runtimes in the same
    // folder must stay two events, told apart by source and session id.
    let dir = temp_dir("concurrent-runtimes");
    let spool = dir.join("agent-spool.jsonl");

    for (source, session, model) in [
        ("claude_code", "claude-1", "claude-opus-5"),
        ("pi", "pi-1", "deepseek-v4-pro"),
    ] {
        let output = run_hook(
            &dir,
            &[
                "--source",
                source,
                "--event",
                "session-start",
                "--session-id",
                session,
                "--cwd",
                "/home/dev/SIQshift",
                "--model",
                model,
            ],
            None,
        );
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let content = std::fs::read_to_string(&spool).expect("the default spool reads");
    let recorded: Vec<(String, String)> = content
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).expect("line parses"))
        .map(|value| {
            (
                value["source"].as_str().expect("a source").to_string(),
                value["model"].as_str().expect("a model").to_string(),
            )
        })
        .collect();
    assert_eq!(
        recorded,
        vec![
            ("claude_code".to_string(), "claude-opus-5".to_string()),
            ("pi".to_string(), "deepseek-v4-pro".to_string()),
        ],
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_valid_stdin_event_lands_as_one_canonical_line() {
    let dir = temp_dir("stdin");
    let spool = active_agent_spool(&dir);

    let output = run_hook(
        &dir,
        &[],
        Some(
            r#"{"version":1,"source":"claude-code","event":"session-start","sessionId":"s1","cwd":"C:/dev/SIQshift","occurredAt":"2026-08-07T12:00:00Z"}"#,
        ),
    );

    assert!(output.status.success());
    let content = std::fs::read_to_string(&spool).expect("spool reads");
    let lines: Vec<&str> = content.lines().collect();
    assert_eq!(lines.len(), 1);
    let value: serde_json::Value = serde_json::from_str(lines[0]).expect("line parses");
    assert_eq!(value["source"], "claude_code");
    assert_eq!(value["event"], "started");
    assert_eq!(value["externalSessionId"], "s1");
    assert_eq!(value["occurredAt"], "2026-08-07T12:00:00Z");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_claude_native_stdin_payload_is_translated_and_spooled() {
    let dir = temp_dir("claude-native");
    let spool = active_agent_spool(&dir);

    let output = run_hook(
        &dir,
        &[],
        Some(
            r#"{"session_id":"s1","transcript_path":"/tmp/t.jsonl","cwd":"C:/dev/SIQshift","hook_event_name":"SessionStart","source":"startup"}"#,
        ),
    );

    assert!(output.status.success());
    let content = std::fs::read_to_string(&spool).expect("spool reads");
    let lines: Vec<&str> = content.lines().collect();
    assert_eq!(lines.len(), 1);
    let value: serde_json::Value = serde_json::from_str(lines[0]).expect("line parses");
    assert_eq!(value["source"], "claude_code");
    assert_eq!(value["event"], "started");
    assert_eq!(value["externalSessionId"], "s1");
    assert_eq!(value["cwd"], "C:/dev/SIQshift");
    // Claude's payload has no timestamp; the hook stamps the current time.
    assert!(value["occurredAt"]
        .as_str()
        .expect("stamped")
        .ends_with('Z'));

    let _ = std::fs::remove_dir_all(&dir);
}

/// The app starts from the Finder or at login without `XDG_DATA_HOME`, while
/// the hook runs inside Claude Code with what the login shell exports, so a
/// shell that sets it must not move the hook's spool away from the app's.
#[cfg(target_os = "macos")]
#[test]
fn a_shell_xdg_data_home_does_not_move_the_spool_on_macos() {
    let home = temp_dir("xdg-home");
    let xdg = home.join("xdg");
    let mut child = Command::new(env!("CARGO_BIN_EXE_siqshift-hook"))
        .env_remove("SIQSHIFT_SPOOL")
        .env("HOME", &home)
        .env("XDG_DATA_HOME", &xdg)
        .current_dir(&home)
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("hook binary spawns");
    child
        .stdin
        .take()
        .expect("stdin is piped")
        .write_all(
            br#"{"session_id":"xdg-split","cwd":"/tmp","hook_event_name":"SessionStart","source":"startup"}"#,
        )
        .expect("stdin writes");
    let output = child.wait_with_output().expect("hook exits");

    assert!(output.status.success(), "{output:?}");
    let spool = home.join(".local/share/siqshift/agent-spool.jsonl");
    let content = std::fs::read_to_string(&spool).expect("the app's spool holds the event");
    assert!(content.contains("xdg-split"));
    assert!(!xdg.exists(), "nothing lands under XDG_DATA_HOME");

    let _ = std::fs::remove_dir_all(&home);
}

/// An orchestrator runs its agents natively: no shell between it and the
/// agent, and no console or window of their own. Detection rides the agent's
/// hook, so the hook spools a session from such a parent exactly as from a
/// terminal. This test process stands in for that parent; on Windows it
/// starts the hook detached from every console.
#[test]
fn a_session_started_under_a_windowless_non_shell_parent_is_spooled() {
    // Arrange
    let dir = temp_dir("windowless-parent");
    let spool = active_agent_spool(&dir);
    let mut command = Command::new(env!("CARGO_BIN_EXE_siqshift-hook"));
    command
        .env("SIQSHIFT_SPOOL", dir.join("agent-spool.jsonl"))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        command.creation_flags(DETACHED_PROCESS);
    }

    // Act
    let mut child = command.spawn().expect("hook binary spawns");
    child
        .stdin
        .take()
        .expect("stdin is piped")
        .write_all(
            br#"{"session_id":"native-1","transcript_path":"/tmp/t.jsonl","cwd":"C:/dev/SIQshift","hook_event_name":"SessionStart","source":"startup"}"#,
        )
        .expect("stdin writes");
    let status = child.wait().expect("hook exits");

    // Assert
    assert!(status.success());
    let content = std::fs::read_to_string(&spool).expect("spool reads");
    let lines: Vec<&str> = content.lines().collect();
    assert_eq!(lines.len(), 1);
    let value: serde_json::Value = serde_json::from_str(lines[0]).expect("line parses");
    assert_eq!(value["source"], "claude_code");
    assert_eq!(value["event"], "started");
    assert_eq!(value["externalSessionId"], "native-1");
    assert_eq!(value["cwd"], "C:/dev/SIQshift");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_untracked_claude_event_exits_zero_and_writes_nothing() {
    let dir = temp_dir("claude-ignored");
    let spool = active_agent_spool(&dir);

    let output = run_hook(
        &dir,
        &[],
        Some(r#"{"session_id":"s1","cwd":"/x","hook_event_name":"Notification"}"#),
    );

    assert!(output.status.success());
    assert!(!spool.exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_claude_payload_without_a_session_id_exits_non_zero() {
    let dir = temp_dir("claude-invalid");
    let spool = active_agent_spool(&dir);

    let output = run_hook(
        &dir,
        &[],
        Some(r#"{"cwd":"/x","hook_event_name":"SessionStart"}"#),
    );

    assert!(!output.status.success());
    assert!(!spool.exists());
    let stderr = String::from_utf8(output.stderr).expect("stderr is utf-8");
    assert!(stderr.contains("siqshift-hook:"));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn malformed_stdin_exits_non_zero_and_writes_nothing() {
    let dir = temp_dir("malformed");
    let spool = active_agent_spool(&dir);

    let output = run_hook(&dir, &[], Some(r#"{"version":2,"source":"codex"}"#));

    assert!(!output.status.success());
    assert!(!spool.exists());
    let stderr = String::from_utf8(output.stderr).expect("stderr is utf-8");
    assert!(stderr.contains("siqshift-hook:"));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn oversized_stdin_exits_non_zero_without_creating_a_spool() {
    let dir = temp_dir("oversized");
    let spool = active_agent_spool(&dir);
    let input = "x".repeat(MAX_SPOOL_RECORD_BYTES + 1);

    let output = run_hook(&dir, &[], Some(&input));

    assert!(!output.status.success());
    assert!(!spool.exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn argv_flags_are_a_fallback_for_clis_that_cannot_pipe() {
    let dir = temp_dir("argv");
    let spool = active_agent_spool(&dir);

    let output = run_hook(
        &dir,
        &[
            "--source",
            "kimi-code",
            "--event",
            "heartbeat",
            "--session-id",
            "s9",
            "--cwd",
            "/home/alex/project",
        ],
        None,
    );

    assert!(output.status.success());
    let content = std::fs::read_to_string(&spool).expect("spool reads");
    let value: serde_json::Value =
        serde_json::from_str(content.lines().next().expect("one line")).expect("line parses");
    assert_eq!(value["source"], "kimi_code");
    assert_eq!(value["event"], "heartbeat");
    // --occurred-at omitted: the hook stamps the current time itself.
    assert!(value["occurredAt"]
        .as_str()
        .expect("stamped")
        .ends_with('Z'));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_missing_flag_value_exits_non_zero_and_writes_nothing() {
    let dir = temp_dir("argv-missing");
    let spool = active_agent_spool(&dir);

    // --session-id without the rest of the identity flags is incomplete.
    let output = run_hook(&dir, &["--source", "codex", "--session-id", "s1"], None);

    assert!(!output.status.success());
    assert!(!spool.exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn cursor_flags_with_a_native_payload_spool_an_event() {
    let dir = temp_dir("cursor-native");
    let spool = active_agent_spool(&dir);

    let output = run_hook(
        &dir,
        &["--source", "cursor", "--event", "session-start"],
        Some(r#"{"conversation_id":"c1","workspace_roots":["C:/dev/SIQshift"]}"#),
    );

    assert!(output.status.success());
    let content = std::fs::read_to_string(&spool).expect("spool reads");
    let lines: Vec<&str> = content.lines().collect();
    assert_eq!(lines.len(), 1);
    let value: serde_json::Value = serde_json::from_str(lines[0]).expect("line parses");
    assert_eq!(value["source"], "cursor");
    assert_eq!(value["event"], "started");
    assert_eq!(value["externalSessionId"], "c1");
    assert_eq!(value["cwd"], "C:/dev/SIQshift");
    // Cursor's payload has no timestamp; the hook stamps the current time.
    assert!(value["occurredAt"]
        .as_str()
        .expect("stamped")
        .ends_with('Z'));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_cursor_payload_without_a_session_id_exits_zero_and_writes_nothing() {
    let dir = temp_dir("cursor-ignored");
    let spool = active_agent_spool(&dir);

    let output = run_hook(
        &dir,
        &["--source", "cursor", "--event", "session-end"],
        Some(r#"{"cwd":"/x"}"#),
    );

    assert!(output.status.success());
    assert!(!spool.exists());

    let _ = std::fs::remove_dir_all(&dir);
}

fn init_repo_with_one_commit(dir: &Path) -> String {
    std::fs::create_dir_all(dir).expect("repo dir creates");
    for args in [
        &["init", "--quiet", "--initial-branch=main"][..],
        &["config", "user.email", "shift@example.test"][..],
        &["config", "user.name", "Shift Test"][..],
        &["config", "commit.gpgsign", "false"][..],
    ] {
        let status = Command::new("git")
            .args(args)
            .current_dir(dir)
            .status()
            .expect("git runs");
        assert!(status.success(), "git setup failed in {dir:?}");
    }
    std::fs::write(dir.join("a.txt"), "base").expect("scratch file writes");
    for args in [&["add", "-A"][..], &["commit", "--quiet", "-m", "base"][..]] {
        let status = Command::new("git")
            .args(args)
            .current_dir(dir)
            .status()
            .expect("git runs");
        assert!(status.success(), "git commit failed in {dir:?}");
    }
    let output = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(dir)
        .output()
        .expect("git rev-parse runs");
    String::from_utf8(output.stdout)
        .expect("utf8 sha")
        .trim()
        .to_string()
}

#[test]
fn a_started_event_over_a_git_repo_records_the_head_at_shift_start() {
    let dir = temp_dir("started-head-repo");
    let repo = dir.join("repo");
    let head = init_repo_with_one_commit(&repo);
    let spool = active_agent_spool(&dir);

    let output = run_hook(
        &dir,
        &[
            "--source",
            "pi",
            "--event",
            "session-start",
            "--session-id",
            "s1",
            "--cwd",
            repo.to_str().expect("utf8 path"),
        ],
        None,
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let content = std::fs::read_to_string(&spool).expect("spool reads");
    let value: serde_json::Value =
        serde_json::from_str(content.lines().next().expect("one line")).expect("line parses");
    assert_eq!(value["startHead"], head);
    // The same probe names the codebase the shift's identity is keyed on.
    // Both come from one `Started` line; only this one is contract data.
    let recorded = value["repoRoot"].as_str().expect("the repo root records");
    assert_eq!(
        std::fs::canonicalize(recorded).expect("canonical"),
        std::fs::canonicalize(&repo).expect("canonical")
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_started_event_over_a_non_repo_cwd_records_no_head() {
    let dir = temp_dir("started-head-non-repo");
    let not_a_repo = dir.join("not-a-repo");
    std::fs::create_dir_all(&not_a_repo).expect("dir creates");
    let spool = active_agent_spool(&dir);

    let output = run_hook(
        &dir,
        &[
            "--source",
            "pi",
            "--event",
            "session-start",
            "--session-id",
            "s1",
            "--cwd",
            not_a_repo.to_str().expect("utf8 path"),
        ],
        None,
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let content = std::fs::read_to_string(&spool).expect("spool reads");
    let value: serde_json::Value =
        serde_json::from_str(content.lines().next().expect("one line")).expect("line parses");
    assert!(value.get("startHead").is_none());
    // A cwd outside a repository names no codebase; the shift lands in its
    // operator's unassigned bucket and graduates from a later commit.
    assert!(value.get("repoRoot").is_none());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn cumulative_token_flags_land_on_the_spool_event() {
    let dir = temp_dir("argv-tokens");
    let spool = active_agent_spool(&dir);

    let output = run_hook(
        &dir,
        &[
            "--source",
            "pi",
            "--event",
            "heartbeat",
            "--session-id",
            "s1",
            "--cwd",
            "/home/dev/SIQshift",
            "--input-tokens",
            "1200",
            "--output-tokens",
            "300",
            "--cache-creation-input-tokens",
            "45",
            "--cache-read-input-tokens",
            "90000",
        ],
        None,
    );

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let content = std::fs::read_to_string(&spool).expect("spool reads");
    let value: serde_json::Value =
        serde_json::from_str(content.lines().next().expect("one line")).expect("line parses");
    assert_eq!(value["tokens"]["inputTokens"], 1200);
    assert_eq!(value["tokens"]["outputTokens"], 300);
    assert_eq!(value["tokens"]["cacheCreationInputTokens"], 45);
    assert_eq!(value["tokens"]["cacheReadInputTokens"], 90000);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_empty_token_flag_reads_as_absent() {
    let dir = temp_dir("argv-tokens-empty");
    let spool = active_agent_spool(&dir);

    // A runtime that cannot name a counter passes an empty string rather than
    // branching its own hook wiring; that reads as absent, exactly as --model.
    let output = run_hook(
        &dir,
        &[
            "--source",
            "pi",
            "--event",
            "heartbeat",
            "--session-id",
            "s1",
            "--cwd",
            "/home/dev/SIQshift",
            "--input-tokens",
            "",
            "--output-tokens",
            "",
            "--cache-creation-input-tokens",
            "",
            "--cache-read-input-tokens",
            "",
        ],
        None,
    );

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let content = std::fs::read_to_string(&spool).expect("spool reads");
    let value: serde_json::Value =
        serde_json::from_str(content.lines().next().expect("one line")).expect("line parses");
    assert!(
        value.get("tokens").is_none(),
        "no token flag with a value means no counters at all: {value}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn token_flags_ride_a_cli_native_stdin_payload() {
    let dir = temp_dir("argv-tokens-native");
    let spool = active_agent_spool(&dir);

    // Identity on the command line, payload on stdin (the Cursor/Codex shape):
    // the flags are the only channel a CLI-native payload has for counters.
    let output = run_hook(
        &dir,
        &[
            "--source",
            "cursor",
            "--event",
            "heartbeat",
            "--input-tokens",
            "42",
        ],
        Some(r#"{"conversation_id":"c1","workspace_roots":["C:/dev/SIQshift"]}"#),
    );

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let content = std::fs::read_to_string(&spool).expect("spool reads");
    let value: serde_json::Value =
        serde_json::from_str(content.lines().next().expect("one line")).expect("line parses");
    assert_eq!(value["tokens"]["inputTokens"], 42);
    assert!(value["tokens"].get("outputTokens").is_none());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_non_numeric_token_flag_exits_non_zero_and_writes_nothing() {
    let dir = temp_dir("argv-tokens-invalid");
    let spool = active_agent_spool(&dir);

    let output = run_hook(
        &dir,
        &[
            "--source",
            "pi",
            "--event",
            "heartbeat",
            "--session-id",
            "s1",
            "--cwd",
            "/home/dev/SIQshift",
            "--input-tokens",
            "lots",
        ],
        None,
    );

    assert!(!output.status.success());
    assert!(!spool.exists());

    let _ = std::fs::remove_dir_all(&dir);
}

/// The hook probes git on a `Started` event with `rev-parse HEAD` first. A copy
/// of this test binary named `git` answers every probe as libtest: `rev-parse`
/// and `HEAD` read as name filters, so the test below runs, while the later
/// probes pass flags libtest rejects and fail fast.
#[allow(non_snake_case)]
#[test]
fn fake_git_HEAD_probe_holds_until_killed() {
    const FAKE_GIT_HOLD_CAP: Duration = Duration::from_secs(60);
    let Some(pid_file) = std::env::var_os(PID_FILE_ENV) else {
        return;
    };
    std::fs::write(pid_file, std::process::id().to_string()).expect("the pid file writes");
    std::thread::sleep(FAKE_GIT_HOLD_CAP);
}

const PID_FILE_ENV: &str = "SIQSHIFT_TEST_FAKE_GIT_PID_FILE";

struct FakeGit {
    bin_dir: PathBuf,
    pid_file: PathBuf,
}

fn install_fake_git(dir: &Path) -> FakeGit {
    let bin_dir = dir.join("fake-git-bin");
    std::fs::create_dir_all(&bin_dir).expect("fake git dir creates");
    let name = if cfg!(windows) { "git.exe" } else { "git" };
    std::fs::copy(
        std::env::current_exe().expect("the test binary has a path"),
        bin_dir.join(name),
    )
    .expect("the test binary copies as git");
    FakeGit {
        bin_dir,
        pid_file: dir.join("fake-git.pid"),
    }
}

fn spawn_hook_with_fake_git(dir: &Path, fake_git: &FakeGit, hook_event_name: &str) -> Child {
    let cwd = dir.join("not-a-repo");
    std::fs::create_dir_all(&cwd).expect("cwd creates");
    let path = std::env::join_paths(std::iter::once(fake_git.bin_dir.clone()).chain(
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()),
    ))
    .expect("PATH joins");
    let payload = serde_json::json!({
        "session_id": "fake-git-1",
        "cwd": cwd,
        "hook_event_name": hook_event_name,
    });
    let mut child = Command::new(env!("CARGO_BIN_EXE_siqshift-hook"))
        .env("SIQSHIFT_SPOOL", dir.join("agent-spool.jsonl"))
        .env("PATH", path)
        .env(PID_FILE_ENV, &fake_git.pid_file)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("hook binary spawns");
    child
        .stdin
        .take()
        .expect("stdin is piped")
        .write_all(payload.to_string().as_bytes())
        .expect("stdin writes");
    child
}

/// Polls until `condition` holds or `cap` passes; true when it held.
fn wait_until(cap: Duration, mut condition: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + cap;
    loop {
        if condition() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn read_pid(pid_file: &Path) -> Option<u32> {
    std::fs::read_to_string(pid_file).ok()?.trim().parse().ok()
}

#[cfg(windows)]
fn is_process_running(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };
    // SAFETY: the handle is opened, waited on without blocking, and closed here.
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return false;
        }
        let is_running = WaitForSingleObject(handle, 0) == WAIT_TIMEOUT;
        CloseHandle(handle);
        is_running
    }
}

#[cfg(windows)]
fn terminate_process(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    // SAFETY: the handle is opened, used once, and closed here.
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !handle.is_null() {
            TerminateProcess(handle, 1);
            CloseHandle(handle);
        }
    }
}

#[cfg(not(windows))]
fn is_process_running(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(not(windows))]
fn terminate_process(pid: u32) {
    let _ = Command::new("kill")
        .args(["-9", &pid.to_string()])
        .stderr(Stdio::null())
        .status();
}

/// Kills a fake git the test is about to report as leaked, so a failing run
/// never leaves a sleeping process behind.
fn clean_up_fake_git(fake_git: &FakeGit) {
    if let Some(pid) = read_pid(&fake_git.pid_file) {
        if is_process_running(pid) {
            terminate_process(pid);
        }
    }
}

const HOOK_EXIT_CAP: Duration = Duration::from_secs(30);
const GIT_GONE_CAP: Duration = Duration::from_secs(5);

/// Claude Code cancels a hook that runs long by killing it. git must not
/// outlive that: the kill leaves the hook no chance to clean up after itself,
/// so it binds its children to its own lifetime.
#[cfg(windows)]
#[test]
fn a_cancelled_session_start_hook_leaves_no_git_running() {
    const PID_FILE_WAIT_CAP: Duration = Duration::from_secs(30);

    // Arrange
    let dir = temp_dir("cancelled-hook");
    let fake_git = install_fake_git(&dir);
    let mut hook = spawn_hook_with_fake_git(&dir, &fake_git, "SessionStart");
    let has_git_started = wait_until(PID_FILE_WAIT_CAP, || read_pid(&fake_git.pid_file).is_some());
    assert!(has_git_started, "the hook never started git");
    let git_pid = read_pid(&fake_git.pid_file).expect("the pid reads");

    // Act
    hook.kill().expect("the hook is killed");
    hook.wait().expect("the hook is reaped");
    let is_git_gone = wait_until(GIT_GONE_CAP, || !is_process_running(git_pid));

    // Assert
    clean_up_fake_git(&fake_git);
    assert!(is_git_gone, "git {git_pid} outlived the killed hook");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_session_start_hook_returns_within_its_git_budget_and_leaves_no_git() {
    // Arrange
    let dir = temp_dir("git-budget");
    let spool = dir.join("agent-spool.jsonl");
    let fake_git = install_fake_git(&dir);

    // Act
    let mut hook = spawn_hook_with_fake_git(&dir, &fake_git, "SessionStart");
    let is_hook_done = wait_until(HOOK_EXIT_CAP, || {
        hook.try_wait().expect("hook status reads").is_some()
    });
    if !is_hook_done {
        let _ = hook.kill();
    }
    let status = hook.wait().expect("hook is reaped");

    // Assert
    let git_pid = read_pid(&fake_git.pid_file);
    let is_git_gone =
        git_pid.is_none_or(|pid| wait_until(GIT_GONE_CAP, || !is_process_running(pid)));
    clean_up_fake_git(&fake_git);
    assert!(is_hook_done, "the hook blocked on a git that never answers");
    assert!(status.success());
    assert!(git_pid.is_some(), "the hook never started git");
    assert!(is_git_gone, "git outlived the hook");
    let content = std::fs::read_to_string(&spool).expect("the started line spools");
    let value: serde_json::Value =
        serde_json::from_str(content.lines().next().expect("one line")).expect("line parses");
    assert_eq!(value["event"], "started");
    assert!(value.get("startHead").is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

fn run_claude_hook_with_git_trace(
    dir: &Path,
    cwd: &Path,
    hook_event_name: &str,
    git_trace: &Path,
) -> std::process::Output {
    let payload = serde_json::json!({
        "session_id": "git-trace-1",
        "cwd": cwd,
        "hook_event_name": hook_event_name,
    });
    let mut child = Command::new(env!("CARGO_BIN_EXE_siqshift-hook"))
        .env("SIQSHIFT_SPOOL", dir.join("agent-spool.jsonl"))
        .env("GIT_TRACE", git_trace)
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("hook binary spawns");
    child
        .stdin
        .take()
        .expect("stdin is piped")
        .write_all(payload.to_string().as_bytes())
        .expect("stdin writes");
    child.wait_with_output().expect("hook exits")
}

/// git appends to the file `GIT_TRACE` names on every invocation, whatever its
/// arguments, so the file existing is the oracle for "the hook started git".
/// The `SessionStart` run is the control that the oracle sees the hook's git.
#[test]
fn a_session_end_hook_never_starts_git() {
    // Arrange
    let dir = temp_dir("end-no-git");
    let repo = dir.join("repo");
    init_repo_with_one_commit(&repo);
    let spool = dir.join("agent-spool.jsonl");
    let start_trace = dir.join("start-git-trace.log");
    let end_trace = dir.join("end-git-trace.log");

    // Act
    let start_output = run_claude_hook_with_git_trace(&dir, &repo, "SessionStart", &start_trace);
    let end_output = run_claude_hook_with_git_trace(&dir, &repo, "SessionEnd", &end_trace);

    // Assert
    assert!(
        start_output.status.success(),
        "{}",
        String::from_utf8_lossy(&start_output.stderr)
    );
    assert!(
        start_trace.exists(),
        "the trace never saw the start hook's git"
    );
    assert!(
        end_output.status.success(),
        "{}",
        String::from_utf8_lossy(&end_output.stderr)
    );
    assert!(!end_trace.exists(), "the end hook started git");
    let content = std::fs::read_to_string(&spool).expect("the spool reads");
    let events: Vec<serde_json::Value> = content
        .lines()
        .map(|line| serde_json::from_str(line).expect("line parses"))
        .collect();
    assert_eq!(events.len(), 2);
    assert_eq!(events[1]["event"], "ended");
    let _ = std::fs::remove_dir_all(&dir);
}
