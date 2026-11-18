//! The evidence uploader: one Tokio task that wakes every five minutes (and
//! on demand when a session finishes, when the UI asks to sync now, and once
//! more before exit), uploads buffered activity segments, drains the
//! agent-event spool, and keeps agent-activity tracking in step with the
//! session-boundary tracker.
//!
//! Durability posture, same as the pending-stop queue: any failure — auth or
//! transport — backs off to the next tick with both spools untouched, so the
//! retry replays identical, idempotent payloads. Only per-row server
//! rejections, and registry rows past the bounds `upload_registry` states,
//! are dropped (a redacted count is logged, never the row).

use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::Notify;

use crate::agent_usage;
use crate::api::{
    AgentUsageUpload, ApiClient, ErrorKind, MappingKind, PathMapping, SegmentRejection,
    ShiftCommitUpload,
};
use crate::monitor::{
    advance_sessions, iso8601, lock, parse_iso8601, unix_now, ActiveAgent, AgentTracking,
    MonitorShared, ObservedSession, SeenAgentEvent, SegmentRecord,
};
use crate::shift_commits;
use crate::spool::{self, AgentEventKind, SpoolEvent};

/// The server's batch bound for both upload routes.
const UPLOAD_BATCH_SIZE: usize = 500;

/// Agent events cost the API about 43 ms each, one sequential write per event,
/// so `UPLOAD_BATCH_SIZE` of them needs roughly 22 s, past `ApiClient`'s 20 s
/// request timeout. A timed-out pass acknowledges nothing, so once a backlog
/// reached one full batch the drain could never finish one again and the spool
/// only grew: agent time stopped reaching the server entirely, while sessions
/// and segments kept uploading and hid it. Keep a batch inside the timeout with
/// room for a slow day (measured against production on 2026-08-29).
const AGENT_UPLOAD_BATCH_SIZE: usize = 100;

/// How many agent batches one pass drains. A backlog clears over a few passes
/// instead of holding the uploader for minutes.
const AGENT_BATCHES_PER_PASS: usize = 20;

/// Rows per shift-commit or usage request. Both routes write row by row, as
/// `/agent-sessions` does, so a batch of `UPLOAD_BATCH_SIZE` outruns the
/// client's request timeout for the same reason `AGENT_UPLOAD_BATCH_SIZE`
/// states, and a timed-out request ends the pass.
const REGISTRY_UPLOAD_BATCH_SIZE: usize = 100;

/// How many shift-commit or usage requests one pass sends. A backlog clears
/// over a few passes, newest rows first, instead of holding the uploader for
/// as long as the backlog is deep.
const REGISTRY_BATCHES_PER_PASS: usize = 10;

/// How many `unknown_session` answers a shift commit or usage row gets before
/// it is given up. Either registry uploads only in a pass that emptied the
/// agent spools, so the session a row names has already been sent; a row the
/// server still answers this way names a session it refused or one held where
/// this upload cannot reach, and the extra answers allow for one landing late.
pub(crate) const UNKNOWN_SESSION_ATTEMPT_LIMIT: u32 = 12;

/// The server's retention window, `RETENTION_DAYS` in
/// `apps/api/src/services/utc-days.ts`: it refuses agent events older than
/// this and sweeps raw evidence past it, so a row still unsynced at that age
/// has nothing left to land on that a bounded report would read.
const SERVER_RETENTION_SECONDS: u64 = 90 * 24 * 60 * 60;

/// Five minutes: frequent enough to keep the server current without making
/// the monitor noisy. Local agent events are replayed on every monitor poll.
const UPLOAD_INTERVAL_SECONDS: u64 = 300;

/// Every path an upload pass touches, bundled so `upload_loop`/`upload_once`
/// take one argument instead of one per spool or sidecar.
pub struct UploadPaths {
    pub segments_path: PathBuf,
    pub agent_path: PathBuf,
    pub sessions_path: PathBuf,
    pub shift_windows_path: PathBuf,
    pub shift_commits_path: PathBuf,
    pub agent_usage_path: PathBuf,
}

/// A row of a registry the uploader drains by verdict: a shift commit or a
/// usage entry.
pub(crate) trait RegistryRow: Clone + PartialEq {
    fn client_id(&self) -> &str;
    /// When the evidence the row carries happened, in unix seconds.
    fn happened_at(&self) -> Option<u64>;
    fn unknown_session_attempts(&self) -> u32;
    /// The row's `synced` and `rejected` flags and `unknown_session` count.
    fn verdict_state(&mut self) -> (&mut bool, &mut bool, &mut u32);
}

/// Every verdict one pass received for a registry's rows, recorded in one
/// registry write.
#[derive(Debug)]
pub(crate) struct UploadVerdicts<Row> {
    /// Accepted rows, as they were sent.
    accepted: HashMap<String, Row>,
    unknown_session: HashSet<String>,
    /// Rejected permanently, or too old for the server to keep.
    rejected: HashSet<String>,
}

impl<Row> Default for UploadVerdicts<Row> {
    fn default() -> Self {
        Self {
            accepted: HashMap::new(),
            unknown_session: HashSet::new(),
            rejected: HashSet::new(),
        }
    }
}

impl<Row: RegistryRow> UploadVerdicts<Row> {
    /// Takes the server's answer to one request. Returns how many rows it
    /// rejected permanently.
    pub(crate) fn absorb(&mut self, sent: &[Row], rejections: &[SegmentRejection]) -> usize {
        let reasons: HashMap<&str, &str> = rejections
            .iter()
            .map(|rejection| (rejection.client_id.as_str(), rejection.reason.as_str()))
            .collect();
        let mut permanent = 0;
        for row in sent {
            let client_id = row.client_id().to_string();
            match reasons.get(row.client_id()) {
                None => {
                    self.accepted.insert(client_id, row.clone());
                }
                Some(&"unknown_session") => {
                    self.unknown_session.insert(client_id);
                }
                Some(_) => {
                    self.rejected.insert(client_id);
                    permanent += 1;
                }
            }
        }
        permanent
    }

    fn expire(&mut self, rows: &[Row]) {
        self.rejected
            .extend(rows.iter().map(|row| row.client_id().to_string()));
    }

    fn len(&self) -> usize {
        self.accepted.len() + self.unknown_session.len() + self.rejected.len()
    }

    fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Records this pass's verdict on one registry row. An accepted row is
    /// synced only while it is still what was sent: one that changed since (a
    /// total restated upward, a commit verified) sends its new state next pass.
    /// Returns whether this verdict gave the row up.
    pub(crate) fn apply(&self, row: &mut Row) -> bool {
        let is_accepted_as_is = self.accepted.get(row.client_id()).map(|sent| sent == row);
        let is_rejected = self.rejected.contains(row.client_id());
        let is_unknown_session = self.unknown_session.contains(row.client_id());
        let (synced, rejected, unknown_session_attempts) = row.verdict_state();
        match is_accepted_as_is {
            Some(true) => {
                *synced = true;
                *unknown_session_attempts = 0;
                false
            }
            Some(false) => false,
            None if is_rejected => {
                *rejected = true;
                false
            }
            None if is_unknown_session => {
                *unknown_session_attempts = unknown_session_attempts.saturating_add(1);
                if *unknown_session_attempts >= UNKNOWN_SESSION_ATTEMPT_LIMIT {
                    *rejected = true;
                    return true;
                }
                false
            }
            None => false,
        }
    }
}

pub async fn upload_loop(
    shared: Arc<Mutex<MonitorShared>>,
    client: ApiClient,
    paths: UploadPaths,
    upload_now: Arc<Notify>,
) {
    let mut tick = tokio::time::interval(Duration::from_secs(UPLOAD_INTERVAL_SECONDS));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = tick.tick() => {}
            _ = upload_now.notified() => {}
        }
        upload_once(&shared, &client, &paths).await;
    }
}

/// One upload pass. Returns as soon as anything is unreachable; whatever was
/// not acknowledged stays in its spool for the next pass. Also the exit
/// flush: the monitor runs one bounded pass before the process quits.
pub(crate) async fn upload_once(
    shared: &Arc<Mutex<MonitorShared>>,
    client: &ApiClient,
    paths: &UploadPaths,
) {
    // Signed out: leave both spools for a session that can upload them.
    let Some(session) = crate::read_session_token() else {
        return;
    };
    let Ok(token) = client.fetch_access_token(&session).await else {
        return;
    };

    // Turns any newly-closed shift into shift-commit rows before this pass
    // uploads them. Reads the agent spool without truncating it, so it never
    // races the agent-spool drain below.
    shift_commits::capture_from_spool(
        &paths.agent_path,
        &paths.shift_windows_path,
        &paths.shift_commits_path,
    )
    .await;

    // Same posture for token capture: the transcript reader tails what the
    // spool named, on every platform, from this same pass. The settings
    // opt-out stops the reader; counters already captured are kept.
    if lock(shared).settings.agent_usage_capture {
        agent_usage::capture_from_spool(&paths.agent_path, &paths.agent_usage_path);
    }

    let mut complete = upload_segments(client, &token, &paths.segments_path).await;

    // Refresh the local mapping cache before the drain resolves suggestions.
    // A failed refresh keeps last pass's cache — stale mappings beat none.
    if let Ok(mappings) = client.path_mappings(&token).await {
        crate::monitor::set_mappings(shared, mappings);
    } else {
        complete = false;
    }

    // Keep the browser collection admitted: the authorization expires after
    // ten minutes and this pass runs every five. Best-effort, like the rest of
    // the maintenance — a stale or absent collection just reports disabled.
    if let Err(error) = crate::browser::renew_collection_authorization(&spool::browser_dir()) {
        eprintln!(
            "siqshift: could not renew browser attribution: {}",
            error.message
        );
    }

    let agent_spool_drained = upload_agent_spool(client, &token, &paths.agent_path).await;
    let browser_spool_drained = upload_agent_spool(
        client,
        &token,
        &spool::browser_dir().join("browser-spool.jsonl"),
    )
    .await;
    complete &= agent_spool_drained;
    complete &= browser_spool_drained;
    complete &= upload_sessions(client, &token, &paths.sessions_path).await;

    // Shift commits reference an agent session by external id; uploading them
    // before this pass has emptied both agent spools would race a session that
    // has not reached the server yet. Usage counters carry the
    // same reference, so they wait on the same gate.
    if agent_spool_drained && browser_spool_drained {
        let now = unix_now();
        complete &=
            upload_shift_commits_spool(client, &token, &paths.shift_commits_path, now).await;
        complete &= upload_agent_usage_spool(client, &token, &paths.agent_usage_path, now).await;
    }

    if complete {
        lock(shared).last_upload_at = Some(iso8601(unix_now()));
    }
}

/// Uploads every buffered segment in batches, then truncates the acked
/// prefix. A mid-batch failure skips the truncation, so the whole spool
/// replays next pass — safe because `clientId` makes replays idempotent.
async fn upload_segments(client: &ApiClient, token: &str, path: &Path) -> bool {
    let Ok((records, acked_bytes)) = spool::read_pending_lines::<SegmentRecord>(path) else {
        return false;
    };
    if records.is_empty() {
        return true;
    }
    for chunk in records.chunks(UPLOAD_BATCH_SIZE) {
        match client.upload_segments(token, chunk).await {
            Ok(outcome) => {
                // Rejected rows failed permanent validation; retrying them
                // would reject forever, so they are dropped with the ack.
                if !outcome.rejected.is_empty() {
                    eprintln!(
                        "siqshift: the server rejected {} activity segment(s); dropping them",
                        outcome.rejected.len()
                    );
                }
            }
            Err(_) => return false,
        }
    }
    spool::truncate_acked(path, acked_bytes).is_ok()
}

/// Uploads finished sessions in batches, then truncates the acked prefix. A
/// mid-batch failure skips the truncation, so the spool replays next pass —
/// safe because the server ignores client ids it already stored.
async fn upload_sessions(client: &ApiClient, token: &str, path: &Path) -> bool {
    let Ok((sessions, acked_bytes)) = spool::read_pending_lines::<ObservedSession>(path) else {
        return false;
    };
    if sessions.is_empty() {
        return true;
    }
    for chunk in sessions.chunks(UPLOAD_BATCH_SIZE) {
        match client.upload_observed_sessions(token, chunk).await {
            Ok(rejected) => {
                // A rejected row failed permanent validation; retrying it would
                // reject forever, so it is dropped with the ack.
                if rejected > 0 {
                    eprintln!("siqshift: the server rejected {rejected} session(s); dropping them");
                }
            }
            Err(_) => return false,
        }
    }
    spool::truncate_acked(path, acked_bytes).is_ok()
}

/// Drains the spool a batch at a time, acknowledging each batch before reading
/// the next, so a pass that fails part-way keeps what the server already took
/// instead of replaying, and re-failing, the whole backlog.
///
/// Bounded per pass rather than looped to empty, because `truncate_acked`
/// deliberately leaves a spool that rotated between the read and the ack alone:
/// a fixed number of batches cannot spin on one, and the next pass carries on.
///
/// Returns whether the spool is empty. A pass that stops at its bound with
/// events left reports false, so nothing that names their sessions uploads
/// ahead of them. An event the server refuses inside an answered batch is
/// acknowledged like any other. A batch the server refuses whole as invalid is
/// sent again one event at a time, each send counting against the bound, and
/// an event refused as invalid on its own is dropped, so one malformed event
/// never keeps the spool from emptying. Any other failure keeps the event for
/// the next pass.
async fn upload_agent_spool(client: &ApiClient, token: &str, path: &Path) -> bool {
    let mut events_to_send_alone = 0;
    let mut dropped = 0;
    let is_drained = 'pass: {
        for _ in 0..AGENT_BATCHES_PER_PASS {
            let batch_size = if events_to_send_alone > 0 {
                1
            } else {
                AGENT_UPLOAD_BATCH_SIZE
            };
            let pending = match spool::read_pending_batch(path, batch_size) {
                Ok(pending) => pending,
                Err(_) => break 'pass false,
            };
            if pending.events.is_empty() {
                break 'pass true;
            }

            // `startHead` is a spool-local field the shift-capture sidecar
            // reads; the server's agent-session contract has no such field, so
            // it never leaves the machine.
            let mut events = pending.events;
            for event in &mut events {
                event.start_head = None;
            }

            match client.upload_agent_events(token, &events).await {
                Ok(results) => {
                    let rejected = results.iter().filter(|result| !result.accepted).count();
                    if rejected > 0 {
                        eprintln!("siqshift: the server rejected {rejected} agent event(s)");
                    }
                }
                Err(error) if error.kind == ErrorKind::Validation => {
                    if events_to_send_alone == 0 {
                        events_to_send_alone = events.len();
                        continue;
                    }
                    dropped += 1;
                }
                Err(_) => break 'pass false,
            }
            events_to_send_alone = events_to_send_alone.saturating_sub(1);
            if spool::truncate_acked(path, pending.acked_bytes).is_err() {
                break 'pass false;
            }
        }
        spool::read_pending_batch(path, 1).is_ok_and(|pending| pending.events.is_empty())
    };
    if dropped > 0 {
        eprintln!(
            "siqshift: the server refused {dropped} agent event(s) as invalid; dropping them"
        );
    }
    is_drained
}

/// Uploads the shift commits this pass sends, under the rules
/// `upload_registry` states.
async fn upload_shift_commits_spool(
    client: &ApiClient,
    token: &str,
    shift_commits_path: &Path,
    now: u64,
) -> bool {
    upload_registry(
        "shift commit",
        shift_commits::unsynced(shift_commits_path),
        now,
        |chunk: &[shift_commits::CommitEntry]| {
            let uploads: Vec<ShiftCommitUpload> =
                chunk.iter().map(to_shift_commit_upload).collect();
            async move {
                client
                    .upload_shift_commits(token, &uploads)
                    .await
                    .map(|outcome| outcome.rejected)
            }
        },
        |verdicts| shift_commits::record_verdicts(shift_commits_path, verdicts),
    )
    .await
}

fn to_shift_commit_upload(entry: &crate::shift_commits::CommitEntry) -> ShiftCommitUpload {
    ShiftCommitUpload {
        client_id: entry.client_id.clone(),
        source: entry.source.clone(),
        external_session_id: entry.external_session_id.clone(),
        repo_root: entry.repo_root.clone(),
        branch: entry.branch.clone(),
        sha: entry.sha.clone(),
        subject: entry.subject.clone(),
        authored_at: entry.authored_at.clone(),
        verification: entry.verification.clone(),
        verified_at: entry.verified_at.clone(),
    }
}

/// Uploads the usage entries this pass sends, under the rules
/// `upload_registry` states.
async fn upload_agent_usage_spool(
    client: &ApiClient,
    token: &str,
    agent_usage_path: &Path,
    now: u64,
) -> bool {
    upload_registry(
        "agent usage row",
        agent_usage::unsynced(agent_usage_path),
        now,
        |chunk: &[agent_usage::UsageEntry]| {
            let uploads: Vec<AgentUsageUpload> = chunk.iter().map(to_agent_usage_upload).collect();
            async move {
                client
                    .upload_agent_usage(token, &uploads)
                    .await
                    .map(|outcome| outcome.rejected)
            }
        },
        |verdicts| agent_usage::record_verdicts(agent_usage_path, verdicts),
    )
    .await
}

/// One registry's upload for one pass: the shift commits or the usage entries
/// without a final verdict.
///
/// - A row older than the server's retention window is never sent; it is
///   settled as rejected.
/// - Rows go out fewest `unknown_session` answers first and newest first within
///   that, at most `REGISTRY_BATCHES_PER_PASS` requests a pass. A backlog the
///   server keeps refusing therefore never holds back a new row, and a pass that
///   ends early on a transport error has already sent the newest ones.
/// - Accepted rows (replays the server already had included) are synced, other
///   rejections are permanent, and `unknown_session` is retryable: the shift
///   may land later. After `UNKNOWN_SESSION_ATTEMPT_LIMIT` such answers the row
///   is settled as rejected, since a session that has not landed by then lives
///   where this upload cannot reach, such as the workspace an account switch
///   left behind.
/// - Every verdict the pass received, a failed request's predecessors included,
///   is recorded in one registry write at the end. A write that fails is
///   logged and leaves the rows unsynced, so the next pass sends them again and
///   records the server's (idempotent) answer then.
async fn upload_registry<Row, SendBatch, Sent>(
    noun: &str,
    pending: spool::SpoolResult<Vec<Row>>,
    now: u64,
    send: SendBatch,
    record: impl FnOnce(&UploadVerdicts<Row>) -> spool::SpoolResult<usize>,
) -> bool
where
    Row: RegistryRow,
    SendBatch: Fn(&[Row]) -> Sent,
    Sent: std::future::Future<Output = crate::api::ApiResult<Vec<SegmentRejection>>>,
{
    let pending = match pending {
        Ok(pending) => pending,
        Err(error) => {
            eprintln!("siqshift: could not read the unsynced {noun}s: {error}");
            return false;
        }
    };
    if pending.is_empty() {
        return true;
    }

    let retention_floor = now.saturating_sub(SERVER_RETENTION_SECONDS);
    let (expired, mut sendable): (Vec<Row>, Vec<Row>) = pending
        .into_iter()
        .partition(|row| row.happened_at().is_some_and(|at| at < retention_floor));
    sendable.sort_by_key(|row| (row.unknown_session_attempts(), Reverse(row.happened_at())));

    let mut verdicts = UploadVerdicts::default();
    verdicts.expire(&expired);
    let mut complete = true;
    let mut permanent = 0;
    for chunk in sendable
        .chunks(REGISTRY_UPLOAD_BATCH_SIZE)
        .take(REGISTRY_BATCHES_PER_PASS)
    {
        match send(chunk).await {
            Ok(rejections) => permanent += verdicts.absorb(chunk, &rejections),
            Err(_) => {
                complete = false;
                break;
            }
        }
    }

    if !expired.is_empty() {
        eprintln!(
            "siqshift: {} {noun}(s) are older than the server keeps; not sending them",
            expired.len()
        );
    }
    if permanent > 0 {
        eprintln!("siqshift: the server rejected {permanent} {noun}(s)");
    }
    if verdicts.is_empty() {
        return complete;
    }
    match record(&verdicts) {
        Ok(0) => {}
        Ok(given_up) => eprintln!(
            "siqshift: gave up on {given_up} {noun}(s) whose session the server never held"
        ),
        Err(error) => {
            eprintln!(
                "siqshift: could not record the server's verdicts on {} {noun}(s); they stay unsynced and are sent again next pass: {error}",
                verdicts.len()
            );
            complete = false;
        }
    }
    complete
}

fn to_agent_usage_upload(entry: &agent_usage::UsageEntry) -> AgentUsageUpload {
    AgentUsageUpload {
        client_id: entry.client_id.clone(),
        source: entry.source.clone(),
        external_session_id: entry.external_session_id.clone(),
        bucket_start_at: entry.bucket_start_at.clone(),
        model: entry.model.clone(),
        sidechain: entry.sidechain,
        input_tokens: entry.input_tokens,
        output_tokens: entry.output_tokens,
        cache_creation_input_tokens: entry.cache_creation_input_tokens,
        cache_read_input_tokens: entry.cache_read_input_tokens,
    }
}

/// Replays every unseen event at its own timestamp, bracketing the lifecycle
/// update with tracker ticks. A short agent run between uploader passes then
/// still creates the right project boundaries instead of collapsing to its
/// final state.
pub fn replay_agent_spool(shared: &Arc<Mutex<MonitorShared>>, path: &Path) -> Vec<ObservedSession> {
    let Ok(pending) = spool::read_pending(path) else {
        return Vec::new();
    };
    replay_agent_events(shared, &pending.events)
}

pub fn replay_agent_events(
    shared: &Arc<Mutex<MonitorShared>>,
    events: &[SpoolEvent],
) -> Vec<ObservedSession> {
    let mut ordered: Vec<(u64, &SpoolEvent)> = events
        .iter()
        .filter_map(|event| parse_iso8601(&event.occurred_at).map(|at| (at, event)))
        .collect();
    ordered.sort_by(|(left_at, left), (right_at, right)| {
        (
            left_at,
            left.source.as_str(),
            &left.external_session_id,
            event_rank(left.event),
        )
            .cmp(&(
                right_at,
                right.source.as_str(),
                &right.external_session_id,
                event_rank(right.event),
            ))
    });

    let mut finished = Vec::new();
    let mut shared = lock(shared);
    for (at, event) in ordered {
        if !agent_event_is_new(event, at, &shared.agent) {
            continue;
        }
        let can_replay_boundary = shared
            .tracker
            .open_session()
            .is_none_or(|open| at >= open.last_active_at);
        if can_replay_boundary {
            finished.extend(advance_sessions(&mut shared, at));
        }
        let mappings = shared.mappings.clone();
        track_agent_event(event, at, &mappings, &mut shared.agent);
        if can_replay_boundary {
            finished.extend(advance_sessions(&mut shared, at));
        }
    }
    finished
}

/// The drain's local bookkeeping. Replays are idempotent per agent lifecycle:
/// a source plus external session id owns exactly one active marker.
#[cfg(test)]
pub fn track_agent_events(
    events: &[SpoolEvent],
    mappings: &[PathMapping],
    tracking: &mut AgentTracking,
) {
    let mut ordered: Vec<(u64, &SpoolEvent)> = events
        .iter()
        .filter_map(|event| parse_iso8601(&event.occurred_at).map(|at| (at, event)))
        .collect();
    ordered.sort_by(|(left_at, left), (right_at, right)| {
        (
            left_at,
            left.source.as_str(),
            &left.external_session_id,
            event_rank(left.event),
        )
            .cmp(&(
                right_at,
                right.source.as_str(),
                &right.external_session_id,
                event_rank(right.event),
            ))
    });

    for (at, event) in ordered {
        track_agent_event(event, at, mappings, tracking);
    }
}

fn agent_key(event: &SpoolEvent) -> (String, String) {
    (
        event.source.as_str().to_string(),
        event.external_session_id.clone(),
    )
}

fn event_rank(kind: AgentEventKind) -> u8 {
    match kind {
        AgentEventKind::Started => 0,
        AgentEventKind::Heartbeat => 1,
        AgentEventKind::Ended => 2,
    }
}

fn agent_event_is_new(event: &SpoolEvent, at: u64, tracking: &AgentTracking) -> bool {
    let key = agent_key(event);
    tracking.seen.get(&key).is_none_or(|seen| {
        (at, event_rank(event.event)) > (seen.occurred_at, event_rank(seen.kind))
    })
}

fn track_agent_event(
    event: &SpoolEvent,
    at: u64,
    mappings: &[PathMapping],
    tracking: &mut AgentTracking,
) {
    if !agent_event_is_new(event, at, tracking) {
        return;
    }
    let key = agent_key(event);
    let source = event.source.as_str().to_string();
    tracking.last_event_at = tracking.last_event_at.max(at);
    match event.event {
        AgentEventKind::Started => {
            tracking.active.insert(
                key.clone(),
                ActiveAgent {
                    source,
                    external_session_id: event.external_session_id.clone(),
                    started_at: at,
                    last_event_at: at,
                    project: event
                        .cwd
                        .as_deref()
                        .and_then(|cwd| resolve_project(cwd, mappings)),
                },
            );
        }
        AgentEventKind::Heartbeat => {
            let resolved = event
                .cwd
                .as_deref()
                .and_then(|cwd| resolve_project(cwd, mappings));
            let active = tracking
                .active
                .entry(key.clone())
                .or_insert_with(|| ActiveAgent {
                    source,
                    external_session_id: event.external_session_id.clone(),
                    started_at: at,
                    last_event_at: at,
                    project: resolved.clone(),
                });
            active.last_event_at = at;
            if let Some(project) = resolved {
                active.project = Some(project);
            }
        }
        AgentEventKind::Ended => {
            tracking.active.remove(&key);
        }
    }
    tracking.seen.insert(
        key,
        SeenAgentEvent {
            occurred_at: at,
            kind: event.event,
        },
    );
}

/// Lowercases, unifies separators to `/`, and strips trailing separators —
/// the same normalization the server's attribution service applies, so a
/// local suggestion never names a project the server would reject.
pub fn normalize_path(value: &str) -> String {
    value
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

/// A prefix matches only on a path-segment boundary: `c:/dev/siqshift` matches
/// `c:/dev/siqshift` and `c:/dev/siqshift/src` but never `c:/dev/siqshift-extra`.
fn matches_boundary(cwd: &str, prefix: &str) -> bool {
    if prefix.is_empty() {
        return cwd.starts_with('/');
    }
    cwd == prefix
        || cwd
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// Resolves a working directory to a project by normalized longest-prefix
/// match. Equal-length ties are ambiguous and resolve to nothing, unless
/// every winner names the same project — the server's rule, mirrored.
pub fn resolve_project(cwd: &str, mappings: &[PathMapping]) -> Option<String> {
    let cwd = normalize_path(cwd);
    let mut best: Vec<&PathMapping> = Vec::new();
    let mut best_length: Option<usize> = None;
    for mapping in mappings {
        // URL rules match browser tabs, never an agent's working directory;
        // running them through the path-prefix matcher would file `cwd` under
        // a website pattern. Only path-prefix mappings participate here.
        if mapping.kind != MappingKind::PathPrefix {
            continue;
        }
        let prefix = normalize_path(&mapping.path_prefix);
        if !matches_boundary(&cwd, &prefix) {
            continue;
        }
        match best_length {
            Some(length) if length > prefix.len() => {}
            Some(length) if length == prefix.len() => best.push(mapping),
            _ => {
                best_length = Some(prefix.len());
                best.clear();
                best.push(mapping);
            }
        }
    }
    let project_ids: std::collections::BTreeSet<&str> = best
        .iter()
        .map(|mapping| mapping.project_id.as_str())
        .collect();
    if project_ids.len() == 1 {
        best.first().map(|mapping| mapping.project_id.clone())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;
    use crate::monitor::SegmentKind;

    /// A scratch directory per test; spool paths must not collide.
    fn temp_dir(name: &str) -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let unique = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "siqshift-uploader-{name}-{}-{unique}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("the scratch directory is creatable");
        dir
    }

    /// A loopback HTTP stub that serves exactly one request. The join handle
    /// yields the raw request, so a test can assert on the bytes the desktop
    /// actually put on the wire rather than on what it meant to send.
    async fn stub_server(
        status: u16,
        body: &'static str,
    ) -> (u16, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("the loopback stub binds");
        let port = listener
            .local_addr()
            .expect("the stub has an address")
            .port();
        let handle = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("the stub accepts");
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4_096];
            loop {
                let read = stream.read(&mut buffer).await.expect("the stub reads");
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
                // Stop at the end of the body rather than at EOF: reqwest keeps
                // the connection open, so waiting for a close would hang.
                if let Some(head_end) = find_head_end(&request) {
                    let length = content_length(&request[..head_end]);
                    if request.len() >= head_end + length {
                        break;
                    }
                }
            }
            let response = format!(
                "HTTP/1.1 {status} STUB\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream
                .write_all(response.as_bytes())
                .await
                .expect("the stub answers");
            stream.flush().await.expect("the stub flushes");
            String::from_utf8_lossy(&request).into_owned()
        });
        (port, handle)
    }

    /// Byte offset just past the blank line that ends the request head.
    fn find_head_end(request: &[u8]) -> Option<usize> {
        request
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|index| index + 4)
    }

    fn content_length(head: &[u8]) -> usize {
        String::from_utf8_lossy(head)
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())?
            })
            .unwrap_or(0)
    }

    fn stub_client(port: u16) -> ApiClient {
        ApiClient::new(
            format!("http://127.0.0.1:{port}/auth"),
            format!("http://127.0.0.1:{port}"),
        )
        .expect("the stub client builds")
    }

    /// One spooled segment, exactly as `append_segment_line` writes it.
    fn spool_one_segment(path: &Path) {
        let record = SegmentRecord {
            client_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301".to_string(),
            device_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7".to_string(),
            kind: SegmentKind::Active,
            process_name: Some("chrome.exe".to_string()),
            started_at: "2026-08-11T15:38:00Z".to_string(),
            ended_at: "2026-08-11T15:40:00Z".to_string(),
        };
        let mut line = serde_json::to_vec(&record).expect("the record encodes");
        line.push(b'\n');
        spool::append_line(path, &line, spool::MAX_SPOOL_BYTES).expect("the spool accepts a line");
    }

    /// The link nothing covered: a spooled segment has to reach
    /// `/activity/segments` in the shape the contract accepts, and leave the
    /// spool only once the server has taken it.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_accepted_segment_reaches_the_activity_endpoint_and_leaves_the_spool() {
        let dir = temp_dir("accepted");
        let path = dir.join("segments-spool.jsonl");
        spool_one_segment(&path);

        let (port, server) = stub_server(200, r#"{"accepted":1,"rejected":[]}"#).await;
        assert!(
            upload_segments(&stub_client(port), "token", &path).await,
            "an accepted batch reports success"
        );

        let request = server.await.expect("the stub finishes");
        assert!(
            request.starts_with("POST /activity/segments "),
            "the batch goes to the segment endpoint: {request}"
        );
        assert!(
            request.contains("\"deviceId\":\"7c9e6679-7425-40de-944b-e07fc1f90ae7\""),
            "the wire payload carries the device id: {request}"
        );
        assert!(
            request.contains("\"kind\":\"active\"")
                && request.contains("\"processName\":\"chrome.exe\""),
            "the wire payload carries the contract's field names: {request}"
        );

        let (pending, _) =
            spool::read_pending_lines::<SegmentRecord>(&path).expect("the spool reads");
        assert!(pending.is_empty(), "an accepted batch leaves the spool");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// One spooled finished session, exactly as `append_session_line` writes it.
    fn spool_one_session(path: &Path) {
        let session = ObservedSession {
            client_id: "ac1da70b-d921-42ec-8f8f-03a0cdd5be01".to_string(),
            project_id: "2c8ce697-8011-4c66-9421-7fc83d39cb92".to_string(),
            attribution: crate::monitor::Attribution::Default,
            started_at: "2026-08-12T13:36:06Z".to_string(),
            stopped_at: "2026-08-12T13:36:36Z".to_string(),
            idle_seconds: 0,
        };
        let mut line = serde_json::to_vec(&session).expect("the session encodes");
        line.push(b'\n');
        spool::append_line(path, &line, spool::MAX_SPOOL_BYTES).expect("the spool accepts a line");
    }

    /// The regression that stranded a real session on disk: a finished
    /// session in the spool must reach `/sessions/observed` on the next pass
    /// and leave the spool once the server has taken it.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_accepted_session_reaches_the_observed_endpoint_and_leaves_the_spool() {
        let dir = temp_dir("session-accepted");
        let path = dir.join("sessions-spool.jsonl");
        spool_one_session(&path);

        let (port, server) = stub_server(200, r#"{"accepted":1,"rejected":[]}"#).await;
        assert!(
            upload_sessions(&stub_client(port), "token", &path).await,
            "an accepted batch reports success"
        );

        let request = server.await.expect("the stub finishes");
        assert!(
            request.starts_with("POST /sessions/observed "),
            "the batch goes to the observed-session endpoint: {request}"
        );
        assert!(
            request.contains("\"attribution\":\"default\"")
                && request.contains("\"startedAt\":\"2026-08-12T13:36:06Z\""),
            "the wire payload carries the contract's field names: {request}"
        );

        let (pending, _) =
            spool::read_pending_lines::<ObservedSession>(&path).expect("the spool reads");
        assert!(pending.is_empty(), "an accepted batch leaves the spool");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A refused session batch keeps the evidence for the next pass, exactly
    /// like segments.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_refused_session_batch_stays_spooled() {
        let dir = temp_dir("session-refused");
        let path = dir.join("sessions-spool.jsonl");
        spool_one_session(&path);

        let (port, server) = stub_server(500, r#"{"code":"internal_error"}"#).await;
        assert!(
            !upload_sessions(&stub_client(port), "token", &path).await,
            "a refused batch reports failure"
        );
        let _ = server.await;

        let (pending, _) =
            spool::read_pending_lines::<ObservedSession>(&path).expect("the spool reads");
        assert_eq!(pending.len(), 1, "a refused batch stays spooled");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A refusal must keep the evidence. This is also the shape of the silent
    /// stall: the spool grows, nothing reaches the server, and the only
    /// outward sign is the backlog counter.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_refused_batch_keeps_every_segment_for_the_next_pass() {
        let dir = temp_dir("refused");
        let path = dir.join("segments-spool.jsonl");
        spool_one_segment(&path);

        let (port, server) = stub_server(400, r#"{"code":"validation_error"}"#).await;
        assert!(
            !upload_segments(&stub_client(port), "token", &path).await,
            "a refused batch reports failure"
        );
        let _ = server.await;

        let (pending, _) =
            spool::read_pending_lines::<SegmentRecord>(&path).expect("the spool reads");
        assert_eq!(pending.len(), 1, "a refused batch stays spooled");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The moment the fixed-date fixtures upload at, inside the server's
    /// retention window for every one of them.
    fn fixture_now() -> u64 {
        parse_iso8601("2026-08-20T00:00:00Z").expect("the fixture time parses")
    }

    fn source(id: &str) -> spool::AgentSource {
        spool::AgentSource::parse(id).expect("the test names a well-shaped runtime")
    }

    fn one_commit_entry(client_id: &str, sha: &str) -> crate::shift_commits::CommitEntry {
        crate::shift_commits::CommitEntry {
            client_id: client_id.to_string(),
            source: source("claude_code"),
            external_session_id: "s1".to_string(),
            repo_root: "C:/dev/siqshift".to_string(),
            branch: Some("main".to_string()),
            sha: sha.to_string(),
            subject: "did work".to_string(),
            authored_at: "2026-08-11T15:38:00Z".to_string(),
            verification: "pending".to_string(),
            verified_at: None,
            synced: false,
            rejected: false,
            unknown_session_attempts: 0,
        }
    }

    fn spool_one_shift_commit(path: &Path, client_id: &str, sha: &str) {
        let entries = vec![one_commit_entry(client_id, sha)];
        let bytes = serde_json::to_vec(&entries).expect("the registry encodes");
        std::fs::write(path, bytes).expect("the registry writes");
    }

    fn read_shift_commits(path: &Path) -> Vec<crate::shift_commits::CommitEntry> {
        serde_json::from_slice(&std::fs::read(path).expect("the registry reads"))
            .expect("the registry decodes")
    }

    /// An accepted shift commit reaches `/shift-commits` in the contract's
    /// shape and is marked synced, dropping it from the unsynced set.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_accepted_shift_commit_reaches_the_endpoint_and_is_marked_synced() {
        let dir = temp_dir("shift-commit-accepted");
        let path = dir.join("shift-commits.json");
        let sha = "a".repeat(40);
        spool_one_shift_commit(&path, "client-1", &sha);

        let (port, server) = stub_server(200, r#"{"accepted":1,"rejected":[]}"#).await;
        assert!(
            upload_shift_commits_spool(&stub_client(port), "token", &path, fixture_now()).await,
            "an accepted batch reports success"
        );

        let request = server.await.expect("the stub finishes");
        assert!(
            request.starts_with("POST /shift-commits "),
            "the batch goes to the shift-commits endpoint: {request}"
        );
        assert!(
            request.contains("\"clientId\":\"client-1\"")
                && request.contains(&format!("\"sha\":\"{sha}\""))
                && request.contains("\"repoRoot\":\"C:/dev/siqshift\"")
                && request.contains("\"externalSessionId\":\"s1\""),
            "the wire payload carries the contract's field names: {request}"
        );

        assert!(
            shift_commits::unsynced(&path)
                .expect("the registry reads")
                .is_empty(),
            "an accepted commit is marked synced"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `unknown_session` is retryable: the row stays unsynced (and
    /// unrejected) so it uploads again once the shift itself has landed.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_unknown_session_rejection_survives_as_unsynced() {
        let dir = temp_dir("shift-commit-unknown-session");
        let path = dir.join("shift-commits.json");
        let sha = "b".repeat(40);
        spool_one_shift_commit(&path, "client-2", &sha);

        let (port, server) = stub_server(
            200,
            r#"{"accepted":0,"rejected":[{"clientId":"client-2","reason":"unknown_session"}]}"#,
        )
        .await;
        assert!(
            upload_shift_commits_spool(&stub_client(port), "token", &path, fixture_now()).await,
            "the server responding at all is a completed pass"
        );
        let _ = server.await;

        let entries = read_shift_commits(&path);
        assert_eq!(entries.len(), 1);
        assert!(
            !entries[0].synced && !entries[0].rejected,
            "unknown_session leaves the row retryable"
        );
        assert_eq!(
            shift_commits::unsynced(&path)
                .expect("the registry reads")
                .len(),
            1
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Any other rejection reason is permanent: the row is marked rejected
    /// and drops out of the unsynced set for good.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_permanent_rejection_is_marked_rejected_and_dropped_from_unsynced() {
        let dir = temp_dir("shift-commit-rejected");
        let path = dir.join("shift-commits.json");
        let sha = "c".repeat(40);
        spool_one_shift_commit(&path, "client-3", &sha);

        let (port, server) = stub_server(
            200,
            r#"{"accepted":0,"rejected":[{"clientId":"client-3","reason":"validation_error"}]}"#,
        )
        .await;
        assert!(
            upload_shift_commits_spool(&stub_client(port), "token", &path, fixture_now()).await
        );
        let _ = server.await;

        let entries = read_shift_commits(&path);
        assert!(entries[0].rejected && !entries[0].synced);
        assert!(shift_commits::unsynced(&path)
            .expect("the registry reads")
            .is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A transport failure marks nothing, so the identical batch replays
    /// next pass.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_transport_failure_marks_nothing() {
        let dir = temp_dir("shift-commit-transport-error");
        let path = dir.join("shift-commits.json");
        let sha = "d".repeat(40);
        spool_one_shift_commit(&path, "client-4", &sha);

        let (port, server) = stub_server(500, r#"{"code":"internal_error"}"#).await;
        assert!(
            !upload_shift_commits_spool(&stub_client(port), "token", &path, fixture_now()).await,
            "a server error reports failure"
        );
        let _ = server.await;

        let entries = read_shift_commits(&path);
        assert!(
            !entries[0].synced && !entries[0].rejected,
            "nothing is marked on failure"
        );
        assert_eq!(
            shift_commits::unsynced(&path)
                .expect("the registry reads")
                .len(),
            1
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Seeds a usage registry the way a real pass does: a `Started` line
    /// naming a transcript lands on the agent spool, then capture runs beside
    /// it. Returns the registry path and the client id capture assigned, so a
    /// stub verdict can name the row.
    fn spool_one_usage_entry(dir: &Path) -> (PathBuf, String) {
        let agent_path = dir.join("agent-spool.jsonl");
        let usage_path = dir.join("agent-usage.json");
        let transcript = dir.join("session-1.jsonl");
        let line = serde_json::json!({
            "timestamp": "2026-08-06T10:15:00Z",
            "sessionId": "session-1",
            "isSidechain": false,
            "message": {
                "model": "claude-opus-4.1",
                "usage": {
                    "input_tokens": 150,
                    "output_tokens": 12,
                    "cache_creation_input_tokens": 3,
                    "cache_read_input_tokens": 4,
                },
            },
        });
        std::fs::write(&transcript, format!("{line}\n")).expect("the transcript writes");
        let event = SpoolEvent {
            source: source("claude_code"),
            external_session_id: "session-1".to_string(),
            event: AgentEventKind::Started,
            occurred_at: "2026-08-06T10:00:00Z".to_string(),
            cwd: Some("C:/dev/siqshift".to_string()),
            start_head: None,
            repo_root: None,
            repo_remote: None,
            model: None,
            rule_id: None,
            transcript_path: Some(transcript.to_string_lossy().into_owned()),
            tokens: None,
        };
        spool::append(&agent_path, &event).expect("the spool accepts a line");
        agent_usage::capture_from_spool(&agent_path, &usage_path);
        let pending = agent_usage::unsynced(&usage_path).expect("the registry reads");
        assert_eq!(pending.len(), 1, "capture produced one usage entry");
        (usage_path, pending[0].client_id.clone())
    }

    /// Capture feeds upload: a transcript's counters reach `/agent-usage` in
    /// the contract's shape on the same pass and are marked synced.
    #[tokio::test(flavor = "multi_thread")]
    async fn captured_usage_reaches_the_endpoint_and_is_marked_synced() {
        let dir = temp_dir("usage-accepted");
        let (path, client_id) = spool_one_usage_entry(&dir);

        let (port, server) = stub_server(200, r#"{"accepted":1,"rejected":[]}"#).await;
        assert!(
            upload_agent_usage_spool(&stub_client(port), "token", &path, fixture_now()).await,
            "an accepted batch reports success"
        );

        let request = server.await.expect("the stub finishes");
        assert!(
            request.starts_with("POST /agent-usage "),
            "the batch goes to the agent-usage endpoint: {request}"
        );
        assert!(
            request.contains(&format!("\"clientId\":\"{client_id}\""))
                && request.contains("\"bucketStartAt\":\"2026-08-06T10:00:00Z\"")
                && request.contains("\"externalSessionId\":\"session-1\"")
                && request.contains("\"model\":\"claude-opus-4.1\"")
                && request.contains("\"sidechain\":false")
                && request.contains("\"inputTokens\":150")
                && request.contains("\"outputTokens\":12")
                && request.contains("\"cacheCreationInputTokens\":3")
                && request.contains("\"cacheReadInputTokens\":4"),
            "the wire payload carries the contract's field names: {request}"
        );

        assert!(
            agent_usage::unsynced(&path)
                .expect("the registry reads")
                .is_empty(),
            "an accepted row is marked synced"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `unknown_session` is retryable: the shift may not have landed on the
    /// server yet, so the row stays unsynced (and unrejected) and uploads
    /// again once it has.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_unknown_session_rejection_keeps_the_usage_row_retryable() {
        let dir = temp_dir("usage-unknown-session");
        let (path, client_id) = spool_one_usage_entry(&dir);

        let (port, server) = stub_server(
            200,
            Box::leak(
                format!(
                    r#"{{"accepted":0,"rejected":[{{"clientId":"{client_id}","reason":"unknown_session"}}]}}"#
                )
                .into_boxed_str(),
            ),
        )
        .await;
        assert!(
            upload_agent_usage_spool(&stub_client(port), "token", &path, fixture_now()).await,
            "the server responding at all is a completed pass"
        );
        let _ = server.await;

        assert_eq!(
            agent_usage::unsynced(&path)
                .expect("the registry reads")
                .len(),
            1,
            "unknown_session leaves the row retryable"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Any other rejection reason is permanent: the row is marked rejected
    /// and drops out of the unsynced set for good.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_permanent_usage_rejection_is_marked_rejected_and_dropped() {
        let dir = temp_dir("usage-rejected");
        let (path, client_id) = spool_one_usage_entry(&dir);

        let (port, server) = stub_server(
            200,
            Box::leak(
                format!(
                    r#"{{"accepted":0,"rejected":[{{"clientId":"{client_id}","reason":"validation_error"}}]}}"#
                )
                .into_boxed_str(),
            ),
        )
        .await;
        assert!(upload_agent_usage_spool(&stub_client(port), "token", &path, fixture_now()).await);
        let _ = server.await;

        assert!(
            agent_usage::unsynced(&path)
                .expect("the registry reads")
                .is_empty(),
            "a permanent rejection leaves the unsynced set"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The rows one request carried: the body's one array, whichever route's
    /// key (`events`, `usage`, `commits`) names it.
    fn batch_rows(body: &serde_json::Value) -> &Vec<serde_json::Value> {
        body.as_object()
            .and_then(|object| object.values().find_map(serde_json::Value::as_array))
            .expect("the body carries one array of rows")
    }

    /// The session a backlog's rows name that this workspace does not hold, as
    /// every row of the workspace an account switch left behind does.
    const OTHER_WORKSPACE_SESSION: &str = "other-workspace-session";

    /// The server's verdict on one batch: `unknown_session` for each row whose
    /// session lives in the other workspace, accepted for the rest.
    fn verdicts_by_session(body: &serde_json::Value) -> Option<(u16, String)> {
        let rows = batch_rows(body);
        let rejected: Vec<serde_json::Value> = rows
            .iter()
            .filter(|row| row["externalSessionId"] == OTHER_WORKSPACE_SESSION)
            .map(|row| serde_json::json!({ "clientId": row["clientId"], "reason": "unknown_session" }))
            .collect();
        let accepted = rows.len() - rejected.len();
        Some((
            200,
            serde_json::json!({ "accepted": accepted, "rejected": rejected }).to_string(),
        ))
    }

    fn usage_entry(client_id: &str, session: &str, at: u64) -> agent_usage::UsageEntry {
        agent_usage::UsageEntry {
            client_id: client_id.to_string(),
            source: source("claude_code"),
            external_session_id: session.to_string(),
            bucket_start_at: iso8601(at - at % 3_600),
            model: Some("claude-opus-4.1".to_string()),
            sidechain: false,
            input_tokens: 150,
            output_tokens: 12,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 4,
            synced: false,
            rejected: false,
            unknown_session_attempts: 0,
        }
    }

    fn write_usage_registry(path: &Path, entries: &[agent_usage::UsageEntry]) {
        let bytes = serde_json::to_vec(&serde_json::json!({ "entries": entries }))
            .expect("the registry encodes");
        std::fs::write(path, bytes).expect("the registry writes");
    }

    fn read_usage_entries(path: &Path) -> Vec<agent_usage::UsageEntry> {
        let registry: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).expect("the registry reads"))
                .expect("the registry decodes");
        serde_json::from_value(registry["entries"].clone()).expect("the entries decode")
    }

    /// Issue 93: after an account switch, thousands of rows whose sessions live
    /// in the other workspace are answered `unknown_session` on every pass, and
    /// sent oldest first they headed every pass, so a pass that ended early on
    /// a transport error never reached the new rows behind them. A new row goes
    /// out ahead of that backlog, and what the server answered before the pass
    /// ended is recorded.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_new_usage_row_lands_ahead_of_an_unknown_session_backlog() {
        let dir = temp_dir("usage-unknown-backlog");
        let path = dir.join("agent-usage.json");
        let now = fixture_now();
        let mut entries: Vec<agent_usage::UsageEntry> = (0..600_u64)
            .map(|index| {
                usage_entry(
                    &format!("old-{index}"),
                    OTHER_WORKSPACE_SESSION,
                    now - 30 * 86_400 + index * 3_600,
                )
            })
            .collect();
        entries.push(usage_entry("new", "this-workspace-session", now - 3_600));
        write_usage_registry(&path, &entries);

        // The first request is answered; the second is dropped, as the field's
        // 499s were, which ends the pass.
        let (port, server) = stub_batches(2, |index, body| {
            (index == 0).then(|| verdicts_by_session(body)).flatten()
        })
        .await;
        assert!(
            !upload_agent_usage_spool(&stub_client(port), "token", &path, now).await,
            "a dropped request ends the pass incomplete"
        );
        server.await.expect("the stub finishes");

        let new_row = read_usage_entries(&path)
            .into_iter()
            .find(|entry| entry.client_id == "new")
            .expect("the new row is kept");
        assert!(
            new_row.synced,
            "the new row went first and its acceptance was recorded"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn commit_entry(client_id: &str, session: &str, at: u64) -> crate::shift_commits::CommitEntry {
        crate::shift_commits::CommitEntry {
            external_session_id: session.to_string(),
            authored_at: iso8601(at),
            ..one_commit_entry(client_id, &format!("{:040x}", at))
        }
    }

    /// The same backlog for shift commits, which follow the same verdict rules.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_new_shift_commit_lands_ahead_of_an_unknown_session_backlog() {
        let dir = temp_dir("commit-unknown-backlog");
        let path = dir.join("shift-commits.json");
        let now = fixture_now();
        let mut entries: Vec<crate::shift_commits::CommitEntry> = (0..600_u64)
            .map(|index| {
                commit_entry(
                    &format!("old-{index}"),
                    OTHER_WORKSPACE_SESSION,
                    now - 30 * 86_400 + index * 3_600,
                )
            })
            .collect();
        entries.push(commit_entry("new", "this-workspace-session", now - 3_600));
        std::fs::write(
            &path,
            serde_json::to_vec(&entries).expect("the registry encodes"),
        )
        .expect("the registry writes");

        let (port, server) = stub_batches(2, |index, body| {
            (index == 0).then(|| verdicts_by_session(body)).flatten()
        })
        .await;
        assert!(
            !upload_shift_commits_spool(&stub_client(port), "token", &path, now).await,
            "a dropped request ends the pass incomplete"
        );
        server.await.expect("the stub finishes");

        let new_commit = read_shift_commits(&path)
            .into_iter()
            .find(|entry| entry.client_id == "new")
            .expect("the new commit is kept");
        assert!(
            new_commit.synced,
            "the new commit went first and its acceptance was recorded"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The client ids one request carried, in the order it sent them.
    fn sent_client_ids(body: &serde_json::Value) -> Vec<String> {
        batch_rows(body)
            .iter()
            .map(|row| row["clientId"].as_str().expect("a client id").to_string())
            .collect()
    }

    /// A row the server keeps answering `unknown_session` is retried a bounded
    /// number of times, then given up rather than sent on every pass forever.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_unknown_session_row_is_given_up_after_its_attempt_limit() {
        let dir = temp_dir("usage-unknown-bound");
        let path = dir.join("agent-usage.json");
        let now = fixture_now();
        write_usage_registry(
            &path,
            &[usage_entry("orphan", OTHER_WORKSPACE_SESSION, now - 3_600)],
        );

        for attempt in 1..=12 {
            let (port, server) = stub_batches(1, |_, body| verdicts_by_session(body)).await;
            assert!(upload_agent_usage_spool(&stub_client(port), "token", &path, now).await);
            server.await.expect("the stub finishes");
            let entry = &read_usage_entries(&path)[0];
            assert_eq!(entry.unknown_session_attempts, attempt);
            assert_eq!(
                entry.rejected,
                attempt == 12,
                "given up exactly at the limit"
            );
        }

        // Nothing is left to send: the pass ends without a request.
        assert!(
            agent_usage::unsynced(&path)
                .expect("the registry reads")
                .is_empty(),
            "a given-up row is never sent again"
        );
        assert!(upload_agent_usage_spool(&stub_client(1), "token", &path, now).await);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A row the server has never refused goes out before one it already
    /// answered `unknown_session`, even when the retried row is newer.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_never_refused_row_goes_out_before_a_retried_one() {
        let dir = temp_dir("usage-retry-order");
        let path = dir.join("agent-usage.json");
        let now = fixture_now();
        let mut retried = usage_entry("retried", OTHER_WORKSPACE_SESSION, now - 3_600);
        retried.unknown_session_attempts = 3;
        write_usage_registry(
            &path,
            &[
                retried,
                usage_entry("fresh", "this-workspace-session", now - 10 * 86_400),
            ],
        );

        let (port, server) = stub_batches(1, |_, body| {
            assert_eq!(sent_client_ids(body), ["fresh", "retried"]);
            verdicts_by_session(body)
        })
        .await;
        assert!(upload_agent_usage_spool(&stub_client(port), "token", &path, now).await);
        server.await.expect("the stub finishes");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The server keeps no session older than its retention window, so a row
    /// that old is never sent: it is settled locally, and only the rest go out.
    #[tokio::test(flavor = "multi_thread")]
    async fn rows_older_than_the_server_retention_window_are_not_sent() {
        let dir = temp_dir("usage-retention");
        let usage_path = dir.join("agent-usage.json");
        let commits_path = dir.join("shift-commits.json");
        let now = fixture_now();
        let retention_days_in_seconds = 90 * 86_400;
        let expired_at = now - retention_days_in_seconds - 3_600;
        let kept_at = now - retention_days_in_seconds + 3_600;
        write_usage_registry(
            &usage_path,
            &[
                usage_entry("expired", "this-workspace-session", expired_at),
                usage_entry("kept", "this-workspace-session", kept_at),
            ],
        );
        let commits = [
            commit_entry("expired", "this-workspace-session", expired_at),
            commit_entry("kept", "this-workspace-session", kept_at),
        ];
        std::fs::write(
            &commits_path,
            serde_json::to_vec(&commits).expect("the registry encodes"),
        )
        .expect("the registry writes");

        let (port, server) = stub_batches(2, |_, body| {
            assert_eq!(sent_client_ids(body), ["kept"]);
            verdicts_by_session(body)
        })
        .await;
        let client = stub_client(port);
        assert!(upload_agent_usage_spool(&client, "token", &usage_path, now).await);
        assert!(upload_shift_commits_spool(&client, "token", &commits_path, now).await);
        assert_eq!(server.await.expect("the stub finishes"), [1, 1]);

        let expired = read_usage_entries(&usage_path)
            .into_iter()
            .find(|entry| entry.client_id == "expired")
            .expect("the expired row is kept");
        assert!(expired.rejected && !expired.synced);
        assert!(agent_usage::unsynced(&usage_path)
            .expect("the registry reads")
            .is_empty());
        assert!(shift_commits::unsynced(&commits_path)
            .expect("the registry reads")
            .is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Issue 93's silent loss: the server accepted a row, but recording it
    /// waited on a busy registry lock, failed, and was discarded, so the row
    /// stayed unsynced with nothing said. The failure now fails the pass, the
    /// row stays unsynced, and the next pass sends it again and records it.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_accepted_row_whose_marking_meets_a_busy_lock_is_recorded_next_pass() {
        let dir = temp_dir("usage-busy-lock");
        let path = dir.join("agent-usage.json");
        let now = fixture_now();
        write_usage_registry(
            &path,
            &[usage_entry(
                "accepted",
                "this-workspace-session",
                now - 3_600,
            )],
        );

        // Another writer takes the registry lock while the request is in
        // flight, after the pass read its rows, and holds it past the wait.
        let lock_path = dir.join("agent-usage.json.lock");
        let held_lock: Arc<Mutex<Option<std::fs::File>>> = Arc::new(Mutex::new(None));
        let holder = Arc::clone(&held_lock);
        let (port, server) = stub_batches(1, move |_, body| {
            let lock = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(false)
                .open(&lock_path)
                .expect("the lock file opens");
            lock.try_lock()
                .expect("the lock is free while the request is in flight");
            *holder.lock().expect("the holder locks") = Some(lock);
            verdicts_by_session(body)
        })
        .await;
        assert!(
            !upload_agent_usage_spool(&stub_client(port), "token", &path, now).await,
            "a verdict that could not be recorded fails the pass"
        );
        server.await.expect("the stub finishes");
        assert!(!read_usage_entries(&path)[0].synced, "nothing was recorded");

        // The other writer lets go; the next pass sends the row again and
        // records the server's answer.
        drop(held_lock.lock().expect("the holder locks").take());
        let (port, server) = stub_batches(1, |_, body| verdicts_by_session(body)).await;
        assert!(upload_agent_usage_spool(&stub_client(port), "token", &path, now).await);
        server.await.expect("the stub finishes");
        assert!(read_usage_entries(&path)[0].synced);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A loopback stub that answers a fixed number of requests in turn.
    /// `answer` sees each request's index and its parsed body, and returns the
    /// reply, or `None` to drop the connection without answering, which is
    /// what a request the server cannot finish in time looks like to the
    /// client. The handle yields the row count of every request served.
    async fn stub_batches(
        requests: usize,
        answer: impl Fn(usize, &serde_json::Value) -> Option<(u16, String)> + Send + 'static,
    ) -> (u16, tokio::task::JoinHandle<Vec<usize>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("the loopback stub binds");
        let port = listener
            .local_addr()
            .expect("the stub has an address")
            .port();
        let handle = tokio::spawn(async move {
            let mut sizes = Vec::new();
            for index in 0..requests {
                let (mut stream, _) = listener.accept().await.expect("the stub accepts");
                let mut request = Vec::new();
                let mut buffer = [0_u8; 4_096];
                loop {
                    let read = stream.read(&mut buffer).await.expect("the stub reads");
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..read]);
                    if let Some(head_end) = find_head_end(&request) {
                        let length = content_length(&request[..head_end]);
                        if request.len() >= head_end + length {
                            break;
                        }
                    }
                }
                let head_end = find_head_end(&request).expect("the request has a head");
                let body: serde_json::Value =
                    serde_json::from_slice(&request[head_end..]).expect("the body parses");
                sizes.push(batch_rows(&body).len());
                let Some((status, payload)) = answer(index, &body) else {
                    drop(stream);
                    continue;
                };
                let response = format!(
                    "HTTP/1.1 {status} STUB\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
                    payload.len()
                );
                stream
                    .write_all(response.as_bytes())
                    .await
                    .expect("the stub answers");
                stream.flush().await.expect("the stub flushes");
            }
            sizes
        });
        (port, handle)
    }

    /// Spools `count` agent events, alternating started/ended so the lines are
    /// the shape a real hook writes.
    fn spool_agent_events(path: &Path, count: usize) {
        for index in 0..count {
            let event = SpoolEvent {
                source: source("claude_code"),
                external_session_id: format!("session-{index}"),
                event: if index % 2 == 0 {
                    AgentEventKind::Started
                } else {
                    AgentEventKind::Ended
                },
                occurred_at: "2026-08-29T13:36:06Z".to_string(),
                cwd: Some("C:/dev/SIQshift".to_string()),
                start_head: None,
                repo_root: Some("C:/dev/SIQshift".to_string()),
                repo_remote: Some("git@github.com:fpresta0607/siqshift.git".to_string()),
                model: None,
                rule_id: None,
                transcript_path: None,
                tokens: None,
            };
            spool::append(path, &event).expect("the spool accepts a line");
        }
    }

    /// The regression this whole change exists for: a backlog the endpoint
    /// cannot answer in one request. `/agent-sessions` writes each event on its
    /// own, so a batch of 500 outruns the client's 20 s timeout, the pass
    /// acknowledges nothing, and the spool that only grows can never be drained
    /// again, which is what left agent time reading zero for days while
    /// sessions and segments uploaded normally. The stub stands in for that
    /// ceiling: it answers a batch it can handle and drops one it cannot.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_backlog_drains_in_batches_the_endpoint_can_answer() {
        let dir = temp_dir("agent-backlog");
        let path = dir.join("agent-spool.jsonl");
        spool_agent_events(&path, 250);

        let (port, server) = stub_batches(3, |_, body| {
            (batch_rows(body).len() <= 150).then(|| (200, r#"{"results":[]}"#.to_string()))
        })
        .await;
        assert!(
            upload_agent_spool(&stub_client(port), "token", &path).await,
            "a backlog the endpoint can answer in batches drains"
        );

        let sizes = server.await.expect("the stub finishes");
        assert_eq!(sizes, vec![100, 100, 50], "batches the endpoint can answer");
        assert!(
            spool::read_pending(&path)
                .expect("the spool reads")
                .events
                .is_empty(),
            "the whole backlog left the spool"
        );
    }

    /// Forward progress, so one bad batch cannot hold a backlog hostage: what
    /// the server took stays taken, and only the rest replays next pass.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_failed_batch_keeps_the_batches_already_acknowledged() {
        let dir = temp_dir("agent-partial");
        let path = dir.join("agent-spool.jsonl");
        spool_agent_events(&path, 250);

        let (port, server) = stub_batches(3, |index, _| {
            (index < 2).then(|| (200, r#"{"results":[]}"#.to_string()))
        })
        .await;
        assert!(
            !upload_agent_spool(&stub_client(port), "token", &path).await,
            "a batch the server never answered fails the pass"
        );

        server.await.expect("the stub finishes");
        assert_eq!(
            spool::read_pending(&path)
                .expect("the spool reads")
                .events
                .len(),
            50,
            "the two accepted batches left the spool; only the rest replays"
        );
    }

    /// Shift commits and usage rows upload only once the agent spool is
    /// empty, so a pass that stops at its batch bound with events still
    /// spooled must not report the spool drained: those events name sessions
    /// the server does not hold yet.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_pass_that_stops_with_events_left_does_not_report_the_spool_drained() {
        let dir = temp_dir("agent-capped");
        let path = dir.join("agent-spool.jsonl");
        let per_pass = AGENT_BATCHES_PER_PASS * AGENT_UPLOAD_BATCH_SIZE;
        spool_agent_events(&path, per_pass + 1);

        let (port, server) = stub_batches(AGENT_BATCHES_PER_PASS, |_, _| {
            Some((200, r#"{"results":[]}"#.to_string()))
        })
        .await;
        assert!(
            !upload_agent_spool(&stub_client(port), "token", &path).await,
            "a spool with events left is not drained"
        );

        server.await.expect("the stub finishes");
        assert_eq!(
            spool::read_pending(&path)
                .expect("the spool reads")
                .events
                .len(),
            1,
            "the event past the pass's bound waits for the next pass"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An event the server refuses on every pass must not hold shift commits
    /// and usage rows forever: it is acknowledged with its batch, so the spool
    /// still empties and reports drained.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_refused_agent_event_leaves_the_spool_drained() {
        let dir = temp_dir("agent-refused");
        let path = dir.join("agent-spool.jsonl");
        spool_agent_events(&path, 1);

        let (port, server) = stub_batches(1, |_, _| {
            Some((
                200,
                r#"{"results":[{"externalSessionId":"session-0","accepted":false,"reason":"validation_error"}]}"#
                    .to_string(),
            ))
        })
        .await;
        assert!(
            upload_agent_spool(&stub_client(port), "token", &path).await,
            "a refused event does not keep the spool undrained"
        );

        server.await.expect("the stub finishes");
        assert!(
            spool::read_pending(&path)
                .expect("the spool reads")
                .events
                .is_empty(),
            "the refused event left the spool"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn sent_session_ids(body: &serde_json::Value) -> Vec<String> {
        batch_rows(body)
            .iter()
            .map(|event| {
                event["externalSessionId"]
                    .as_str()
                    .expect("a session id")
                    .to_string()
            })
            .collect()
    }

    /// `/agent-sessions` validates the whole request, so one malformed event
    /// (a `cwd` past the contract's length, say) gets the batch a 400. Sent
    /// alone, the others land and the malformed one is dropped, so the spool
    /// still empties and shift commits and usage rows are not held forever.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_event_refused_as_invalid_on_its_own_is_dropped_and_the_rest_land() {
        let dir = temp_dir("agent-invalid-dropped");
        let path = dir.join("agent-spool.jsonl");
        spool_agent_events(&path, 3);

        let (port, server) = stub_batches(4, |_, body| {
            Some(
                if sent_session_ids(body).contains(&"session-1".to_string()) {
                    (400, r#"{"code":"validation_error"}"#.to_string())
                } else {
                    (200, r#"{"results":[]}"#.to_string())
                },
            )
        })
        .await;
        assert!(
            upload_agent_spool(&stub_client(port), "token", &path).await,
            "the spool empties past the malformed event"
        );

        assert_eq!(
            server.await.expect("the stub finishes"),
            [3, 1, 1, 1],
            "the refused batch is sent again one event at a time"
        );
        assert!(
            spool::read_pending(&path)
                .expect("the spool reads")
                .events
                .is_empty(),
            "the malformed event was dropped and the rest left with their acks"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Only a validation refusal of the event on its own drops it. A server
    /// error, an auth refusal, or no answer at all while it is sent alone says
    /// nothing about the event, so it stays for the next pass.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_event_whose_lone_resend_fails_otherwise_is_kept() {
        for lone_answer in [
            Some((500, r#"{"code":"internal_error"}"#)),
            Some((401, r#"{"code":"unauthorized"}"#)),
            None,
        ] {
            let dir = temp_dir("agent-invalid-kept");
            let path = dir.join("agent-spool.jsonl");
            spool_agent_events(&path, 2);

            let (port, server) = stub_batches(2, move |index, _| {
                if index == 0 {
                    return Some((400, r#"{"code":"validation_error"}"#.to_string()));
                }
                lone_answer.map(|(status, body)| (status, body.to_string()))
            })
            .await;
            assert!(
                !upload_agent_spool(&stub_client(port), "token", &path).await,
                "a lone resend that failed otherwise fails the pass ({lone_answer:?})"
            );

            assert_eq!(server.await.expect("the stub finishes"), [2, 1]);
            assert_eq!(
                spool::read_pending(&path)
                    .expect("the spool reads")
                    .events
                    .len(),
                2,
                "both events stay for the next pass ({lone_answer:?})"
            );

            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// The wire trap the projection exists for: the spool line now carries
    /// capture-only fields (`transcriptPath`, `tokens`), and the strict
    /// `/agent-sessions` schema 400s on any key it does not declare. Pin the
    /// exact key set the upload sends.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_uploaded_agent_event_sends_only_the_contract_fields() {
        let dir = temp_dir("agent-wire-shape");
        let path = dir.join("agent-spool.jsonl");
        let event = SpoolEvent {
            source: source("claude_code"),
            external_session_id: "session-1".to_string(),
            event: AgentEventKind::Started,
            occurred_at: "2026-08-12T13:36:06Z".to_string(),
            cwd: Some("C:/dev/SIQshift".to_string()),
            start_head: Some("a".repeat(40)),
            repo_root: Some("C:/dev/SIQshift".to_string()),
            repo_remote: Some("git@github.com:fpresta0607/siqshift.git".to_string()),
            model: Some("claude-opus-4.1".to_string()),
            rule_id: None,
            transcript_path: Some("C:/Users/alex/.claude/projects/x/session-1.jsonl".to_string()),
            tokens: Some(spool::TokenCounters {
                input_tokens: Some(150),
                output_tokens: Some(12),
                cache_creation_input_tokens: Some(3),
                cache_read_input_tokens: Some(4),
            }),
        };
        spool::append(&path, &event).expect("the spool accepts a line");

        let (port, server) = stub_server(
            200,
            r#"{"results":[{"externalSessionId":"session-1","accepted":true}]}"#,
        )
        .await;
        assert!(
            upload_agent_spool(&stub_client(port), "token", &path).await,
            "an accepted batch reports success"
        );

        let request = server.await.expect("the stub finishes");
        assert!(
            request.starts_with("POST /agent-sessions "),
            "the batch goes to the agent-sessions endpoint: {request}"
        );
        let head_end = find_head_end(request.as_bytes()).expect("the request has a head");
        let body: serde_json::Value =
            serde_json::from_str(&request[head_end..]).expect("the body parses");
        let event = body["events"][0].as_object().expect("one event object");
        let mut keys: Vec<&str> = event.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "cwd",
                "event",
                "externalSessionId",
                "model",
                "occurredAt",
                "repoRemote",
                "repoRoot",
                "source"
            ],
            "exactly the contract fields, no capture-only keys: {request}"
        );
        // repoRoot is contract data and rides through; startHead is
        // sidecar-local and must not, even though the hook writes them
        // together from the same probe.
        assert_eq!(event["repoRoot"], "C:/dev/SIQshift");
        // The remote rides through verbatim; the server normalizes it, and it
        // is what keys the identity, so losing it here would put every
        // worktree back on its own roster row.
        assert_eq!(
            event["repoRemote"],
            "git@github.com:fpresta0607/siqshift.git"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn mapping(id: &str, prefix: &str, project: &str) -> PathMapping {
        PathMapping {
            id: id.to_string(),
            kind: MappingKind::PathPrefix,
            path_prefix: prefix.to_string(),
            repo_url: None,
            project_id: project.to_string(),
        }
    }

    fn event(kind: AgentEventKind, cwd: &str, occurred_at: &str) -> SpoolEvent {
        event_for(source("claude_code"), "s1", kind, cwd, occurred_at)
    }

    fn event_for(
        source: spool::AgentSource,
        external_session_id: &str,
        kind: AgentEventKind,
        cwd: &str,
        occurred_at: &str,
    ) -> SpoolEvent {
        SpoolEvent {
            source,
            external_session_id: external_session_id.to_string(),
            event: kind,
            occurred_at: occurred_at.to_string(),
            cwd: Some(cwd.to_string()),
            start_head: None,
            repo_root: None,
            repo_remote: None,
            model: None,
            rule_id: None,
            transcript_path: None,
            tokens: None,
        }
    }

    /// `startHead` is a spool-local field the shift-capture sidecar reads; the
    /// server's agent-session contract has no such field, so the uploaded
    /// event must not carry it.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_uploaded_agent_event_drops_the_spool_local_start_head() {
        let dir = temp_dir("agent-start-head");
        let path = dir.join("agent-spool.jsonl");
        let event = SpoolEvent {
            source: source("claude_code"),
            external_session_id: "session-1".to_string(),
            event: AgentEventKind::Started,
            occurred_at: "2026-08-12T13:36:06Z".to_string(),
            cwd: Some("C:/dev/SIQshift".to_string()),
            start_head: Some("a".repeat(40)),
            repo_root: None,
            repo_remote: None,
            model: None,
            rule_id: None,
            transcript_path: None,
            tokens: None,
        };
        let mut line = serde_json::to_vec(&event).expect("the event encodes");
        line.push(b'\n');
        spool::append_line(&path, &line, spool::MAX_SPOOL_BYTES).expect("the spool accepts a line");

        let (port, server) = stub_server(
            200,
            r#"{"results":[{"externalSessionId":"session-1","accepted":true}]}"#,
        )
        .await;
        assert!(
            upload_agent_spool(&stub_client(port), "token", &path).await,
            "an accepted batch reports success"
        );

        let request = server.await.expect("the stub finishes");
        assert!(
            request.starts_with("POST /agent-sessions "),
            "the batch goes to the agent-sessions endpoint: {request}"
        );
        assert!(
            request.contains("\"externalSessionId\":\"session-1\"")
                && request.contains("\"cwd\":\"C:/dev/SIQshift\""),
            "the wire payload carries the contract's field names: {request}"
        );
        assert!(
            !request.contains("startHead"),
            "startHead is a spool-local field and must not reach the server: {request}"
        );

        let (pending, _) = spool::read_pending_lines::<SpoolEvent>(&path).expect("the spool reads");
        assert!(pending.is_empty(), "an accepted batch leaves the spool");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn path_normalization_matches_the_server() {
        assert_eq!(normalize_path("C:\\Dev\\SIQshift\\"), "c:/dev/siqshift");
        assert_eq!(normalize_path("c:/dev/siqshift"), "c:/dev/siqshift");
        assert_eq!(normalize_path("/home/alex/project//"), "/home/alex/project");
    }

    #[test]
    fn prefixes_match_only_on_segment_boundaries() {
        assert!(matches_boundary("c:/dev/siqshift", "c:/dev/siqshift"));
        assert!(matches_boundary("c:/dev/siqshift/src", "c:/dev/siqshift"));
        assert!(!matches_boundary(
            "c:/dev/siqshift-extra",
            "c:/dev/siqshift"
        ));
        assert!(!matches_boundary("c:/dev", "c:/dev/siqshift"));
    }

    #[test]
    fn the_longest_matching_prefix_wins() {
        let mappings = vec![
            mapping("m1", "C:/dev", "p-general"),
            mapping("m2", "c:/DEV/siqshift", "p-siqshift"),
        ];
        assert_eq!(
            resolve_project("C:\\dev\\SIQshift\\src", &mappings).as_deref(),
            Some("p-siqshift")
        );
        assert_eq!(
            resolve_project("C:/dev/other", &mappings).as_deref(),
            Some("p-general")
        );
        assert_eq!(resolve_project("D:/elsewhere", &mappings), None);
    }

    #[test]
    fn equal_length_ties_are_ambiguous_unless_they_agree() {
        let tie = vec![
            mapping("m1", "C:/dev", "p-one"),
            mapping("m2", "c:/dev/", "p-two"),
        ];
        assert_eq!(resolve_project("c:/dev/siqshift", &tie), None);

        let agreement = vec![
            mapping("m1", "C:/dev", "p-one"),
            mapping("m2", "c:/dev/", "p-one"),
        ];
        assert_eq!(
            resolve_project("c:/dev/siqshift", &agreement).as_deref(),
            Some("p-one")
        );
    }

    #[test]
    fn started_events_open_tracking_and_ended_events_close_it() {
        let mut tracking = AgentTracking::default();

        track_agent_events(
            &[
                event(
                    AgentEventKind::Started,
                    "C:/dev/siqshift",
                    "2026-08-07T10:00:00Z",
                ),
                event(
                    AgentEventKind::Heartbeat,
                    "C:/dev/siqshift",
                    "2026-08-07T10:05:00Z",
                ),
            ],
            &[],
            &mut tracking,
        );
        assert_eq!(tracking.active.len(), 1);
        assert_eq!(
            tracking.last_event_at,
            parse_iso8601("2026-08-07T10:05:00Z").expect("timestamp parses")
        );
        assert_eq!(
            tracking
                .active
                .get(&("claude_code".to_string(), "s1".to_string())),
            Some(&ActiveAgent {
                source: "claude_code".to_string(),
                external_session_id: "s1".to_string(),
                started_at: parse_iso8601("2026-08-07T10:00:00Z").expect("timestamp parses"),
                last_event_at: parse_iso8601("2026-08-07T10:05:00Z").expect("timestamp parses"),
                project: None,
            }),
            "the start opens the marker; the heartbeat keeps the original start"
        );

        track_agent_events(
            &[event(
                AgentEventKind::Ended,
                "C:/dev/siqshift",
                "2026-08-07T11:00:00Z",
            )],
            &[],
            &mut tracking,
        );
        assert!(
            tracking.active.is_empty(),
            "an ended session clears its marker"
        );
    }

    #[test]
    fn a_mapped_start_names_the_project_the_open_session_belongs_to() {
        let mappings = vec![mapping("m1", "C:/dev/siqshift", "p-siqshift")];
        let mut tracking = AgentTracking::default();

        track_agent_events(
            &[event(
                AgentEventKind::Started,
                "C:/dev/siqshift",
                "2026-08-07T10:00:00Z",
            )],
            &mappings,
            &mut tracking,
        );
        assert_eq!(
            tracking.effective_project(
                parse_iso8601("2026-08-07T10:00:00Z").expect("timestamp parses")
            ),
            Some("p-siqshift")
        );

        // An unmapped directory names nothing, so the last name stands until
        // the session that carried it ends.
        track_agent_events(
            &[event(
                AgentEventKind::Heartbeat,
                "D:/unmapped",
                "2026-08-07T11:00:00Z",
            )],
            &mappings,
            &mut tracking,
        );
        assert_eq!(
            tracking.effective_project(
                parse_iso8601("2026-08-07T11:00:00Z").expect("timestamp parses")
            ),
            Some("p-siqshift")
        );

        track_agent_events(
            &[event(
                AgentEventKind::Ended,
                "C:/dev/siqshift",
                "2026-08-07T12:00:00Z",
            )],
            &mappings,
            &mut tracking,
        );
        assert_eq!(
            tracking.effective_project(
                parse_iso8601("2026-08-07T12:00:00Z").expect("timestamp parses")
            ),
            None,
            "with no agent running, time falls back to the default project"
        );
    }

    #[test]
    fn ending_one_agent_keeps_an_overlapping_agent_active_and_attributed() {
        let mappings = vec![
            mapping("m1", "C:/one", "p-one"),
            mapping("m2", "C:/two", "p-two"),
        ];
        let mut tracking = AgentTracking::default();
        track_agent_events(
            &[
                event_for(
                    source("claude_code"),
                    "one",
                    AgentEventKind::Started,
                    "C:/one",
                    "2026-08-07T10:00:00Z",
                ),
                event_for(
                    source("cursor"),
                    "two",
                    AgentEventKind::Started,
                    "C:/two",
                    "2026-08-07T10:01:00Z",
                ),
                event_for(
                    source("claude_code"),
                    "one",
                    AgentEventKind::Ended,
                    "C:/one",
                    "2026-08-07T10:02:00Z",
                ),
            ],
            &mappings,
            &mut tracking,
        );

        let now = parse_iso8601("2026-08-07T10:02:00Z").expect("timestamp parses");
        assert!(tracking.is_active(now, true));
        assert_eq!(tracking.effective_project(now), Some("p-two"));
        assert!(tracking
            .active
            .contains_key(&("cursor".to_string(), "two".to_string())));
    }

    #[test]
    fn replaying_a_short_agent_session_splits_the_tracker_at_event_times() {
        let shared = Arc::new(Mutex::new(MonitorShared {
            builder: crate::monitor::SegmentBuilder::new(),
            settings: crate::monitor::MonitorSettings::default(),
            mappings: vec![mapping("m1", "C:/siqshift", "p-siqshift")],
            agent: AgentTracking::default(),
            last_upload_at: None,
            last_poll_at: None,
            tracker: crate::monitor::SessionTracker::new(),
            default_project: Some("p-default".to_string()),
            account_id: Some("u1".to_string()),
            selected_project: None,
        }));
        {
            let mut state = lock(&shared);
            state.builder.apply(
                1_000,
                &crate::monitor::ActivitySignal::Active {
                    process_name: None,
                    idle_seconds: Some(0),
                },
            );
            advance_sessions(&mut state, 1_000);
        }

        let finished = replay_agent_events(
            &shared,
            &[
                event(
                    AgentEventKind::Started,
                    "C:/siqshift",
                    "1970-01-01T00:16:50Z",
                ),
                event(AgentEventKind::Ended, "C:/siqshift", "1970-01-01T00:17:00Z"),
            ],
        );

        let agent = finished
            .iter()
            .find(|session| session.project_id == "p-siqshift")
            .expect("the short agent interval becomes its own session");
        assert_eq!(agent.started_at, iso8601(1_010));
        assert_eq!(agent.stopped_at, iso8601(1_020));
    }

    #[test]
    fn out_of_order_events_replay_without_moving_state_backwards() {
        let mut tracking = AgentTracking::default();
        let newer = event(AgentEventKind::Heartbeat, "C:/dev", "2026-08-07T12:00:00Z");
        track_agent_events(&[newer], &[], &mut tracking);
        // A replayed drain delivers the same older events; state must not regress.
        track_agent_events(
            &[event(
                AgentEventKind::Started,
                "C:/dev",
                "2026-08-07T10:00:00Z",
            )],
            &[],
            &mut tracking,
        );
        assert_eq!(
            tracking.last_event_at,
            parse_iso8601("2026-08-07T12:00:00Z").expect("timestamp parses")
        );

        // Out-of-order delivery within one batch is tolerated by sorting.
        let mut fresh = AgentTracking::default();
        track_agent_events(
            &[
                event(AgentEventKind::Ended, "C:/dev", "2026-08-07T11:00:00Z"),
                event(AgentEventKind::Started, "C:/dev", "2026-08-07T10:00:00Z"),
            ],
            &[],
            &mut fresh,
        );
        assert!(
            fresh.active.is_empty(),
            "the end landed after the start in time order"
        );
    }
}
