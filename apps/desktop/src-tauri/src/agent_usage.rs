//! Agent-usage capture: token counters from a runtime's own session log.
//!
//! One sidecar, `agent-usage.json`, guarded by the spool's interprocess lock
//! (the shift-commits precedent: one lock file per subsystem, not per file).
//! It is the durable registry of, per agent session
//! (`source|external_session_id`):
//!
//! - a read cursor per transcript file (offset plus file identity), so a pass
//!   resumes where the last one stopped and a rotated, truncated, or replaced
//!   transcript is re-read from the start instead of double-counted;
//! - per-(hour bucket, model, sidechain) cumulative token counters, each with
//!   a client id, a synced flag, and a rejected flag. Counters only restate
//!   upward: a re-read recomputes a total, it never adds to one.
//!
//! The reader parses ONLY the numeric usage fields, the model, the timestamp,
//! and the sidechain flag. Nothing the transcript says is retained, logged,
//! or uploaded: no line, prompt, tool argument, file path, or branch name.
//!
//! The timestamps are also the session's liveness. Claude Code's hooks are
//! registered for `SessionStart` and `SessionEnd` only, so between the two a
//! working agent sent nothing, and the server's thirty-minute staleness window
//! ended every longer shift half an hour after it began. A transcript that
//! keeps gaining entries is an agent that is still working, so the reader
//! carries that onto the spool as plain heartbeats, one per
//! `ACTIVITY_HEARTBEAT_SECONDS` of entries, stamped with the entry's own time.
//! The registry holds counts, plus the transcript's own path as the tail
//! pointer (it never leaves the machine). A missing or unreadable file is a
//! state, not an error: the counters simply do not advance.
//!
//! A session is not always one shift. The server ends a shift after
//! `AGENT_ACTIVE_WINDOW_SECONDS` without an event, or at the hook's end, and
//! never reopens it, so a goblin that waits most of an hour on CI, or a session
//! resumed with `claude --continue` (same session id), lost every minute after
//! the first pause. Activity after the server ended the current shift starts a
//! continuation shift instead, recorded under `<session id>~<unix start>` with
//! the repository the hook probed, so it keys the same identity and project;
//! the hook's next end closes it. The id derives from an entry's own time, so a
//! replayed pass names the same shift.
//!
//! A pass reads and rewrites the whole registry and stats every transcript in
//! it, so its cost must follow the sessions still working, not every session
//! ever seen. A session that is finished (fully synced, no spool line naming it,
//! no transcript growth, and quiet for `RETIRE_ENDED_AFTER_SECONDS` or
//! `RETIRE_OPEN_AFTER_SECONDS`) is moved out of the registry into one archive
//! file of its own, in the `agent-usage.json.retired` directory beside it. A
//! later spool line that names the session restores it from there exactly as it
//! was, cursors and client ids included, so a transcript that grows again is
//! read from where it stopped and nothing is counted twice.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::browser::write_if_changed_locked;
use crate::monitor::{iso8601, parse_iso8601, unix_now, AGENT_ACTIVE_WINDOW_SECONDS};
use crate::spool::{self, AgentEventKind, AgentSource, SpoolEvent, TokenCounters};
use crate::uploader::{RegistryRow, UploadVerdicts};

/// Upper bound on what one pass reads from one transcript file. The next pass
/// resumes at the stored offset, so a fast-growing log is caught up with
/// incrementally rather than in one unbounded read.
const MAX_FILE_BYTES_PER_PASS: u64 = 4 * 1024 * 1024;

/// The spacing of liveness heartbeats drawn from transcript entries: the Codex
/// terminal capture's heartbeat interval, and well inside the server's
/// thirty-minute staleness window, so a working session never reads as a gap.
const ACTIVITY_HEARTBEAT_SECONDS: u64 = 5 * 60;

/// Separates a session id from the start of one of its continuation shifts.
const CONTINUATION_SEPARATOR: char = '~';

/// How long a session whose shift the hook ended must be quiet before it
/// retires. The end closed its current shift, so only a resume can make it grow
/// again, and a resume spools a hook start that restores it. The wait only has
/// to outlast the lines still in flight around the end.
const RETIRE_ENDED_AFTER_SECONDS: u64 = 60 * 60;

/// How long a session no end was seen for must be quiet before it retires. It
/// may be a terminal left open and idle, whose transcript can grow again with
/// no hook line at all, so it keeps its cursors for a week before a restart of
/// its work depends on a hook line to bring them back.
const RETIRE_OPEN_AFTER_SECONDS: u64 = 7 * 24 * 60 * 60;

fn session_key(source: &AgentSource, external_session_id: &str) -> String {
    format!("{}|{external_session_id}", source.as_str())
}

fn continuation_id(external_session_id: &str, started_at: u64) -> String {
    format!("{external_session_id}{CONTINUATION_SEPARATOR}{started_at}")
}

/// The session a continuation shift's id belongs to, or `None` for any other id.
fn continuation_base(external_session_id: &str) -> Option<&str> {
    let (base, started_at) = external_session_id.rsplit_once(CONTINUATION_SEPARATOR)?;
    (!base.is_empty()
        && !started_at.is_empty()
        && started_at.bytes().all(|byte| byte.is_ascii_digit()))
    .then_some(base)
}

/// One session's counters for one hour bucket, carried end to end: captured
/// here, uploaded by the uploader, restated upward until the server accepts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageEntry {
    pub client_id: String,
    pub source: AgentSource,
    pub external_session_id: String,
    pub bucket_start_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default)]
    pub sidechain: bool,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
    #[serde(default)]
    pub synced: bool,
    #[serde(default)]
    pub rejected: bool,
    /// How many times the server answered `unknown_session` for the row.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub unknown_session_attempts: u32,
}

fn is_zero(count: &u32) -> bool {
    *count == 0
}

impl RegistryRow for UsageEntry {
    fn client_id(&self) -> &str {
        &self.client_id
    }

    fn happened_at(&self) -> Option<u64> {
        parse_iso8601(&self.bucket_start_at)
    }

    fn unknown_session_attempts(&self) -> u32 {
        self.unknown_session_attempts
    }

    fn verdict_state(&mut self) -> (&mut bool, &mut bool, &mut u32) {
        (
            &mut self.synced,
            &mut self.rejected,
            &mut self.unknown_session_attempts,
        )
    }
}

/// Resolved token counts. Unlike `TokenCounters` (what a hook reported, each
/// counter optional), these are sums: zero means "none counted", not "the
/// hook did not say".
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenTotals {
    #[serde(default)]
    input: u64,
    #[serde(default)]
    output: u64,
    #[serde(default)]
    cache_creation: u64,
    #[serde(default)]
    cache_read: u64,
}

impl TokenTotals {
    /// What a hook's cumulative counters resolve to; `None` when the hook
    /// reported nothing at all.
    fn from_counters(counters: &TokenCounters) -> Option<Self> {
        let totals = Self {
            input: counters.input_tokens.unwrap_or(0),
            output: counters.output_tokens.unwrap_or(0),
            cache_creation: counters.cache_creation_input_tokens.unwrap_or(0),
            cache_read: counters.cache_read_input_tokens.unwrap_or(0),
        };
        (counters.input_tokens.is_some()
            || counters.output_tokens.is_some()
            || counters.cache_creation_input_tokens.is_some()
            || counters.cache_read_input_tokens.is_some())
        .then_some(totals)
    }

    fn is_zero(&self) -> bool {
        self.input == 0 && self.output == 0 && self.cache_creation == 0 && self.cache_read == 0
    }

    fn add(&mut self, other: &Self) {
        self.input = self.input.saturating_add(other.input);
        self.output = self.output.saturating_add(other.output);
        self.cache_creation = self.cache_creation.saturating_add(other.cache_creation);
        self.cache_read = self.cache_read.saturating_add(other.cache_read);
    }

    fn take_max(&mut self, other: &Self) {
        self.input = self.input.max(other.input);
        self.output = self.output.max(other.output);
        self.cache_creation = self.cache_creation.max(other.cache_creation);
        self.cache_read = self.cache_read.max(other.cache_read);
    }
}

/// Totals for one (hour bucket, model, sidechain) combination, as one source
/// (one transcript file, or the hook's own reports) summed them.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BucketTotals {
    bucket_start_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(default)]
    sidechain: bool,
    #[serde(default)]
    tokens: TokenTotals,
}

/// The read cursor for one transcript file. `buckets` is this file's own
/// cumulative sums: a session's counters are the sum over its files plus the
/// hook-reported maximum, so re-reading a file recomputes its contribution
/// instead of adding to it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileUsage {
    /// Byte offset the next pass resumes at.
    #[serde(default)]
    offset: u64,
    /// Birth time of the file the offset belongs to, in unix milliseconds. A
    /// file replaced since has a different one and is re-read from the start.
    /// `None` on filesystems that cannot answer, where only the shrink check
    /// detects a fresh file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    identity_ms: Option<u64>,
    /// Set when an over-ceiling line forced the reader to skip ahead: bytes
    /// up to the next newline are the middle of that line and are discarded.
    #[serde(default)]
    resync: bool,
    #[serde(default)]
    buckets: Vec<BucketTotals>,
}

/// One agent session's capture state.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionUsage {
    #[serde(default, skip_serializing_if = "AgentSource::is_empty_for_default")]
    source: AgentSource,
    #[serde(default)]
    external_session_id: String,
    /// The transcript the hook pointed at; the tail pointer, never uploaded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    transcript_path: Option<String>,
    /// The session's working directory, remembered for the model heartbeat,
    /// which must carry one to satisfy the agent-event contract. Persisted
    /// because the spool line that carried it may have drained already.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
    /// The hook already named a model, so the transcript reader must not
    /// emit a model-bearing heartbeat for this session.
    #[serde(default)]
    model_from_hook: bool,
    /// The one model heartbeat this session ever emits has been emitted.
    #[serde(default)]
    heartbeat_sent: bool,
    /// Unix seconds of the latest transcript entry a liveness heartbeat was
    /// stamped with; the next one is due `ACTIVITY_HEARTBEAT_SECONDS` later.
    #[serde(default)]
    activity_heartbeat_at: u64,
    /// Unix seconds of the latest thing known about the session: the newest
    /// spool event folded for it or transcript entry read for it. Zero for a
    /// session an older build registered; `last_seen` covers that.
    #[serde(default)]
    last_seen_at: u64,
    /// The repository the hook probed at the session's start, carried onto
    /// every continuation shift so each keys the same identity and project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    repo_root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    repo_remote: Option<String>,
    /// The model the hook named or the transcript first did, so a
    /// continuation shift starts out naming it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    /// The continuation shift the session is working on, or `None` while it is
    /// still on the shift the hook opened under the session's own id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    shift_id: Option<String>,
    /// Unix seconds the current shift started at.
    #[serde(default)]
    shift_started_at: u64,
    /// Unix seconds of the latest event the server holds for the current shift,
    /// which its staleness window runs from. Zero for a session an older build
    /// registered, whose shift the server has long since ended.
    #[serde(default)]
    shift_last_event_at: u64,
    /// Unix seconds an end closed the current shift at.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    shift_ended_at: Option<u64>,
    /// Cumulative totals the hook itself reported (the `--input-tokens` flag
    /// family), kept as the maximum restatement in the hour of the first
    /// report, per model. Flag totals name no turn, so they cannot follow the
    /// transcript's per-entry bucketing.
    #[serde(default)]
    hook_buckets: Vec<BucketTotals>,
    /// Per transcript file (the main log and each `subagents/*.jsonl`
    /// sibling), keyed by path: the read cursor and the file's bucket sums.
    #[serde(default)]
    files: HashMap<String, FileUsage>,
}

impl SessionUsage {
    /// The latest moment anything is known to have happened to the session,
    /// across the fields an older registry already carries.
    fn last_seen(&self) -> u64 {
        self.last_seen_at
            .max(self.shift_last_event_at)
            .max(self.activity_heartbeat_at)
            .max(self.shift_ended_at.unwrap_or(0))
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageRegistry {
    #[serde(default)]
    sessions: HashMap<String, SessionUsage>,
    #[serde(default)]
    entries: Vec<UsageEntry>,
}

/// A finished session as its archive file holds it: the registry's own rows
/// for it, untouched, so restoring it resumes every cursor and client id.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetiredSession {
    session: SessionUsage,
    entries: Vec<UsageEntry>,
}

/// The directory the retired sessions live in, beside the registry.
fn retired_dir(agent_usage_path: &Path) -> PathBuf {
    let mut name = agent_usage_path.as_os_str().to_owned();
    name.push(".retired");
    PathBuf::from(name)
}

/// One retired session's file. The name is the hex of the session key's bytes:
/// distinct keys never share a name, and no key character is unsafe in a file
/// name or folds together on a case-insensitive filesystem. A key too long for
/// a file name fails to write, and its session simply stays active.
fn retired_session_path(retired_dir: &Path, key: &str) -> PathBuf {
    let hex: String = key.bytes().map(|byte| format!("{byte:02x}")).collect();
    retired_dir.join(format!("{hex}.json"))
}

/// The sessions the pending spool lines name, plus the session each
/// continuation shift's line belongs to: a line that names a session is the
/// only thing that can bring a retired one back.
fn pending_session_keys(events: &[SpoolEvent]) -> HashSet<String> {
    let mut keys = HashSet::new();
    for event in events {
        keys.insert(session_key(&event.source, &event.external_session_id));
        if let Some(base) = continuation_base(&event.external_session_id) {
            keys.insert(session_key(&event.source, base));
        }
    }
    keys
}

fn read_json_sidecar<T: Default + serde::de::DeserializeOwned>(path: &Path) -> T {
    let Ok(bytes) = std::fs::read(path) else {
        return T::default();
    };
    match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => {
            quarantine_corrupt(path, &bytes);
            T::default()
        }
    }
}

/// A sidecar that fails to parse is moved aside rather than left to fail
/// every future read; capture resumes from empty state instead of stalling
/// on a file nothing can repair.
fn quarantine_corrupt(path: &Path, bytes: &[u8]) {
    let mut name = path.as_os_str().to_owned();
    name.push(".corrupt");
    let _ = std::fs::write(PathBuf::from(name), bytes);
}

fn read_registry(path: &Path) -> UsageRegistry {
    read_json_sidecar(path)
}

#[cfg(test)]
thread_local! {
    static REGISTRY_WRITES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static FILE_TAILS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn write_registry(path: &Path, registry: &UsageRegistry) -> spool::SpoolResult<()> {
    #[cfg(test)]
    REGISTRY_WRITES.with(|writes| writes.set(writes.get() + 1));
    let bytes = serde_json::to_vec(registry).map_err(std::io::Error::other)?;
    write_if_changed_locked(path, &bytes)
}

/// The hour a timestamp belongs to, hour-aligned and back in ISO form.
fn hour_bucket(timestamp: &str) -> Option<String> {
    let at = parse_iso8601(timestamp)?;
    Some(iso8601(at - at % 3_600))
}

/// The files one session's counters sum over: the main transcript the hook
/// named, plus every `subagents/agent-*.jsonl` sibling beside it (Claude Code
/// writes sub-agent logs at `<slug>/<sessionId>/subagents/`). Nothing is
/// guessed: every path derives from the hook's `transcript_path`.
fn transcript_files(transcript_path: &Path) -> Vec<PathBuf> {
    let mut files = vec![transcript_path.to_path_buf()];
    let (Some(stem), Some(parent)) = (transcript_path.file_stem(), transcript_path.parent()) else {
        return files;
    };
    let subagents = parent.join(stem).join("subagents");
    if let Ok(read_dir) = std::fs::read_dir(subagents) {
        let mut extra: Vec<PathBuf> = read_dir
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("agent-") && name.ends_with(".jsonl"))
            })
            .collect();
        extra.sort();
        files.extend(extra);
    }
    files
}

/// What one transcript line is allowed to teach us. Every other key the line
/// carries - prompt text, tool calls, file paths - is never deserialized.
#[derive(Debug, Deserialize)]
struct TranscriptLine {
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default, rename = "isSidechain")]
    is_sidechain: bool,
    #[serde(default)]
    message: Option<TranscriptMessage>,
}

#[derive(Debug, Deserialize)]
struct TranscriptMessage {
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    usage: Option<TranscriptUsage>,
}

#[derive(Debug, Deserialize)]
struct TranscriptUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
}

/// The outcome of one incremental read: the cursor to persist, the model this
/// pass learned if the file named one, and the time of every entry it read.
struct FileTail {
    cursor: FileUsage,
    learned_model: Option<String>,
    activity: Vec<u64>,
}

/// A transcript entry the CLI wrote about itself rather than one a model
/// produced. Claude Code stamps such entries `<synthetic>`, and because the
/// reader keeps the *first* model a transcript names, one of them at the top of
/// a file became the shift's recorded model - a roster row reading
/// "Claude Code · <synthetic>". A name in angle brackets is a placeholder, not
/// a model, so the reader keeps looking; a shift that never names a real one
/// stays null and reads "not recorded", which is already the honest answer.
fn is_placeholder_model(model: &str) -> bool {
    model.starts_with('<') && model.ends_with('>')
}

/// Reads new complete lines from a transcript, starting at the cursor.
/// Returns `None` when nothing advanced - a missing file, an unreadable
/// file, or no new complete lines: all states, not errors.
///
/// A file whose identity changed or that shrank below the stored offset is
/// treated as a fresh read: its contribution is recomputed from its current
/// content, so no byte is ever counted twice. A trailing partial line is
/// left unconsumed until it completes; a complete line over the spool's
/// record ceiling is consumed without being parsed (and an unterminated one
/// forces `resync`, discarding its middle on later passes).
fn tail_file(path: &Path, cursor: &FileUsage) -> Option<FileTail> {
    #[cfg(test)]
    FILE_TAILS.with(|tails| tails.set(tails.get() + 1));
    let metadata = std::fs::metadata(path).ok()?;
    let len = metadata.len();
    let identity_ms = metadata
        .created()
        .ok()
        .and_then(|created| created.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since_epoch| since_epoch.as_millis() as u64);

    let fresh = cursor.identity_ms != identity_ms || len < cursor.offset;
    let (mut buckets, start, mut resync) = if fresh {
        (Vec::new(), 0, false)
    } else {
        (cursor.buckets.clone(), cursor.offset, cursor.resync)
    };
    if len == start {
        // No new bytes. A first sighting still records the identity so a
        // later replacement is detectable.
        if fresh {
            return Some(FileTail {
                cursor: FileUsage {
                    offset: start,
                    identity_ms,
                    resync,
                    buckets,
                },
                learned_model: None,
                activity: Vec::new(),
            });
        }
        return None;
    }

    let window_end = start.saturating_add(MAX_FILE_BYTES_PER_PASS).min(len);
    let mut file = std::fs::File::open(path).ok()?;
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = vec![0_u8; (window_end - start) as usize];
    file.read_exact(&mut bytes).ok()?;

    let mut offset = start;
    if resync {
        match bytes.iter().position(|byte| *byte == b'\n') {
            Some(index) => {
                offset += index as u64 + 1;
                resync = false;
            }
            None => {
                // Still inside the over-ceiling line. Advance only when more
                // of the file is known to follow; otherwise wait for it.
                if window_end < len {
                    return Some(FileTail {
                        cursor: FileUsage {
                            offset: window_end,
                            identity_ms,
                            resync: true,
                            buckets,
                        },
                        learned_model: None,
                        activity: Vec::new(),
                    });
                }
                return None;
            }
        }
    }

    let content = &bytes[(offset - start) as usize..];
    let complete_len = content
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map(|index| index + 1)
        .unwrap_or(0);

    if complete_len == 0 && window_end < len {
        // One unterminated line fills the whole per-pass window: it exceeds
        // every ceiling a record may have, so skip ahead and let the resync
        // above discard its middle on the following passes.
        return Some(FileTail {
            cursor: FileUsage {
                offset: window_end,
                identity_ms,
                resync: true,
                buckets,
            },
            learned_model: None,
            activity: Vec::new(),
        });
    }

    let mut learned_model: Option<String> = None;
    let mut activity: Vec<u64> = Vec::new();
    for line in content[..complete_len].split(|byte| *byte == b'\n') {
        if line.is_empty() || line.len() > spool::MAX_SPOOL_RECORD_BYTES {
            continue;
        }
        let Ok(entry) = serde_json::from_slice::<TranscriptLine>(line) else {
            continue;
        };
        activity.extend(entry.timestamp.as_deref().and_then(parse_iso8601));
        let model = entry
            .message
            .as_ref()
            .and_then(|message| message.model.as_deref())
            .map(str::trim)
            .filter(|model| !model.is_empty() && !is_placeholder_model(model));
        if learned_model.is_none() {
            learned_model = model.map(str::to_string);
        }
        let (Some(usage), Some(timestamp)) = (
            entry
                .message
                .as_ref()
                .and_then(|message| message.usage.as_ref()),
            entry.timestamp.as_deref(),
        ) else {
            continue;
        };
        let Some(bucket_start_at) = hour_bucket(timestamp) else {
            continue;
        };
        let tokens = TokenTotals {
            input: usage.input_tokens,
            output: usage.output_tokens,
            cache_creation: usage.cache_creation_input_tokens,
            cache_read: usage.cache_read_input_tokens,
        };
        match buckets.iter_mut().find(|bucket| {
            bucket.bucket_start_at == bucket_start_at
                && bucket.model.as_deref() == model
                && bucket.sidechain == entry.is_sidechain
        }) {
            Some(bucket) => bucket.tokens.add(&tokens),
            None => buckets.push(BucketTotals {
                bucket_start_at,
                model: model.map(str::to_string),
                sidechain: entry.is_sidechain,
                tokens,
            }),
        }
    }
    offset += complete_len as u64;

    if offset == cursor.offset && !fresh {
        return None;
    }
    Some(FileTail {
        cursor: FileUsage {
            offset,
            identity_ms,
            resync,
            buckets,
        },
        learned_model,
        activity,
    })
}

/// What the entry times a pass read put on the spool for one session, in time
/// order. Activity on a shift the server still holds carries a liveness
/// heartbeat, each at least `ACTIVITY_HEARTBEAT_SECONDS` after the one before
/// it. Activity after the server ended the shift - past its staleness window,
/// or after an end - starts a continuation shift at that entry. Everything is
/// stamped with the entry's own time rather than the read's, so a pass that
/// catches up on an hour of transcript lays the hour down across the hour.
fn shift_events(session: &mut SessionUsage, cwd: &str, activity: &mut [u64]) -> Vec<SpoolEvent> {
    activity.sort_unstable();
    let mut events = Vec::new();
    for &at in activity.iter() {
        let shift_over = match session.shift_ended_at {
            Some(ended_at) => at > ended_at,
            None => {
                session.shift_last_event_at == 0
                    || at
                        > session
                            .shift_last_event_at
                            .saturating_add(AGENT_ACTIVE_WINDOW_SECONDS)
            }
        };
        let event = if shift_over {
            let shift_id = continuation_id(&session.external_session_id, at);
            session.shift_id = Some(shift_id.clone());
            session.shift_started_at = at;
            session.shift_ended_at = None;
            AgentEventKind::Started
        } else if at
            >= session
                .activity_heartbeat_at
                .saturating_add(ACTIVITY_HEARTBEAT_SECONDS)
        {
            AgentEventKind::Heartbeat
        } else {
            continue;
        };
        session.activity_heartbeat_at = at;
        session.shift_last_event_at = session.shift_last_event_at.max(at);
        let started = event == AgentEventKind::Started;
        events.push(SpoolEvent {
            source: session.source.clone(),
            external_session_id: session
                .shift_id
                .clone()
                .unwrap_or_else(|| session.external_session_id.clone()),
            event,
            occurred_at: iso8601(at),
            cwd: Some(cwd.to_string()),
            start_head: None,
            repo_root: started.then(|| session.repo_root.clone()).flatten(),
            repo_remote: started.then(|| session.repo_remote.clone()).flatten(),
            model: started.then(|| session.model.clone()).flatten(),
            rule_id: None,
            transcript_path: None,
            tokens: None,
        });
    }
    events
}

/// Folds one spool event into the registry: registers the session, learns
/// the transcript path, the cwd, the repository, and whether the hook named a
/// model, takes the maximum of any hook-reported cumulative totals, and
/// follows the hook's start and end of the session's current shift. Returns
/// the end of the continuation shift the hook's end closed, if it closed one.
/// Every step is idempotent: a pass re-reads lines the uploader has not
/// drained yet.
fn fold_event(registry: &mut UsageRegistry, event: &SpoolEvent) -> Option<SpoolEvent> {
    // A continuation shift's own lines are this reader's output, not a session.
    if continuation_base(&event.external_session_id).is_some_and(|base| {
        registry
            .sessions
            .contains_key(&session_key(&event.source, base))
    }) {
        return None;
    }
    let key = session_key(&event.source, &event.external_session_id);
    let session = registry
        .sessions
        .entry(key)
        .or_insert_with(|| SessionUsage {
            source: event.source.clone(),
            external_session_id: event.external_session_id.clone(),
            ..SessionUsage::default()
        });
    if let Some(at) = parse_iso8601(&event.occurred_at) {
        session.last_seen_at = session.last_seen_at.max(at);
    }
    if let Some(cwd) = event.cwd.as_deref().filter(|cwd| !cwd.trim().is_empty()) {
        session.cwd = Some(cwd.to_string());
    }
    if let Some(model) = &event.model {
        session.model_from_hook = true;
        session.model.get_or_insert_with(|| model.clone());
    }
    if let Some(root) = event
        .repo_root
        .as_deref()
        .filter(|root| !root.trim().is_empty())
    {
        session.repo_root = Some(root.to_string());
    }
    if let Some(remote) = event
        .repo_remote
        .as_deref()
        .filter(|remote| !remote.trim().is_empty())
    {
        session.repo_remote = Some(remote.to_string());
    }
    if let Some(path) = event
        .transcript_path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
    {
        session.transcript_path = Some(path.to_string());
    }
    let shift_end = follow_shift(session, event);
    let totals = event.tokens.as_ref().and_then(TokenTotals::from_counters);
    if let (Some(totals), Some(bucket_start_at)) = (totals, hour_bucket(&event.occurred_at)) {
        match session
            .hook_buckets
            .iter_mut()
            .find(|bucket| bucket.model == event.model && !bucket.sidechain)
        {
            Some(bucket) => bucket.tokens.take_max(&totals),
            None => session.hook_buckets.push(BucketTotals {
                bucket_start_at,
                model: event.model.clone(),
                sidechain: false,
                tokens: totals,
            }),
        }
    }
    shift_end
}

/// Follows the hook's lifecycle events onto the session's current shift. A
/// start reaches the server under the session's own id, so it moves that
/// shift and no continuation; an end closes whichever shift is current, and a
/// continuation needs its own end, because the hook only ever names the
/// session. An end from before the current shift started is a replay of one
/// an earlier shift already took.
fn follow_shift(session: &mut SessionUsage, event: &SpoolEvent) -> Option<SpoolEvent> {
    let at = parse_iso8601(&event.occurred_at)?;
    match event.event {
        AgentEventKind::Started => {
            if session.shift_id.is_none() && session.shift_ended_at.is_none() {
                if session.shift_started_at == 0 {
                    session.shift_started_at = at;
                }
                session.shift_last_event_at = session.shift_last_event_at.max(at);
            }
            None
        }
        AgentEventKind::Ended
            if session.shift_ended_at.is_none() && at >= session.shift_started_at =>
        {
            session.shift_ended_at = Some(at);
            let shift_id = session.shift_id.clone()?;
            Some(SpoolEvent {
                source: session.source.clone(),
                external_session_id: shift_id,
                event: AgentEventKind::Ended,
                occurred_at: iso8601(at),
                cwd: session.cwd.clone(),
                start_head: None,
                repo_root: None,
                repo_remote: None,
                model: None,
                rule_id: None,
                transcript_path: None,
                tokens: None,
            })
        }
        _ => None,
    }
}

/// Rebuilds the uploadable entries from every session's file sums and hook
/// maximums. An entry's counters are the component-wise maximum of what was
/// there and what was computed, so a transcript that shrank never walks a
/// total the server may already have accepted backwards. Any advance re-arms
/// the entry for upload; a permanently rejected entry is left alone.
fn recompute_entries(registry: &mut UsageRegistry) {
    let UsageRegistry { sessions, entries } = registry;
    // An entry is found by its key, not by a scan of every entry per bucket.
    // The first of any duplicates wins, as the scan it replaces found it.
    let mut positions: HashMap<(String, String, Option<String>, bool), usize> =
        HashMap::with_capacity(entries.len());
    for (position, entry) in entries.iter().enumerate() {
        positions
            .entry((
                session_key(&entry.source, &entry.external_session_id),
                entry.bucket_start_at.clone(),
                entry.model.clone(),
                entry.sidechain,
            ))
            .or_insert(position);
    }

    for session in sessions.values() {
        let key = session_key(&session.source, &session.external_session_id);
        let mut totals: BTreeMap<(String, Option<String>, bool), TokenTotals> = BTreeMap::new();
        for file in session.files.values() {
            for bucket in &file.buckets {
                totals
                    .entry((
                        bucket.bucket_start_at.clone(),
                        bucket.model.clone(),
                        bucket.sidechain,
                    ))
                    .or_default()
                    .add(&bucket.tokens);
            }
        }
        for bucket in &session.hook_buckets {
            totals
                .entry((
                    bucket.bucket_start_at.clone(),
                    bucket.model.clone(),
                    bucket.sidechain,
                ))
                .or_default()
                .take_max(&bucket.tokens);
        }
        for ((bucket_start_at, model, sidechain), tokens) in totals {
            if tokens.is_zero() {
                continue;
            }
            let position_key = (key.clone(), bucket_start_at, model, sidechain);
            match positions.get(&position_key).copied() {
                Some(position) => {
                    let entry = &mut entries[position];
                    if entry.rejected {
                        continue;
                    }
                    let mut restated = TokenTotals {
                        input: entry.input_tokens,
                        output: entry.output_tokens,
                        cache_creation: entry.cache_creation_input_tokens,
                        cache_read: entry.cache_read_input_tokens,
                    };
                    restated.take_max(&tokens);
                    let changed = entry.input_tokens != restated.input
                        || entry.output_tokens != restated.output
                        || entry.cache_creation_input_tokens != restated.cache_creation
                        || entry.cache_read_input_tokens != restated.cache_read;
                    if changed {
                        entry.input_tokens = restated.input;
                        entry.output_tokens = restated.output;
                        entry.cache_creation_input_tokens = restated.cache_creation;
                        entry.cache_read_input_tokens = restated.cache_read;
                        entry.synced = false;
                    }
                }
                None => {
                    let (_, bucket_start_at, model, sidechain) = position_key;
                    entries.push(UsageEntry {
                        client_id: uuid::Uuid::new_v4().to_string(),
                        source: session.source.clone(),
                        external_session_id: session.external_session_id.clone(),
                        bucket_start_at,
                        model,
                        sidechain,
                        input_tokens: tokens.input,
                        output_tokens: tokens.output,
                        cache_creation_input_tokens: tokens.cache_creation,
                        cache_read_input_tokens: tokens.cache_read,
                        synced: false,
                        rejected: false,
                        unknown_session_attempts: 0,
                    });
                }
            }
        }
    }
}

/// Whether the session has done nothing for long enough to retire, by the
/// quiet each kind of session must show. `now` before the session's last
/// activity (a skewed clock) reads as not quiet.
fn is_quiet_long_enough(session: &SessionUsage, now: u64) -> bool {
    let wait = if session.shift_ended_at.is_some() {
        RETIRE_ENDED_AFTER_SECONDS
    } else {
        RETIRE_OPEN_AFTER_SECONDS
    };
    now >= session.last_seen().saturating_add(wait)
}

/// Moves every finished session out of the registry into its archive file. A
/// session is finished when nothing this pass touched it (`busy_keys`: the
/// sessions a spool line names or a transcript advanced for), every one of its
/// entries has a final verdict from the server, and it has been quiet long
/// enough. The archive is written before the registry, so a crash between the
/// two leaves a copy in both places, which is harmless: the next retirement
/// overwrites the archive, and a restore only looks at sessions the registry
/// does not hold. A session whose archive cannot be written stays where it is.
fn retire_finished_sessions(
    registry: &mut UsageRegistry,
    retired_dir: &Path,
    busy_keys: &HashSet<String>,
    now: u64,
) {
    let unsettled: HashSet<String> = registry
        .entries
        .iter()
        .filter(|entry| !entry.synced && !entry.rejected)
        .map(|entry| session_key(&entry.source, &entry.external_session_id))
        .collect();
    let finished: HashSet<String> = registry
        .sessions
        .iter()
        .filter(|(key, session)| {
            !busy_keys.contains(*key)
                && !unsettled.contains(*key)
                && is_quiet_long_enough(session, now)
        })
        .map(|(key, _)| key.clone())
        .collect();
    if finished.is_empty() || std::fs::create_dir_all(retired_dir).is_err() {
        return;
    }

    let (retiring, kept): (Vec<UsageEntry>, Vec<UsageEntry>) =
        std::mem::take(&mut registry.entries)
            .into_iter()
            .partition(|entry| {
                finished.contains(&session_key(&entry.source, &entry.external_session_id))
            });
    registry.entries = kept;
    let mut entries_by_session: HashMap<String, Vec<UsageEntry>> = HashMap::new();
    for entry in retiring {
        entries_by_session
            .entry(session_key(&entry.source, &entry.external_session_id))
            .or_default()
            .push(entry);
    }

    for key in finished {
        let Some(session) = registry.sessions.remove(&key) else {
            continue;
        };
        let retired = RetiredSession {
            session,
            entries: entries_by_session.remove(&key).unwrap_or_default(),
        };
        let is_archived = serde_json::to_vec(&retired)
            .map_err(std::io::Error::other)
            .and_then(|bytes| {
                write_if_changed_locked(&retired_session_path(retired_dir, &key), &bytes)
            })
            .is_ok();
        if !is_archived {
            registry.sessions.insert(key, retired.session);
            registry.entries.extend(retired.entries);
        }
    }
}

/// Brings back every retired session a pending spool line names, with the
/// cursors, counters and client ids it retired with, so a transcript that grew
/// again is read from where it stopped and its entries restate upward. Returns
/// the archive files to remove once the registry holding the sessions is
/// written. A corrupt archive file reads as absent and the session starts over.
fn restore_retired_sessions(
    registry: &mut UsageRegistry,
    retired_dir: &Path,
    pending_keys: &HashSet<String>,
) -> Vec<PathBuf> {
    let mut restored_files = Vec::new();
    for key in pending_keys {
        if registry.sessions.contains_key(key) {
            continue;
        }
        let path = retired_session_path(retired_dir, key);
        let Some(retired) = read_json_sidecar::<Option<RetiredSession>>(&path) else {
            continue;
        };
        registry.sessions.insert(key.clone(), retired.session);
        registry.entries.extend(retired.entries);
        restored_files.push(path);
    }
    restored_files
}

/// A model the transcript reader learned, ready to ride one heartbeat.
struct PendingHeartbeat {
    key: String,
    source: AgentSource,
    external_session_id: String,
    cwd: String,
    model: String,
}

/// Reads pending agent-spool lines without truncating them - the uploader's
/// own agent-spool drain owns truncation - and tails every known transcript
/// incrementally. Replay is safe because every step is idempotent: offsets
/// make a transcript entry count exactly once, hook totals keep the maximum,
/// the model heartbeat fires once per session, and a shift's start and end
/// are recorded once against the registry's own shift state.
///
/// When the reader first learns a session's model (Claude Code's hook
/// payload never carries one; the transcript names it within seconds of the
/// first turn), it appends ONE model-bearing heartbeat to the agent spool,
/// which uploads through the normal `/agent-sessions` drain so the server
/// can coalesce the model onto the open session. Never emitted when the hook
/// already named a model.
pub fn capture_from_spool(agent_path: &Path, agent_usage_path: &Path) {
    capture(agent_path, agent_usage_path, unix_now());
}

/// One capture pass at `now`, which decides which sessions have been quiet long
/// enough to retire.
fn capture(agent_path: &Path, agent_usage_path: &Path, now: u64) {
    let Ok(pending) = spool::read_pending(agent_path) else {
        return;
    };
    let retired_dir = retired_dir(agent_usage_path);
    let pending_keys = pending_session_keys(&pending.events);

    if !pending.events.is_empty() {
        let folded = spool::with_lock(agent_usage_path, || {
            let mut registry = read_registry(agent_usage_path);
            let restored_files =
                restore_retired_sessions(&mut registry, &retired_dir, &pending_keys);
            let shift_ends: Vec<SpoolEvent> = pending
                .events
                .iter()
                .filter_map(|event| fold_event(&mut registry, event))
                .collect();
            write_registry(agent_usage_path, &registry)?;
            for file in restored_files {
                let _ = std::fs::remove_file(file);
            }
            Ok(shift_ends)
        });
        let Ok(shift_ends) = folded else {
            return;
        };
        // Appended before anything this pass reads from the transcripts, so a
        // shift's end always precedes the next shift's start on the spool.
        for end in &shift_ends {
            let _ = spool::append(agent_path, end);
        }
    }

    // The tail plan: every session's main transcript plus its sub-agent
    // siblings, with the cursor each file resumes from. Transcript IO runs
    // unlocked: it can take real time, and nothing else needs the sidecar
    // lock held while it runs.
    let plan: Vec<(String, String, PathBuf, FileUsage)> =
        spool::with_lock(agent_usage_path, || {
            let registry = read_registry(agent_usage_path);
            let mut plan = Vec::new();
            for (key, session) in &registry.sessions {
                let Some(transcript) = session.transcript_path.as_deref() else {
                    continue;
                };
                for file in transcript_files(Path::new(transcript)) {
                    let file_key = file.to_string_lossy().into_owned();
                    let cursor = session.files.get(&file_key).cloned().unwrap_or_default();
                    plan.push((key.clone(), file_key, file, cursor));
                }
            }
            Ok(plan)
        })
        .unwrap_or_default();

    let mut tails: Vec<(String, String, FileTail)> = Vec::new();
    for (key, file_key, path, cursor) in plan {
        if let Some(tail) = tail_file(&path, &cursor) {
            tails.push((key, file_key, tail));
        }
    }
    // A quiet pass still runs the merge below: it is where finished sessions
    // retire, and the registry it reads holds only the sessions still active.
    let mut busy_keys = pending_keys;
    busy_keys.extend(tails.iter().map(|(key, _, _)| key.clone()));

    let mut heartbeats: Vec<PendingHeartbeat> = Vec::new();
    let mut shift_lines: Vec<SpoolEvent> = Vec::new();
    let merged = spool::with_lock(agent_usage_path, || {
        let mut registry = read_registry(agent_usage_path);
        let mut activity: HashMap<String, Vec<u64>> = HashMap::new();
        for (key, file_key, tail) in tails {
            let Some(session) = registry.sessions.get_mut(&key) else {
                continue;
            };
            activity
                .entry(key.clone())
                .or_default()
                .extend(tail.activity);
            if let Some(model) = &tail.learned_model {
                session.model.get_or_insert_with(|| model.clone());
                if !session.heartbeat_sent && !session.model_from_hook {
                    if let Some(cwd) = session.cwd.clone() {
                        heartbeats.push(PendingHeartbeat {
                            key: key.clone(),
                            source: session.source.clone(),
                            external_session_id: session.external_session_id.clone(),
                            cwd,
                            model: model.clone(),
                        });
                    }
                }
            }
            session.files.insert(file_key, tail.cursor);
        }
        // Main log and sub-agent logs alike: any of them growing is the
        // session working. The cursor has already moved past these entries, so
        // a failed append below loses one pass of liveness rather than
        // repeating it; the next entries the session writes carry it on.
        for (key, mut times) in activity {
            let Some(session) = registry.sessions.get_mut(&key) else {
                continue;
            };
            if let Some(latest) = times.iter().copied().max() {
                session.last_seen_at = session.last_seen_at.max(latest);
            }
            let Some(cwd) = session.cwd.clone() else {
                continue;
            };
            shift_lines.extend(shift_events(session, &cwd, &mut times));
        }
        recompute_entries(&mut registry);
        retire_finished_sessions(&mut registry, &retired_dir, &busy_keys, now);
        write_registry(agent_usage_path, &registry)
    });
    if merged.is_err() {
        return;
    }

    // Heartbeats append through the same path the hook binary uses, so they
    // drain and upload exactly like a hook's own events. The sent flags are
    // recorded only once the lines are on disk, in one registry write for the
    // whole pass: each write rewrites the whole registry, and at the scale it
    // once reached a write per heartbeat turned a backlog into an hour-long
    // pass that held up the uploads behind it. A failed append retries next
    // pass, and a crash between append and flag can only ever emit one
    // duplicate per session, which the server's model coalesce absorbs.
    let mut sent_keys: Vec<String> = Vec::new();
    for heartbeat in heartbeats {
        let event = SpoolEvent {
            source: heartbeat.source,
            external_session_id: heartbeat.external_session_id,
            event: AgentEventKind::Heartbeat,
            occurred_at: spool::now_iso8601(),
            cwd: Some(heartbeat.cwd),
            model: Some(heartbeat.model),
            start_head: None,
            repo_root: None,
            repo_remote: None,
            rule_id: None,
            transcript_path: None,
            tokens: None,
        };
        if spool::append(agent_path, &event).is_ok() {
            sent_keys.push(heartbeat.key);
        }
    }
    if !sent_keys.is_empty() {
        let _ = spool::with_lock(agent_usage_path, || {
            let mut registry = read_registry(agent_usage_path);
            for key in &sent_keys {
                if let Some(session) = registry.sessions.get_mut(key) {
                    session.heartbeat_sent = true;
                }
            }
            write_registry(agent_usage_path, &registry)
        });
    }

    // Liveness heartbeats and continuation starts, no model heartbeat among
    // them: the server advances the shift's last event to each heartbeat and
    // opens a shift at each start, and the monitor keeps the agent active
    // through both.
    for line in &shift_lines {
        let _ = spool::append(agent_path, line);
    }
}

/// Every entry the uploader has not yet gotten a permanent verdict for.
pub fn unsynced(agent_usage_path: &Path) -> spool::SpoolResult<Vec<UsageEntry>> {
    spool::with_lock(agent_usage_path, || {
        Ok(read_registry(agent_usage_path)
            .entries
            .into_iter()
            .filter(|entry| !entry.synced && !entry.rejected)
            .collect())
    })
}

/// Records one upload pass's verdicts in one registry write. Returns how many
/// entries the `unknown_session` bound gave up.
pub fn record_verdicts(
    agent_usage_path: &Path,
    verdicts: &UploadVerdicts<UsageEntry>,
) -> spool::SpoolResult<usize> {
    spool::with_lock(agent_usage_path, || {
        let mut registry = read_registry(agent_usage_path);
        let mut given_up = 0;
        for entry in &mut registry.entries {
            if verdicts.apply(entry) {
                given_up += 1;
            }
        }
        write_registry(agent_usage_path, &registry)?;
        Ok(given_up)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "siqshift-agent-usage-{name}-{}-{}",
            std::process::id(),
            unique_suffix()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir creates");
        dir
    }

    fn unique_suffix() -> u64 {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    fn source() -> AgentSource {
        AgentSource::parse("claude_code").expect("canonical source parses")
    }

    /// One assistant transcript line, with exactly the keys the reader may
    /// learn from (plus one content key it must ignore).
    fn assistant_line(
        timestamp: &str,
        model: &str,
        sidechain: bool,
        input: u64,
        output: u64,
        cache_creation: u64,
        cache_read: u64,
    ) -> String {
        serde_json::json!({
            "timestamp": timestamp,
            "sessionId": "session-1",
            "cwd": "C:/dev/siqshift",
            "isSidechain": sidechain,
            "message": {
                "model": model,
                "content": [{"type": "text", "text": "words the reader never keeps"}],
                "usage": {
                    "input_tokens": input,
                    "output_tokens": output,
                    "cache_creation_input_tokens": cache_creation,
                    "cache_read_input_tokens": cache_read,
                },
            },
        })
        .to_string()
    }

    fn write_transcript(path: &Path, lines: &[String]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("transcript dir creates");
        }
        let mut body = lines.join("\n");
        if !body.is_empty() {
            body.push('\n');
        }
        std::fs::write(path, body).expect("transcript writes");
    }

    fn append_to_transcript(path: &Path, text: &str) {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(path)
            .expect("transcript opens");
        file.write_all(text.as_bytes()).expect("transcript appends");
    }

    fn started_event(transcript: &Path, occurred_at: &str, model: Option<&str>) -> SpoolEvent {
        SpoolEvent {
            source: source(),
            external_session_id: "session-1".to_string(),
            event: AgentEventKind::Started,
            occurred_at: occurred_at.to_string(),
            cwd: Some("C:/dev/siqshift".to_string()),
            start_head: None,
            repo_root: None,
            repo_remote: None,
            model: model.map(str::to_string),
            rule_id: None,
            transcript_path: Some(transcript.to_string_lossy().into_owned()),
            tokens: None,
        }
    }

    fn one_entry(registry: &UsageRegistry) -> &UsageEntry {
        assert_eq!(registry.entries.len(), 1, "exactly one entry is expected");
        &registry.entries[0]
    }

    #[test]
    fn a_transcripts_usage_lands_in_an_hour_aligned_bucket() {
        let dir = temp_dir("normal");
        let agent_path = dir.join("agent-spool.jsonl");
        let usage_path = dir.join("agent-usage.json");
        let transcript = dir.join("session-1.jsonl");
        write_transcript(
            &transcript,
            &[
                assistant_line(
                    "2026-08-06T10:15:00Z",
                    "claude-opus-4.1",
                    false,
                    100,
                    20,
                    30,
                    40,
                ),
                assistant_line(
                    "2026-08-06T10:45:00Z",
                    "claude-opus-4.1",
                    false,
                    50,
                    10,
                    0,
                    5,
                ),
                assistant_line("2026-08-06T11:05:00Z", "claude-opus-4.1", false, 7, 3, 0, 0),
            ],
        );
        spool::append(
            &agent_path,
            &started_event(&transcript, "2026-08-06T10:00:00Z", None),
        )
        .expect("append succeeds");

        capture_from_spool(&agent_path, &usage_path);

        let registry = read_registry(&usage_path);
        assert_eq!(registry.entries.len(), 2, "one entry per hour bucket");
        let ten = registry
            .entries
            .iter()
            .find(|entry| entry.bucket_start_at == "2026-08-06T10:00:00Z")
            .expect("the ten o'clock bucket exists");
        assert_eq!(ten.source, source());
        assert_eq!(ten.external_session_id, "session-1");
        assert_eq!(ten.model.as_deref(), Some("claude-opus-4.1"));
        assert!(!ten.sidechain);
        assert_eq!(ten.input_tokens, 150);
        assert_eq!(ten.output_tokens, 30);
        assert_eq!(ten.cache_creation_input_tokens, 30);
        assert_eq!(ten.cache_read_input_tokens, 45);
        assert!(!ten.client_id.is_empty());
        assert!(!ten.synced && !ten.rejected);
        let eleven = registry
            .entries
            .iter()
            .find(|entry| entry.bucket_start_at == "2026-08-06T11:00:00Z")
            .expect("the eleven o'clock bucket exists");
        assert_eq!(eleven.input_tokens, 7);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_grown_transcript_advances_the_counters_exactly_once() {
        let dir = temp_dir("grew");
        let agent_path = dir.join("agent-spool.jsonl");
        let usage_path = dir.join("agent-usage.json");
        let transcript = dir.join("session-1.jsonl");
        write_transcript(
            &transcript,
            &[assistant_line(
                "2026-08-06T10:15:00Z",
                "claude-opus-4.1",
                false,
                100,
                20,
                0,
                0,
            )],
        );
        spool::append(
            &agent_path,
            &started_event(&transcript, "2026-08-06T10:00:00Z", None),
        )
        .expect("append succeeds");

        capture_from_spool(&agent_path, &usage_path);
        let first = read_registry(&usage_path);
        assert_eq!(one_entry(&first).input_tokens, 100);
        let offset_after_first = one_file_offset(&first);
        assert_eq!(
            offset_after_first,
            std::fs::metadata(&transcript).expect("metadata").len()
        );

        // The transcript grows between passes; the uploader has not truncated
        // the spool yet, so the same Started line replays too.
        append_to_transcript(
            &transcript,
            &(assistant_line(
                "2026-08-06T10:50:00Z",
                "claude-opus-4.1",
                false,
                60,
                5,
                1,
                2,
            ) + "\n"),
        );
        capture_from_spool(&agent_path, &usage_path);
        let second = read_registry(&usage_path);
        let grown = one_entry(&second);
        assert_eq!(grown.input_tokens, 160, "only the new line adds");
        assert_eq!(grown.output_tokens, 25);
        assert_eq!(grown.cache_creation_input_tokens, 1);
        assert_eq!(grown.cache_read_input_tokens, 2);
        assert_eq!(
            grown.client_id,
            one_entry(&first).client_id,
            "the bucket restates the same entry"
        );

        // A pass with no growth changes nothing.
        capture_from_spool(&agent_path, &usage_path);
        let third = read_registry(&usage_path);
        assert_eq!(third.entries, second.entries);

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn one_file_offset(registry: &UsageRegistry) -> u64 {
        let session = registry.sessions.values().next().expect("a session exists");
        assert_eq!(session.files.len(), 1, "exactly one file cursor");
        session
            .files
            .values()
            .next()
            .expect("a cursor exists")
            .offset
    }

    #[test]
    fn a_truncated_transcript_is_re_read_without_double_counting() {
        let dir = temp_dir("truncated");
        let agent_path = dir.join("agent-spool.jsonl");
        let usage_path = dir.join("agent-usage.json");
        let transcript = dir.join("session-1.jsonl");
        let first_line = assistant_line(
            "2026-08-06T10:15:00Z",
            "claude-opus-4.1",
            false,
            100,
            20,
            0,
            0,
        );
        let second_line = assistant_line(
            "2026-08-06T10:20:00Z",
            "claude-opus-4.1",
            false,
            80,
            10,
            0,
            0,
        );
        write_transcript(&transcript, &[first_line.clone(), second_line]);
        spool::append(
            &agent_path,
            &started_event(&transcript, "2026-08-06T10:00:00Z", None),
        )
        .expect("append succeeds");
        capture_from_spool(&agent_path, &usage_path);
        assert_eq!(one_entry(&read_registry(&usage_path)).input_tokens, 180);

        // Truncated in place: same identity, shorter than the stored offset.
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(&transcript)
            .expect("transcript opens");
        file.set_len((first_line.len() + 1) as u64)
            .expect("transcript truncates");
        capture_from_spool(&agent_path, &usage_path);

        let registry = read_registry(&usage_path);
        assert_eq!(
            one_entry(&registry).input_tokens,
            180,
            "a restated total never walks backwards and never double-counts"
        );
        assert_eq!(
            one_file_offset(&registry),
            (first_line.len() + 1) as u64,
            "the cursor restarted from the shrunken file"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_replaced_transcript_starts_a_fresh_read() {
        let dir = temp_dir("replaced");
        let transcript = dir.join("session-1.jsonl");
        write_transcript(
            &transcript,
            &[
                assistant_line(
                    "2026-08-06T10:15:00Z",
                    "claude-opus-4.1",
                    false,
                    40,
                    5,
                    0,
                    0,
                ),
                assistant_line(
                    "2026-08-06T10:20:00Z",
                    "claude-opus-4.1",
                    false,
                    60,
                    5,
                    0,
                    0,
                ),
            ],
        );
        let stale_cursor = FileUsage {
            offset: 10,
            identity_ms: Some(1),
            resync: false,
            buckets: vec![BucketTotals {
                bucket_start_at: "2026-08-06T10:00:00Z".to_string(),
                model: Some("claude-opus-4.1".to_string()),
                sidechain: false,
                tokens: TokenTotals {
                    input: 100,
                    output: 10,
                    cache_creation: 0,
                    cache_read: 0,
                },
            }],
        };

        // A different identity at the same path is a new file: its
        // contribution is recomputed from its current content rather than
        // resumed mid-stream.
        let tail = tail_file(&transcript, &stale_cursor).expect("the replaced file reads");
        assert_eq!(
            tail.cursor.offset,
            std::fs::metadata(&transcript).expect("metadata").len()
        );
        assert_eq!(tail.cursor.buckets.len(), 1);
        assert_eq!(tail.cursor.buckets[0].tokens.input, 100);
        assert_eq!(tail.cursor.buckets[0].tokens.output, 10);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_half_written_last_line_waits_for_its_newline() {
        let dir = temp_dir("partial-line");
        let agent_path = dir.join("agent-spool.jsonl");
        let usage_path = dir.join("agent-usage.json");
        let transcript = dir.join("session-1.jsonl");
        let first_line = assistant_line(
            "2026-08-06T10:15:00Z",
            "claude-opus-4.1",
            false,
            100,
            20,
            0,
            0,
        );
        let second_line = assistant_line(
            "2026-08-06T10:20:00Z",
            "claude-opus-4.1",
            false,
            60,
            5,
            0,
            0,
        );
        let partial = &second_line[..second_line.len() / 2];
        write_transcript(&transcript, &[first_line]);
        append_to_transcript(&transcript, partial);
        spool::append(
            &agent_path,
            &started_event(&transcript, "2026-08-06T10:00:00Z", None),
        )
        .expect("append succeeds");

        capture_from_spool(&agent_path, &usage_path);
        let registry = read_registry(&usage_path);
        assert_eq!(
            one_entry(&registry).input_tokens,
            100,
            "the unterminated line is left unconsumed"
        );

        append_to_transcript(
            &transcript,
            &format!("{}\n", &second_line[second_line.len() / 2..]),
        );
        capture_from_spool(&agent_path, &usage_path);
        let registry = read_registry(&usage_path);
        assert_eq!(
            one_entry(&registry).input_tokens,
            160,
            "the completed line counts exactly once"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sub_agent_transcripts_sum_beside_the_main_log_under_the_sidechain_flag() {
        let dir = temp_dir("subagents");
        let agent_path = dir.join("agent-spool.jsonl");
        let usage_path = dir.join("agent-usage.json");
        let transcript = dir.join("session-1.jsonl");
        write_transcript(
            &transcript,
            &[assistant_line(
                "2026-08-06T10:15:00Z",
                "claude-opus-4.1",
                false,
                100,
                20,
                0,
                0,
            )],
        );
        let subagent = dir
            .join("session-1")
            .join("subagents")
            .join("agent-a1.jsonl");
        write_transcript(
            &subagent,
            &[assistant_line(
                "2026-08-06T10:25:00Z",
                "claude-opus-4.1",
                true,
                40,
                8,
                2,
                0,
            )],
        );
        // A sibling that is not a sub-agent log never participates.
        write_transcript(
            &dir.join("session-1").join("subagents").join("notes.jsonl"),
            &[assistant_line(
                "2026-08-06T10:26:00Z",
                "claude-opus-4.1",
                true,
                999,
                0,
                0,
                0,
            )],
        );
        spool::append(
            &agent_path,
            &started_event(&transcript, "2026-08-06T10:00:00Z", None),
        )
        .expect("append succeeds");

        capture_from_spool(&agent_path, &usage_path);

        let registry = read_registry(&usage_path);
        assert_eq!(registry.entries.len(), 2, "main and sidechain split");
        let main = registry
            .entries
            .iter()
            .find(|entry| !entry.sidechain)
            .expect("the main entry exists");
        assert_eq!(main.input_tokens, 100);
        let sidechain = registry
            .entries
            .iter()
            .find(|entry| entry.sidechain)
            .expect("the sidechain entry exists");
        assert_eq!(sidechain.input_tokens, 40);
        assert_eq!(sidechain.output_tokens, 8);
        assert_eq!(sidechain.cache_creation_input_tokens, 2);
        assert_eq!(sidechain.bucket_start_at, "2026-08-06T10:00:00Z");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_transcript_is_a_state_not_an_error() {
        let dir = temp_dir("missing-file");
        let agent_path = dir.join("agent-spool.jsonl");
        let usage_path = dir.join("agent-usage.json");
        let transcript = dir.join("never-written.jsonl");
        spool::append(
            &agent_path,
            &started_event(&transcript, "2026-08-06T10:00:00Z", None),
        )
        .expect("append succeeds");

        capture_from_spool(&agent_path, &usage_path);

        let registry = read_registry(&usage_path);
        assert!(registry.entries.is_empty(), "no counters advance");
        assert_eq!(registry.sessions.len(), 1, "the session still registers");
        let pending = spool::read_pending(&agent_path).expect("the spool reads");
        assert_eq!(pending.events.len(), 1, "capture never truncates the spool");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hook_reported_cumulative_totals_keep_the_maximum() {
        let dir = temp_dir("hook-totals");
        let agent_path = dir.join("agent-spool.jsonl");
        let usage_path = dir.join("agent-usage.json");
        let transcript = dir.join("session-1.jsonl");
        let mut event = started_event(&transcript, "2026-08-06T10:00:00Z", Some("pi-model"));
        event.tokens = Some(TokenCounters {
            input_tokens: Some(100),
            output_tokens: Some(10),
            cache_creation_input_tokens: None,
            cache_read_input_tokens: None,
        });
        spool::append(&agent_path, &event).expect("append succeeds");
        let mut restated = event.clone();
        restated.event = AgentEventKind::Heartbeat;
        restated.occurred_at = "2026-08-06T10:30:00Z".to_string();
        restated.tokens = Some(TokenCounters {
            input_tokens: Some(150),
            output_tokens: Some(12),
            cache_creation_input_tokens: None,
            cache_read_input_tokens: None,
        });
        spool::append(&agent_path, &restated).expect("append succeeds");
        // A smaller restatement (a restarted counter) never walks the total back.
        let mut regressed = restated.clone();
        regressed.occurred_at = "2026-08-06T10:31:00Z".to_string();
        regressed.tokens = Some(TokenCounters {
            input_tokens: Some(120),
            output_tokens: Some(12),
            cache_creation_input_tokens: None,
            cache_read_input_tokens: None,
        });
        spool::append(&agent_path, &regressed).expect("append succeeds");

        capture_from_spool(&agent_path, &usage_path);

        let registry = read_registry(&usage_path);
        let entry = one_entry(&registry);
        assert_eq!(entry.input_tokens, 150, "the maximum restatement wins");
        assert_eq!(entry.output_tokens, 12);
        assert_eq!(entry.bucket_start_at, "2026-08-06T10:00:00Z");
        assert_eq!(entry.model.as_deref(), Some("pi-model"));
        assert!(!entry.sidechain);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The roster showed rows reading "Claude Code · <synthetic>": Claude Code
    /// stamps the entries it writes about itself with that placeholder, and
    /// one of them sitting above the first real assistant turn became the
    /// shift's model. The reader keeps looking past it.
    #[test]
    fn a_placeholder_model_is_skipped_for_the_first_real_one() {
        let dir = temp_dir("placeholder-model");
        let agent_path = dir.join("agent-spool.jsonl");
        let usage_path = dir.join("agent-usage.json");
        let transcript = dir.join("session-1.jsonl");
        write_transcript(
            &transcript,
            &[
                assistant_line("2026-08-06T10:14:00Z", "<synthetic>", false, 0, 0, 0, 0),
                assistant_line(
                    "2026-08-06T10:15:00Z",
                    "claude-opus-4.1",
                    false,
                    100,
                    20,
                    0,
                    0,
                ),
            ],
        );
        spool::append(
            &agent_path,
            &started_event(&transcript, "2026-08-06T10:00:00Z", None),
        )
        .expect("append succeeds");

        capture_from_spool(&agent_path, &usage_path);

        let pending = spool::read_pending(&agent_path).expect("the spool reads");
        let heartbeat = pending
            .events
            .iter()
            .find(|event| event.event == AgentEventKind::Heartbeat)
            .expect("a model heartbeat is appended");
        assert_eq!(heartbeat.model.as_deref(), Some("claude-opus-4.1"));
    }

    /// A transcript that names nothing but placeholders records no model at
    /// all, which reads "not recorded" - never the placeholder itself.
    #[test]
    fn a_transcript_of_only_placeholders_names_no_model() {
        let dir = temp_dir("placeholder-only");
        let agent_path = dir.join("agent-spool.jsonl");
        let usage_path = dir.join("agent-usage.json");
        let transcript = dir.join("session-1.jsonl");
        write_transcript(
            &transcript,
            &[assistant_line(
                "2026-08-06T10:14:00Z",
                "<synthetic>",
                false,
                10,
                2,
                0,
                0,
            )],
        );
        spool::append(
            &agent_path,
            &started_event(&transcript, "2026-08-06T10:00:00Z", None),
        )
        .expect("append succeeds");

        capture_from_spool(&agent_path, &usage_path);

        let pending = spool::read_pending(&agent_path).expect("the spool reads");
        assert!(
            !pending
                .events
                .iter()
                .any(|event| event.event == AgentEventKind::Heartbeat && event.model.is_some()),
            "no model heartbeat rides a placeholder"
        );
    }

    #[test]
    fn the_first_model_the_transcript_names_rides_exactly_one_heartbeat() {
        let dir = temp_dir("heartbeat");
        let agent_path = dir.join("agent-spool.jsonl");
        let usage_path = dir.join("agent-usage.json");
        let transcript = dir.join("session-1.jsonl");
        write_transcript(
            &transcript,
            &[assistant_line(
                "2026-08-06T10:15:00Z",
                "claude-opus-4.1",
                false,
                100,
                20,
                0,
                0,
            )],
        );
        // Claude Code's hook payload names no model; the transcript does.
        spool::append(
            &agent_path,
            &started_event(&transcript, "2026-08-06T10:00:00Z", None),
        )
        .expect("append succeeds");

        capture_from_spool(&agent_path, &usage_path);

        let pending = spool::read_pending(&agent_path).expect("the spool reads");
        let heartbeats: Vec<&SpoolEvent> = pending
            .events
            .iter()
            .filter(|event| event.event == AgentEventKind::Heartbeat && event.model.is_some())
            .collect();
        assert_eq!(heartbeats.len(), 1, "one model heartbeat is appended");
        let heartbeat = heartbeats[0];
        assert_eq!(heartbeat.model.as_deref(), Some("claude-opus-4.1"));
        assert_eq!(heartbeat.source, source());
        assert_eq!(heartbeat.external_session_id, "session-1");
        assert_eq!(heartbeat.cwd.as_deref(), Some("C:/dev/siqshift"));
        assert!(heartbeat.transcript_path.is_none() && heartbeat.tokens.is_none());
        assert!(
            read_registry(&usage_path)
                .sessions
                .values()
                .next()
                .expect("a session exists")
                .heartbeat_sent,
            "the emission is recorded"
        );

        // Later passes replay the spool (the heartbeat folds back in) and the
        // transcript, but no second heartbeat is ever emitted.
        capture_from_spool(&agent_path, &usage_path);
        let pending = spool::read_pending(&agent_path).expect("the spool reads");
        assert_eq!(
            pending
                .events
                .iter()
                .filter(|event| event.event == AgentEventKind::Heartbeat && event.model.is_some())
                .count(),
            1,
            "never twice for a session"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_hook_named_model_suppresses_the_heartbeat() {
        let dir = temp_dir("heartbeat-suppressed");
        let agent_path = dir.join("agent-spool.jsonl");
        let usage_path = dir.join("agent-usage.json");
        let transcript = dir.join("session-1.jsonl");
        write_transcript(
            &transcript,
            &[assistant_line(
                "2026-08-06T10:15:00Z",
                "claude-opus-4.1",
                false,
                100,
                20,
                0,
                0,
            )],
        );
        spool::append(
            &agent_path,
            &started_event(&transcript, "2026-08-06T10:00:00Z", Some("pi-model")),
        )
        .expect("append succeeds");

        capture_from_spool(&agent_path, &usage_path);

        let pending = spool::read_pending(&agent_path).expect("the spool reads");
        assert!(
            pending
                .events
                .iter()
                .all(|event| event.event != AgentEventKind::Heartbeat || event.model.is_none()),
            "the hook already named a model, so no model heartbeat fires"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// One pass over `sessions` new sessions whose transcripts each name a
    /// model the hook did not: the registry writes that pass made, after
    /// checking every session got its one heartbeat and its sent flag.
    fn registry_writes_for_a_pass_with_heartbeats(sessions: usize) -> usize {
        let dir = temp_dir(&format!("heartbeat-writes-{sessions}"));
        let agent_path = dir.join("agent-spool.jsonl");
        let usage_path = dir.join("agent-usage.json");
        for index in 0..sessions {
            let transcript = dir.join(format!("session-{index}.jsonl"));
            write_transcript(
                &transcript,
                &[assistant_line(
                    "2026-08-06T10:15:00Z",
                    "claude-opus-4.1",
                    false,
                    100,
                    20,
                    0,
                    0,
                )],
            );
            spool::append(
                &agent_path,
                &SpoolEvent {
                    external_session_id: format!("session-{index}"),
                    ..started_event(&transcript, "2026-08-06T10:00:00Z", None)
                },
            )
            .expect("append succeeds");
        }
        REGISTRY_WRITES.with(|writes| writes.set(0));

        capture_from_spool(&agent_path, &usage_path);

        let writes = REGISTRY_WRITES.with(std::cell::Cell::get);
        let pending = spool::read_pending(&agent_path).expect("the spool reads");
        assert_eq!(
            pending
                .events
                .iter()
                .filter(|event| event.event == AgentEventKind::Heartbeat && event.model.is_some())
                .count(),
            sessions,
            "every session gets its one model heartbeat"
        );
        let registry = read_registry(&usage_path);
        assert_eq!(registry.sessions.len(), sessions);
        assert!(
            registry
                .sessions
                .values()
                .all(|session| session.heartbeat_sent),
            "every emission is recorded"
        );
        let _ = std::fs::remove_dir_all(&dir);
        writes
    }

    /// The registry holds every session since capture began (tens of
    /// megabytes on a busy machine), so each rewrite costs seconds. A pass
    /// that rewrote it once per heartbeat ran for an hour on a backlog and
    /// never reached the uploads behind it (issue 85).
    #[test]
    fn a_pass_rewrites_the_registry_the_same_number_of_times_however_many_heartbeats_fire() {
        // Arrange, Act
        let writes_for_one = registry_writes_for_a_pass_with_heartbeats(1);
        let writes_for_five = registry_writes_for_a_pass_with_heartbeats(5);

        // Assert
        assert_eq!(writes_for_five, writes_for_one);
    }

    /// The liveness heartbeats on the spool, as the instants they carry.
    fn liveness_heartbeats(agent_path: &Path) -> Vec<String> {
        spool::read_pending(agent_path)
            .expect("the spool reads")
            .events
            .into_iter()
            .filter(|event| event.event == AgentEventKind::Heartbeat && event.model.is_none())
            .inspect(|event| {
                assert_eq!(event.external_session_id, "session-1");
                assert_eq!(event.cwd.as_deref(), Some("C:/dev/siqshift"));
            })
            .map(|event| event.occurred_at)
            .collect()
    }

    /// Every line the reader itself spooled - liveness heartbeats and
    /// continuation shifts - as (kind, shift id, instant), in spool order. The
    /// hook's own lines and the one model heartbeat are left out.
    fn shift_lines(agent_path: &Path) -> Vec<(AgentEventKind, String, String)> {
        spool::read_pending(agent_path)
            .expect("the spool reads")
            .events
            .into_iter()
            .filter(|event| {
                event.transcript_path.is_none()
                    && !(event.event == AgentEventKind::Heartbeat && event.model.is_some())
            })
            .map(|event| (event.event, event.external_session_id, event.occurred_at))
            .collect()
    }

    /// The id a continuation shift that started at `at` is recorded under.
    fn continuation(at: &str) -> String {
        format!(
            "session-1~{}",
            parse_iso8601(at).expect("the instant parses")
        )
    }

    /// A hook line for `session-1`, carrying the repository the hook probed.
    fn hook_event(kind: AgentEventKind, transcript: &Path, occurred_at: &str) -> SpoolEvent {
        SpoolEvent {
            event: kind,
            repo_root: Some("C:/dev/siqshift".to_string()),
            repo_remote: Some("https://github.com/acme/siqshift.git".to_string()),
            ..started_event(transcript, occurred_at, Some("claude-opus-5"))
        }
    }

    #[test]
    fn activity_after_a_silence_the_server_ended_the_shift_at_opens_a_continuation_shift() {
        // A goblin works, waits most of an hour on CI, then works again. The
        // server ended its shift thirty minutes after the last heartbeat and
        // never reopens one, so the second stretch is a shift of its own.
        let dir = temp_dir("continuation-gap");
        let agent_path = dir.join("agent-spool.jsonl");
        let usage_path = dir.join("agent-usage.json");
        let transcript = dir.join("session-1.jsonl");
        let line = |timestamp: &str| assistant_line(timestamp, "claude-opus-5", false, 10, 1, 0, 0);
        write_transcript(
            &transcript,
            &[
                line("2026-10-07T10:00:30Z"),
                line("2026-10-07T10:06:00Z"),
                line("2026-10-07T11:00:00Z"),
                line("2026-10-07T11:06:00Z"),
            ],
        );
        spool::append(
            &agent_path,
            &hook_event(AgentEventKind::Started, &transcript, "2026-10-07T10:00:00Z"),
        )
        .expect("append succeeds");

        capture_from_spool(&agent_path, &usage_path);

        let resumed = continuation("2026-10-07T11:00:00Z");
        assert_eq!(
            shift_lines(&agent_path),
            vec![
                (
                    AgentEventKind::Heartbeat,
                    "session-1".to_string(),
                    "2026-10-07T10:00:30Z".to_string()
                ),
                (
                    AgentEventKind::Heartbeat,
                    "session-1".to_string(),
                    "2026-10-07T10:06:00Z".to_string()
                ),
                (
                    AgentEventKind::Started,
                    resumed.clone(),
                    "2026-10-07T11:00:00Z".to_string()
                ),
                (
                    AgentEventKind::Heartbeat,
                    resumed.clone(),
                    "2026-10-07T11:06:00Z".to_string()
                ),
            ]
        );
        // The continuation keys the same identity and project as the session:
        // it carries the repository, the directory and the model the hook named.
        let started = spool::read_pending(&agent_path)
            .expect("the spool reads")
            .events
            .into_iter()
            .find(|event| event.external_session_id == resumed)
            .expect("the continuation started");
        assert_eq!(started.cwd.as_deref(), Some("C:/dev/siqshift"));
        assert_eq!(started.repo_root.as_deref(), Some("C:/dev/siqshift"));
        assert_eq!(
            started.repo_remote.as_deref(),
            Some("https://github.com/acme/siqshift.git")
        );
        assert_eq!(started.model.as_deref(), Some("claude-opus-5"));

        // Replaying the same pending spool writes nothing new.
        capture_from_spool(&agent_path, &usage_path);
        assert_eq!(shift_lines(&agent_path).len(), 4);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_session_resumed_after_its_end_works_on_a_new_shift_that_its_next_end_closes() {
        // `claude --continue` reuses the session id, and the server keeps an
        // ended shift ended, so everything after the first end needs a new one.
        let dir = temp_dir("continuation-resume");
        let agent_path = dir.join("agent-spool.jsonl");
        let usage_path = dir.join("agent-usage.json");
        let transcript = dir.join("session-1.jsonl");
        let line = |timestamp: &str| assistant_line(timestamp, "claude-opus-5", false, 10, 1, 0, 0);
        write_transcript(&transcript, &[line("2026-10-07T10:01:00Z")]);
        spool::append(
            &agent_path,
            &hook_event(AgentEventKind::Started, &transcript, "2026-10-07T10:00:00Z"),
        )
        .expect("append succeeds");
        spool::append(
            &agent_path,
            &hook_event(AgentEventKind::Ended, &transcript, "2026-10-07T10:10:00Z"),
        )
        .expect("append succeeds");
        capture_from_spool(&agent_path, &usage_path);

        // Resumed ten minutes later: inside the staleness window, but after an end.
        append_to_transcript(
            &transcript,
            &format!(
                "{}\n{}\n",
                line("2026-10-07T10:20:00Z"),
                line("2026-10-07T10:26:00Z")
            ),
        );
        capture_from_spool(&agent_path, &usage_path);
        spool::append(
            &agent_path,
            &hook_event(AgentEventKind::Ended, &transcript, "2026-10-07T10:40:00Z"),
        )
        .expect("append succeeds");
        capture_from_spool(&agent_path, &usage_path);
        capture_from_spool(&agent_path, &usage_path);

        let resumed = continuation("2026-10-07T10:20:00Z");
        assert_eq!(
            shift_lines(&agent_path),
            vec![
                (
                    AgentEventKind::Heartbeat,
                    "session-1".to_string(),
                    "2026-10-07T10:01:00Z".to_string()
                ),
                (
                    AgentEventKind::Started,
                    resumed.clone(),
                    "2026-10-07T10:20:00Z".to_string()
                ),
                (
                    AgentEventKind::Heartbeat,
                    resumed.clone(),
                    "2026-10-07T10:26:00Z".to_string()
                ),
                (
                    AgentEventKind::Ended,
                    resumed.clone(),
                    "2026-10-07T10:40:00Z".to_string()
                ),
            ]
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_session_an_older_build_was_tracking_picks_up_on_a_new_shift() {
        // An older build sent no liveness at all, so every shift it opened was
        // closed at its own start; its sessions' next activity starts afresh.
        let dir = temp_dir("continuation-upgrade");
        let agent_path = dir.join("agent-spool.jsonl");
        let usage_path = dir.join("agent-usage.json");
        let transcript = dir.join("session-1.jsonl");
        let line = |timestamp: &str| assistant_line(timestamp, "claude-opus-5", false, 10, 1, 0, 0);
        write_transcript(&transcript, &[line("2026-10-07T08:00:00Z")]);
        let older_build = serde_json::json!({
            "sessions": {
                "claude_code|session-1": {
                    "source": "claude_code",
                    "externalSessionId": "session-1",
                    "transcriptPath": transcript.to_string_lossy(),
                    "cwd": "C:/dev/siqshift",
                    "files": {},
                }
            }
        });
        std::fs::write(&usage_path, older_build.to_string()).expect("registry writes");
        capture_from_spool(&agent_path, &usage_path);
        let caught_up = shift_lines(&agent_path).len();

        append_to_transcript(&transcript, &format!("{}\n", line("2026-10-07T09:00:00Z")));
        capture_from_spool(&agent_path, &usage_path);

        let lines = shift_lines(&agent_path);
        assert_eq!(
            lines[caught_up..],
            [(
                AgentEventKind::Started,
                continuation("2026-10-07T09:00:00Z"),
                "2026-10-07T09:00:00Z".to_string()
            )]
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_working_transcript_carries_its_session_liveness_onto_the_spool() {
        // The shape of every goblin session on the operator's machine: the hook
        // spools a start and, hours later, an end, and nothing between them.
        // The transcript between the two is the only record that it worked.
        let dir = temp_dir("liveness");
        let agent_path = dir.join("agent-spool.jsonl");
        let usage_path = dir.join("agent-usage.json");
        let transcript = dir.join("session-1.jsonl");
        let line = |timestamp: &str| assistant_line(timestamp, "claude-opus-5", false, 10, 1, 0, 0);
        write_transcript(
            &transcript,
            &[
                line("2026-09-16T02:43:10.120Z"),
                line("2026-09-16T02:45:00Z"),
                line("2026-09-16T02:48:30Z"),
                line("2026-09-16T03:40:00Z"),
            ],
        );
        spool::append(
            &agent_path,
            &started_event(&transcript, "2026-09-16T02:43:09Z", Some("claude-opus-5")),
        )
        .expect("append succeeds");

        capture_from_spool(&agent_path, &usage_path);

        // One per five minutes of entries, at the entries' own times. The
        // hour-long quiet stretch is a gap the server ends the shift at, so
        // the work after it starts a continuation shift of its own.
        let resumed = continuation("2026-09-16T03:40:00Z");
        assert_eq!(
            liveness_heartbeats(&agent_path),
            vec!["2026-09-16T02:43:10Z", "2026-09-16T02:48:30Z"]
        );
        assert_eq!(
            shift_lines(&agent_path)[2..],
            [(
                AgentEventKind::Started,
                resumed.clone(),
                "2026-09-16T03:40:00Z".to_string()
            )]
        );

        // The next pass reads only what was appended, and spaces it from the
        // last heartbeat already sent rather than starting over.
        append_to_transcript(
            &transcript,
            &format!(
                "{}\n{}\n",
                line("2026-09-16T03:42:00Z"),
                line("2026-09-16T03:45:00Z")
            ),
        );
        capture_from_spool(&agent_path, &usage_path);
        assert_eq!(
            shift_lines(&agent_path)[3..],
            [(
                AgentEventKind::Heartbeat,
                resumed,
                "2026-09-16T03:45:00Z".to_string()
            )]
        );

        // A pass with nothing new writes nothing.
        capture_from_spool(&agent_path, &usage_path);
        assert_eq!(shift_lines(&agent_path).len(), 4);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_sub_agent_log_keeps_its_parent_session_live() {
        let dir = temp_dir("liveness-subagent");
        let agent_path = dir.join("agent-spool.jsonl");
        let usage_path = dir.join("agent-usage.json");
        let transcript = dir.join("session-1.jsonl");
        write_transcript(
            &transcript,
            &[assistant_line(
                "2026-09-16T10:00:00Z",
                "claude-opus-5",
                false,
                1,
                1,
                0,
                0,
            )],
        );
        write_transcript(
            &dir.join("session-1")
                .join("subagents")
                .join("agent-a1.jsonl"),
            &[assistant_line(
                "2026-09-16T10:20:00Z",
                "claude-opus-5",
                true,
                1,
                1,
                0,
                0,
            )],
        );
        spool::append(
            &agent_path,
            &started_event(&transcript, "2026-09-16T09:59:00Z", Some("claude-opus-5")),
        )
        .expect("append succeeds");

        capture_from_spool(&agent_path, &usage_path);

        assert_eq!(
            liveness_heartbeats(&agent_path),
            vec!["2026-09-16T10:00:00Z", "2026-09-16T10:20:00Z"]
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn unix(timestamp: &str) -> u64 {
        parse_iso8601(timestamp).expect("the instant parses")
    }

    /// A hook line for the session `id`, whose transcript is `<id>.jsonl`
    /// beside the registry.
    fn hook_event_for(id: &str, kind: AgentEventKind, dir: &Path, occurred_at: &str) -> SpoolEvent {
        SpoolEvent {
            external_session_id: id.to_string(),
            ..hook_event(kind, &dir.join(format!("{id}.jsonl")), occurred_at)
        }
    }

    fn mark_synced(usage_path: &Path, entries: &[UsageEntry]) {
        let mut verdicts = UploadVerdicts::default();
        verdicts.absorb(entries, &[]);
        record_verdicts(usage_path, &verdicts).expect("the verdicts record");
    }

    fn mark_every_entry_synced(usage_path: &Path) {
        mark_synced(usage_path, &read_registry(usage_path).entries);
    }

    /// What a pass reads once `finished` ended, synced, long-quiet sessions sit
    /// beside one active session: the sessions and entries the registry holds
    /// after the pass that retires them, and the transcript tails the next pass
    /// makes.
    fn registry_work_beside_finished_sessions(
        finished: usize,
    ) -> (Vec<String>, Vec<String>, usize) {
        let dir = temp_dir(&format!("retire-work-{finished}"));
        let first_spool = dir.join("agent-spool.jsonl");
        let quiet_spool = dir.join("agent-spool-quiet.jsonl");
        let usage_path = dir.join("agent-usage.json");
        let finished_ids: Vec<String> =
            (0..finished).map(|index| format!("done-{index}")).collect();
        for id in finished_ids.iter().map(String::as_str).chain(["session-1"]) {
            write_transcript(
                &dir.join(format!("{id}.jsonl")),
                &[assistant_line(
                    "2026-08-06T10:15:00Z",
                    "claude-opus-5",
                    false,
                    100,
                    20,
                    0,
                    0,
                )],
            );
            spool::append(
                &first_spool,
                &hook_event_for(id, AgentEventKind::Started, &dir, "2026-08-06T10:00:00Z"),
            )
            .expect("append succeeds");
        }
        for id in &finished_ids {
            spool::append(
                &first_spool,
                &hook_event_for(id, AgentEventKind::Ended, &dir, "2026-08-06T10:30:00Z"),
            )
            .expect("append succeeds");
        }
        capture(&first_spool, &usage_path, unix("2026-08-06T10:30:00Z"));
        mark_every_entry_synced(&usage_path);

        // The uploader has drained the finished sessions' lines; only the
        // active session's start is still pending.
        spool::append(
            &quiet_spool,
            &hook_event_for(
                "session-1",
                AgentEventKind::Started,
                &dir,
                "2026-08-06T10:00:00Z",
            ),
        )
        .expect("append succeeds");
        let later = unix("2026-08-08T00:00:00Z");
        capture(&quiet_spool, &usage_path, later);
        FILE_TAILS.with(|tails| tails.set(0));

        capture(&quiet_spool, &usage_path, later);

        let tails = FILE_TAILS.with(std::cell::Cell::get);
        let registry = read_registry(&usage_path);
        let mut sessions: Vec<String> = registry.sessions.keys().cloned().collect();
        sessions.sort();
        let entries = registry
            .entries
            .iter()
            .map(|entry| entry.external_session_id.clone())
            .collect();
        let _ = std::fs::remove_dir_all(&dir);
        (sessions, entries, tails)
    }

    /// Every pass reads and rewrites the registry and stats every transcript in
    /// it, and finished sessions stayed in it forever: 13,000 sessions and
    /// 21 MB on a busy machine (issue 86).
    #[test]
    fn a_pass_reads_only_the_sessions_still_active_however_many_have_finished() {
        // Arrange, Act
        let beside_one = registry_work_beside_finished_sessions(1);
        let beside_five = registry_work_beside_finished_sessions(5);

        // Assert
        assert_eq!(beside_five, beside_one);
        let (sessions, entries, tails) = beside_five;
        assert_eq!(sessions, vec!["claude_code|session-1".to_string()]);
        assert_eq!(entries, vec!["session-1".to_string()]);
        assert_eq!(tails, 1, "only the active session's transcript is tailed");
    }

    #[test]
    fn a_retired_session_a_later_hook_line_names_resumes_from_its_cursor_without_recounting() {
        // Arrange
        let dir = temp_dir("retire-resume");
        let first_spool = dir.join("agent-spool.jsonl");
        let quiet_spool = dir.join("agent-spool-quiet.jsonl");
        let resumed_spool = dir.join("agent-spool-resumed.jsonl");
        let usage_path = dir.join("agent-usage.json");
        let transcript = dir.join("session-1.jsonl");
        write_transcript(
            &transcript,
            &[assistant_line(
                "2026-08-06T10:15:00Z",
                "claude-opus-5",
                false,
                100,
                20,
                0,
                0,
            )],
        );
        for (kind, at) in [
            (AgentEventKind::Started, "2026-08-06T10:00:00Z"),
            (AgentEventKind::Ended, "2026-08-06T10:30:00Z"),
        ] {
            spool::append(&first_spool, &hook_event(kind, &transcript, at))
                .expect("append succeeds");
        }
        capture(&first_spool, &usage_path, unix("2026-08-06T10:30:00Z"));
        let original = one_entry(&read_registry(&usage_path)).clone();
        mark_synced(&usage_path, std::slice::from_ref(&original));
        capture(&quiet_spool, &usage_path, unix("2026-08-08T00:00:00Z"));
        let archive = retired_session_path(&retired_dir(&usage_path), "claude_code|session-1");
        let retired = read_registry(&usage_path);
        assert!(retired.sessions.is_empty() && retired.entries.is_empty());
        assert!(archive.exists(), "the retired session is archived");

        // The session is resumed: its transcript grows and the hook spools a start.
        append_to_transcript(
            &transcript,
            &(assistant_line("2026-08-06T10:50:00Z", "claude-opus-5", false, 60, 5, 1, 2) + "\n"),
        );
        spool::append(
            &resumed_spool,
            &hook_event(AgentEventKind::Started, &transcript, "2026-08-08T00:05:00Z"),
        )
        .expect("append succeeds");

        // Act
        capture(&resumed_spool, &usage_path, unix("2026-08-08T00:10:00Z"));

        // Assert
        let registry = read_registry(&usage_path);
        let resumed = one_entry(&registry);
        assert_eq!(resumed.client_id, original.client_id);
        assert_eq!(resumed.input_tokens, 160, "only the new line adds");
        assert_eq!(resumed.output_tokens, 25);
        assert_eq!(resumed.cache_creation_input_tokens, 1);
        assert_eq!(resumed.cache_read_input_tokens, 2);
        assert!(!resumed.synced, "the higher total is uploaded again");
        assert_eq!(
            one_file_offset(&registry),
            std::fs::metadata(&transcript).expect("metadata").len()
        );
        assert!(!archive.exists(), "the restored session leaves the archive");

        let _ = std::fs::remove_dir_all(&dir);
    }

    struct RetirementCase {
        name: &'static str,
        is_ended: bool,
        is_synced: bool,
        has_pending_line: bool,
        quiet_seconds: u64,
        is_retired: bool,
    }

    #[test]
    fn a_session_retires_only_once_it_is_synced_unnamed_and_quiet_long_enough() {
        const HOUR: u64 = 60 * 60;
        const WEEK: u64 = 7 * 24 * HOUR;
        let cases = [
            RetirementCase {
                name: "an entry the server has not accepted",
                is_ended: true,
                is_synced: false,
                has_pending_line: false,
                quiet_seconds: WEEK,
                is_retired: false,
            },
            RetirementCase {
                name: "a pending spool line names the session",
                is_ended: true,
                is_synced: true,
                has_pending_line: true,
                quiet_seconds: WEEK,
                is_retired: false,
            },
            RetirementCase {
                name: "an ended session just under an hour quiet",
                is_ended: true,
                is_synced: true,
                has_pending_line: false,
                quiet_seconds: HOUR - 1,
                is_retired: false,
            },
            RetirementCase {
                name: "an ended session an hour quiet",
                is_ended: true,
                is_synced: true,
                has_pending_line: false,
                quiet_seconds: HOUR,
                is_retired: true,
            },
            RetirementCase {
                name: "an open session more than an hour quiet",
                is_ended: false,
                is_synced: true,
                has_pending_line: false,
                quiet_seconds: 2 * 24 * HOUR,
                is_retired: false,
            },
            RetirementCase {
                name: "an open session just under a week quiet",
                is_ended: false,
                is_synced: true,
                has_pending_line: false,
                quiet_seconds: WEEK - 1,
                is_retired: false,
            },
            RetirementCase {
                name: "an open session a week quiet",
                is_ended: false,
                is_synced: true,
                has_pending_line: false,
                quiet_seconds: WEEK,
                is_retired: true,
            },
        ];

        for case in cases {
            // Arrange
            let dir = temp_dir("retire-cases");
            let first_spool = dir.join("agent-spool.jsonl");
            let next_spool = dir.join("agent-spool-next.jsonl");
            let usage_path = dir.join("agent-usage.json");
            let transcript = dir.join("session-1.jsonl");
            write_transcript(
                &transcript,
                &[assistant_line(
                    "2026-08-06T10:15:00Z",
                    "claude-opus-5",
                    false,
                    100,
                    20,
                    0,
                    0,
                )],
            );
            spool::append(
                &first_spool,
                &hook_event(AgentEventKind::Started, &transcript, "2026-08-06T10:00:00Z"),
            )
            .expect("append succeeds");
            if case.is_ended {
                spool::append(
                    &first_spool,
                    &hook_event(AgentEventKind::Ended, &transcript, "2026-08-06T10:30:00Z"),
                )
                .expect("append succeeds");
            }
            capture(&first_spool, &usage_path, unix("2026-08-06T10:30:00Z"));
            if case.is_synced {
                mark_every_entry_synced(&usage_path);
            }
            if case.has_pending_line {
                spool::append(
                    &next_spool,
                    &hook_event(
                        AgentEventKind::Heartbeat,
                        &transcript,
                        "2026-08-06T10:20:00Z",
                    ),
                )
                .expect("append succeeds");
            }
            let last_seen = unix(if case.is_ended {
                "2026-08-06T10:30:00Z"
            } else {
                "2026-08-06T10:15:00Z"
            });

            // Act
            capture(&next_spool, &usage_path, last_seen + case.quiet_seconds);

            // Assert
            assert_eq!(
                read_registry(&usage_path).sessions.is_empty(),
                case.is_retired,
                "{}",
                case.name
            );
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// Every key in the persisted registry, walked recursively.
    fn collect_keys(value: &serde_json::Value, keys: &mut Vec<String>) {
        match value {
            serde_json::Value::Object(map) => {
                for (key, nested) in map {
                    keys.push(key.clone());
                    collect_keys(nested, keys);
                }
            }
            serde_json::Value::Array(items) => {
                for item in items {
                    collect_keys(item, keys);
                }
            }
            _ => {}
        }
    }

    #[test]
    fn the_persisted_registry_has_no_field_capable_of_holding_message_text() {
        let mut registry = UsageRegistry::default();
        let key = session_key(&source(), "session-1");
        registry.sessions.insert(
            key,
            SessionUsage {
                source: source(),
                external_session_id: "session-1".to_string(),
                transcript_path: Some(
                    "C:/Users/alex/.claude/projects/x/session-1.jsonl".to_string(),
                ),
                cwd: Some("C:/dev/siqshift".to_string()),
                model_from_hook: true,
                heartbeat_sent: true,
                activity_heartbeat_at: 1_786_000_000,
                last_seen_at: 1_786_000_700,
                repo_root: Some("C:/dev/siqshift".to_string()),
                repo_remote: Some("https://github.com/acme/siqshift.git".to_string()),
                model: Some("claude-opus-4.1".to_string()),
                shift_id: Some("session-1~1786000000".to_string()),
                shift_started_at: 1_786_000_000,
                shift_last_event_at: 1_786_000_300,
                shift_ended_at: Some(1_786_000_600),
                hook_buckets: vec![BucketTotals {
                    bucket_start_at: "2026-08-06T10:00:00Z".to_string(),
                    model: Some("claude-opus-4.1".to_string()),
                    sidechain: false,
                    tokens: TokenTotals {
                        input: 150,
                        output: 12,
                        cache_creation: 3,
                        cache_read: 4,
                    },
                }],
                files: HashMap::from([(
                    "C:/Users/alex/.claude/projects/x/session-1.jsonl".to_string(),
                    FileUsage {
                        offset: 4_096,
                        identity_ms: Some(1_786_000_000_000),
                        resync: false,
                        buckets: vec![BucketTotals {
                            bucket_start_at: "2026-08-06T10:00:00Z".to_string(),
                            model: Some("claude-opus-4.1".to_string()),
                            sidechain: true,
                            tokens: TokenTotals {
                                input: 40,
                                output: 8,
                                cache_creation: 2,
                                cache_read: 0,
                            },
                        }],
                    },
                )]),
            },
        );
        registry.entries.push(UsageEntry {
            client_id: "client-1".to_string(),
            source: source(),
            external_session_id: "session-1".to_string(),
            bucket_start_at: "2026-08-06T10:00:00Z".to_string(),
            model: Some("claude-opus-4.1".to_string()),
            sidechain: false,
            input_tokens: 150,
            output_tokens: 12,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 4,
            synced: false,
            rejected: false,
            unknown_session_attempts: 0,
        });

        let serialized = serde_json::to_value(&registry).expect("the registry serializes");
        let mut keys = Vec::new();
        collect_keys(&serialized, &mut keys);
        assert!(!keys.is_empty());
        for forbidden in [
            "prompt",
            "message",
            "content",
            "text",
            "body",
            "line",
            "tool",
            "toolCalls",
            "branch",
            "subject",
        ] {
            assert!(
                !keys.iter().any(|key| key == forbidden),
                "the registry must not carry a `{forbidden}` key; keys: {keys:?}"
            );
        }

        // And the round-trip survives: capture state is durable.
        let reparsed: UsageRegistry =
            serde_json::from_value(serialized).expect("the registry round-trips");
        assert_eq!(reparsed.entries.len(), 1);
        assert_eq!(reparsed.sessions.len(), 1);
    }
}
