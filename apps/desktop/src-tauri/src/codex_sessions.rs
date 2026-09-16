use std::collections::{BTreeMap, BTreeSet};
use std::fs::OpenOptions;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use uuid::Uuid;

use crate::git_evidence;
use crate::spool::{self, AgentEventKind, AgentSource, SpoolEvent};

pub const RECONCILE_INTERVAL_SECONDS: u64 = 15;
const HEARTBEAT_INTERVAL_SECONDS: u64 = 5 * 60;
const APP_SERVER_TIMEOUT: Duration = Duration::from_secs(10);
const STATE_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq)]
struct HeldLock {
    thread_id: String,
    lifecycle_id: String,
    started_at: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ThreadMetadata {
    id: String,
    cwd: String,
    model: Option<String>,
    source: Value,
}

impl ThreadMetadata {
    fn is_terminal(&self) -> bool {
        matches!(self.source.as_str(), Some("cli" | "exec"))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ActiveLifecycle {
    thread_id: String,
    started_at: u64,
    last_heartbeat_at: u64,
    cwd: String,
    model: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ReconcileState {
    version: u32,
    #[serde(default)]
    active: BTreeMap<String, ActiveLifecycle>,
    #[serde(default)]
    ignored: BTreeSet<String>,
}

impl Default for ReconcileState {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            active: BTreeMap::new(),
            ignored: BTreeSet::new(),
        }
    }
}

struct ReconcilePlan {
    state: ReconcileState,
    events: Vec<PlannedEvent>,
}

struct PlannedEvent {
    lifecycle_id: String,
    lifecycle: ActiveLifecycle,
    kind: AgentEventKind,
    occurred_at: u64,
}

pub async fn reconcile(agent_path: &Path, now: u64) -> io::Result<Vec<SpoolEvent>> {
    let state_path = state_path(agent_path);
    let current = load_state(&state_path)?;
    let held = held_writer_locks(&codex_home()?, now)?;
    let unknown: BTreeSet<String> = held
        .iter()
        .filter(|lock| {
            current
                .active
                .get(&lock.lifecycle_id)
                .is_some_and(|lifecycle| {
                    lifecycle.model.is_none()
                        && now.saturating_sub(lifecycle.last_heartbeat_at)
                            >= HEARTBEAT_INTERVAL_SECONDS
                })
                || (!current.active.contains_key(&lock.lifecycle_id)
                    && !current.ignored.contains(&lock.lifecycle_id))
        })
        .map(|lock| lock.thread_id.clone())
        .collect();
    let metadata = if unknown.is_empty() {
        BTreeMap::new()
    } else {
        match query_thread_metadata(&unknown).await {
            Ok(metadata) => metadata,
            Err(error) => {
                eprintln!("siqshift: could not read Codex terminal metadata: {error}");
                BTreeMap::new()
            }
        }
    };
    let plan = plan_reconciliation(&current, &held, &metadata, now);
    let events: Vec<SpoolEvent> = plan.events.iter().map(materialize_event).collect();
    for event in &events {
        spool::append(agent_path, event)?;
    }
    if plan.state != current {
        let encoded = serde_json::to_vec_pretty(&plan.state).map_err(io::Error::other)?;
        spool::write_atomically(&state_path, &encoded)?;
    }
    Ok(events)
}

fn state_path(agent_path: &Path) -> PathBuf {
    agent_path.with_file_name("codex-live-sessions.json")
}

fn codex_home() -> io::Result<PathBuf> {
    if let Some(home) = std::env::var_os("CODEX_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(home));
    }
    std::env::var_os("USERPROFILE")
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var_os("HOME").filter(|value| !value.is_empty()))
        .map(PathBuf::from)
        .map(|home| home.join(".codex"))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Codex home is unavailable"))
}

fn load_state(path: &Path) -> io::Result<ReconcileState> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let state: ReconcileState = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
            if state.version != STATE_VERSION {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "unsupported Codex lifecycle state version",
                ));
            }
            Ok(state)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(ReconcileState::default()),
        Err(error) => Err(error),
    }
}

fn held_writer_locks(codex_home: &Path, now: u64) -> io::Result<Vec<HeldLock>> {
    let directory = codex_home.join("thread-writer-locks");
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut held = Vec::new();
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("lock") {
            continue;
        }
        let Some(thread_id) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if Uuid::parse_str(thread_id).is_err() {
            continue;
        }
        let file = OpenOptions::new().read(true).write(true).open(&path)?;
        match file.try_lock() {
            Ok(()) => file.unlock()?,
            Err(std::fs::TryLockError::WouldBlock) => {
                let elapsed = entry
                    .metadata()?
                    .modified()?
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default();
                held.push(HeldLock {
                    thread_id: thread_id.to_string(),
                    lifecycle_id: format!("{thread_id}-{}", elapsed.as_nanos()),
                    started_at: elapsed.as_secs().min(now),
                });
            }
            Err(std::fs::TryLockError::Error(error)) => return Err(error),
        }
    }
    held.sort_by(|left, right| left.lifecycle_id.cmp(&right.lifecycle_id));
    Ok(held)
}

fn plan_reconciliation(
    current: &ReconcileState,
    held: &[HeldLock],
    metadata: &BTreeMap<String, ThreadMetadata>,
    now: u64,
) -> ReconcilePlan {
    let held_ids: BTreeSet<&str> = held.iter().map(|lock| lock.lifecycle_id.as_str()).collect();
    let mut state = current.clone();
    let mut events = Vec::new();

    state
        .ignored
        .retain(|lifecycle| held_ids.contains(lifecycle.as_str()));
    state.active.retain(|lifecycle_id, lifecycle| {
        if held_ids.contains(lifecycle_id.as_str()) {
            return true;
        }
        events.push(PlannedEvent {
            lifecycle_id: lifecycle_id.clone(),
            lifecycle: lifecycle.clone(),
            kind: AgentEventKind::Ended,
            occurred_at: now,
        });
        false
    });

    for lock in held {
        if state.active.contains_key(&lock.lifecycle_id)
            || state.ignored.contains(&lock.lifecycle_id)
        {
            continue;
        }
        let Some(thread) = metadata.get(&lock.thread_id) else {
            continue;
        };
        if !thread.is_terminal() {
            state.ignored.insert(lock.lifecycle_id.clone());
            continue;
        }
        if thread.cwd.trim().is_empty() {
            continue;
        }
        let lifecycle = ActiveLifecycle {
            thread_id: lock.thread_id.clone(),
            started_at: lock.started_at,
            last_heartbeat_at: now,
            cwd: thread.cwd.clone(),
            model: thread
                .model
                .clone()
                .filter(|model| !model.trim().is_empty()),
        };
        events.push(PlannedEvent {
            lifecycle_id: lock.lifecycle_id.clone(),
            lifecycle: lifecycle.clone(),
            kind: AgentEventKind::Started,
            occurred_at: lifecycle.started_at,
        });
        if now > lifecycle.started_at {
            events.push(PlannedEvent {
                lifecycle_id: lock.lifecycle_id.clone(),
                lifecycle: lifecycle.clone(),
                kind: AgentEventKind::Heartbeat,
                occurred_at: now,
            });
        }
        state.active.insert(lock.lifecycle_id.clone(), lifecycle);
    }

    let mut model_updates = BTreeSet::new();
    for (lifecycle_id, lifecycle) in &mut state.active {
        if lifecycle.model.is_some() {
            continue;
        }
        let model = metadata
            .get(&lifecycle.thread_id)
            .filter(|thread| thread.is_terminal())
            .and_then(|thread| thread.model.as_deref())
            .map(str::trim)
            .filter(|model| !model.is_empty())
            .map(str::to_string);
        if let Some(model) = model {
            lifecycle.model = Some(model);
            model_updates.insert(lifecycle_id.clone());
        }
    }

    for (lifecycle_id, lifecycle) in &mut state.active {
        if events.iter().any(|event| {
            event.lifecycle_id == *lifecycle_id && event.kind == AgentEventKind::Started
        }) {
            continue;
        }
        if !model_updates.contains(lifecycle_id)
            && now.saturating_sub(lifecycle.last_heartbeat_at) < HEARTBEAT_INTERVAL_SECONDS
        {
            continue;
        }
        lifecycle.last_heartbeat_at = now;
        events.push(PlannedEvent {
            lifecycle_id: lifecycle_id.clone(),
            lifecycle: lifecycle.clone(),
            kind: AgentEventKind::Heartbeat,
            occurred_at: now,
        });
    }

    events.sort_by(|left, right| {
        (left.occurred_at, event_rank(left.kind), &left.lifecycle_id).cmp(&(
            right.occurred_at,
            event_rank(right.kind),
            &right.lifecycle_id,
        ))
    });
    ReconcilePlan { state, events }
}

fn event_rank(kind: AgentEventKind) -> u8 {
    match kind {
        AgentEventKind::Started => 0,
        AgentEventKind::Heartbeat => 1,
        AgentEventKind::Ended => 2,
    }
}

fn materialize_event(planned: &PlannedEvent) -> SpoolEvent {
    let cwd = Path::new(&planned.lifecycle.cwd);
    let started = planned.kind == AgentEventKind::Started;
    SpoolEvent {
        source: AgentSource::parse("codex").expect("codex is a canonical source"),
        external_session_id: planned.lifecycle_id.clone(),
        event: planned.kind,
        occurred_at: spool::format_iso8601(planned.occurred_at),
        cwd: Some(planned.lifecycle.cwd.clone()),
        start_head: started.then(|| git_evidence::head_sha(cwd)).flatten(),
        repo_root: started
            .then(|| git_evidence::repo_root(cwd))
            .flatten()
            .map(|root| root.to_string_lossy().into_owned()),
        repo_remote: started.then(|| git_evidence::repo_remote(cwd)).flatten(),
        model: planned.lifecycle.model.clone(),
        rule_id: None,
        transcript_path: None,
        tokens: None,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadPage {
    data: Vec<ThreadMetadata>,
    next_cursor: Option<String>,
}

async fn query_thread_metadata(
    wanted: &BTreeSet<String>,
) -> io::Result<BTreeMap<String, ThreadMetadata>> {
    let executable = crate::app_icons::running_executable_path("codex")
        .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "codex.exe" } else { "codex" }));
    let mut server = AppServer::start(&executable).await?;
    let result = server.thread_metadata(wanted).await;
    server.stop().await;
    result
}

struct AppServer {
    child: Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
    next_id: u64,
}

impl AppServer {
    async fn start(executable: &Path) -> io::Result<Self> {
        let mut command = Command::new(executable);
        command
            .args(["app-server", "--listen", "stdio://"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.as_std_mut().creation_flags(0x08000000);
        let mut child = command.spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("Codex app-server stdin is unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("Codex app-server stdout is unavailable"))?;
        let mut server = Self {
            child,
            stdin,
            stdout: BufReader::new(stdout).lines(),
            next_id: 1,
        };
        server
            .request(
                "initialize",
                serde_json::json!({
                    "clientInfo": { "name": "siqshift", "version": env!("CARGO_PKG_VERSION") }
                }),
            )
            .await?;
        server
            .send(serde_json::json!({ "jsonrpc": "2.0", "method": "initialized" }))
            .await?;
        Ok(server)
    }

    async fn thread_metadata(
        &mut self,
        wanted: &BTreeSet<String>,
    ) -> io::Result<BTreeMap<String, ThreadMetadata>> {
        let mut found = BTreeMap::new();
        let mut cursor: Option<String> = None;
        let mut seen_cursors = BTreeSet::new();
        loop {
            let result = self
                .request(
                    "thread/list",
                    serde_json::json!({
                        "cursor": cursor,
                        "limit": 100,
                        "sourceKinds": [
                            "cli", "vscode", "exec", "appServer", "subAgent",
                            "subAgentReview", "subAgentCompact", "subAgentThreadSpawn",
                            "subAgentOther", "unknown"
                        ],
                        "useStateDbOnly": true
                    }),
                )
                .await?;
            let page: ThreadPage = serde_json::from_value(result).map_err(io::Error::other)?;
            for thread in page.data {
                if wanted.contains(&thread.id) {
                    found.insert(thread.id.clone(), thread);
                }
            }
            if found.len() == wanted.len() {
                break;
            }
            let Some(next) = page.next_cursor else {
                break;
            };
            if !seen_cursors.insert(next.clone()) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Codex app-server repeated a pagination cursor",
                ));
            }
            cursor = Some(next);
        }
        Ok(found)
    }

    async fn request(&mut self, method: &str, params: Value) -> io::Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        }))
        .await?;
        loop {
            let line = tokio::time::timeout(APP_SERVER_TIMEOUT, self.stdout.next_line())
                .await
                .map_err(|_| {
                    io::Error::new(io::ErrorKind::TimedOut, "Codex app-server timed out")
                })??
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::UnexpectedEof, "Codex app-server closed")
                })?;
            let response: Value = serde_json::from_str(&line).map_err(io::Error::other)?;
            if response.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = response.get("error") {
                return Err(io::Error::other(format!("Codex app-server error: {error}")));
            }
            return response
                .get("result")
                .cloned()
                .ok_or_else(|| io::Error::other("Codex app-server response has no result"));
        }
    }

    async fn send(&mut self, value: Value) -> io::Result<()> {
        let mut bytes = serde_json::to_vec(&value).map_err(io::Error::other)?;
        bytes.push(b'\n');
        self.stdin.write_all(&bytes).await?;
        self.stdin.flush().await
    }

    async fn stop(mut self) {
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;

    fn held(thread_id: &str, lifecycle_id: &str, started_at: u64) -> HeldLock {
        HeldLock {
            thread_id: thread_id.to_string(),
            lifecycle_id: lifecycle_id.to_string(),
            started_at,
        }
    }

    fn metadata(id: &str, source: Value) -> ThreadMetadata {
        ThreadMetadata {
            id: id.to_string(),
            cwd: format!("C:/dev/{id}"),
            model: Some("gpt-test".to_string()),
            source,
        }
    }

    #[test]
    fn reconciliation_tracks_each_terminal_and_ignores_internal_threads() {
        let locks = vec![
            held("terminal-a", "terminal-a-1", 100),
            held("terminal-b", "terminal-b-1", 150),
            held("subagent", "subagent-1", 175),
        ];
        let metadata = BTreeMap::from([
            (
                "terminal-a".to_string(),
                metadata("terminal-a", Value::String("cli".to_string())),
            ),
            (
                "terminal-b".to_string(),
                metadata("terminal-b", Value::String("exec".to_string())),
            ),
            (
                "subagent".to_string(),
                metadata("subagent", serde_json::json!({ "subAgent": "review" })),
            ),
        ]);

        let first = plan_reconciliation(&ReconcileState::default(), &locks, &metadata, 200);

        assert_eq!(first.state.active.len(), 2);
        assert_eq!(
            first.state.ignored,
            BTreeSet::from(["subagent-1".to_string()])
        );
        assert_eq!(
            first
                .events
                .iter()
                .map(|event| event.kind)
                .collect::<Vec<_>>(),
            vec![
                AgentEventKind::Started,
                AgentEventKind::Started,
                AgentEventKind::Heartbeat,
                AgentEventKind::Heartbeat,
            ]
        );

        let steady = plan_reconciliation(&first.state, &locks, &BTreeMap::new(), 499);
        assert!(steady.events.is_empty());
        let heartbeat = plan_reconciliation(&steady.state, &locks, &BTreeMap::new(), 500);
        assert_eq!(
            heartbeat
                .events
                .iter()
                .map(|event| event.kind)
                .collect::<Vec<_>>(),
            vec![AgentEventKind::Heartbeat, AgentEventKind::Heartbeat]
        );

        let remaining = vec![held("terminal-b", "terminal-b-1", 150)];
        let ended = plan_reconciliation(&heartbeat.state, &remaining, &BTreeMap::new(), 510);
        assert_eq!(ended.state.active.len(), 1);
        assert_eq!(ended.events.len(), 1);
        assert_eq!(ended.events[0].kind, AgentEventKind::Ended);
        assert_eq!(ended.events[0].lifecycle_id, "terminal-a-1");
    }

    #[test]
    fn unresolved_metadata_never_invents_a_session_or_ends_a_held_one() {
        let lifecycle = ActiveLifecycle {
            thread_id: "known".to_string(),
            started_at: 100,
            last_heartbeat_at: 100,
            cwd: "C:/dev/known".to_string(),
            model: None,
        };
        let current = ReconcileState {
            version: STATE_VERSION,
            active: BTreeMap::from([("known-1".to_string(), lifecycle)]),
            ignored: BTreeSet::new(),
        };
        let locks = vec![
            held("known", "known-1", 100),
            held("unknown", "unknown-1", 120),
        ];

        let plan = plan_reconciliation(&current, &locks, &BTreeMap::new(), 200);

        assert_eq!(plan.state.active.len(), 1);
        assert!(!plan.state.active.contains_key("unknown-1"));
        assert!(plan.events.is_empty());
    }

    #[test]
    fn a_terminal_with_temporarily_missing_cwd_is_retried() {
        let lock = held("terminal", "terminal-1", 100);
        let mut thread = metadata("terminal", Value::String("cli".to_string()));
        thread.cwd.clear();

        let deferred = plan_reconciliation(
            &ReconcileState::default(),
            std::slice::from_ref(&lock),
            &BTreeMap::from([("terminal".to_string(), thread)]),
            200,
        );
        assert!(deferred.state.active.is_empty());
        assert!(deferred.state.ignored.is_empty());

        let retried = plan_reconciliation(
            &deferred.state,
            &[lock],
            &BTreeMap::from([(
                "terminal".to_string(),
                metadata("terminal", Value::String("cli".to_string())),
            )]),
            215,
        );
        assert_eq!(retried.state.active.len(), 1);
        assert_eq!(retried.events[0].kind, AgentEventKind::Started);
    }

    #[test]
    fn late_model_metadata_is_attested_on_the_next_heartbeat() {
        let lifecycle = ActiveLifecycle {
            thread_id: "known".to_string(),
            started_at: 100,
            last_heartbeat_at: 150,
            cwd: "C:/dev/known".to_string(),
            model: None,
        };
        let current = ReconcileState {
            version: STATE_VERSION,
            active: BTreeMap::from([("known-1".to_string(), lifecycle)]),
            ignored: BTreeSet::new(),
        };
        let locks = vec![held("known", "known-1", 100)];
        let metadata = BTreeMap::from([(
            "known".to_string(),
            metadata("known", Value::String("cli".to_string())),
        )]);

        let plan = plan_reconciliation(&current, &locks, &metadata, 450);

        assert_eq!(plan.events.len(), 1);
        assert_eq!(plan.events[0].kind, AgentEventKind::Heartbeat);
        assert_eq!(plan.events[0].lifecycle.model.as_deref(), Some("gpt-test"));
    }

    #[test]
    fn held_lock_scan_excludes_unlocked_and_non_thread_files() {
        let directory =
            std::env::temp_dir().join(format!("siqshift-codex-lock-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        let locks = directory.join("thread-writer-locks");
        std::fs::create_dir_all(&locks).expect("lock directory creates");
        let thread_id = "01999999-9999-7999-8999-999999999999";
        let held_path = locks.join(format!("{thread_id}.lock"));
        let held_file = File::create(&held_path).expect("held lock creates");
        held_file.try_lock().expect("held lock acquires");
        File::create(locks.join("01888888-8888-7888-8888-888888888888.lock"))
            .expect("unlocked file creates");
        File::create(locks.join(".coordination.lock")).expect("coordination lock creates");

        let found = held_writer_locks(&directory, u64::MAX).expect("lock scan succeeds");

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].thread_id, thread_id);
        held_file.unlock().expect("held lock releases");
        let _ = std::fs::remove_dir_all(&directory);
    }
}
