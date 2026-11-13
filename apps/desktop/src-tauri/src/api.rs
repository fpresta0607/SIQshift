//! HTTP access to Neon Auth and the SIQshift API.
//!
//! Two rules hold everywhere in this module: errors never carry a response body
//! or a URL (either can contain a token), and the caller always learns which
//! kind of failure it was so the UI can react without parsing strings.

use reqwest::Url;
use serde::{Deserialize, Serialize};

use crate::monitor::{ObservedSession, SegmentRecord};
use crate::spool::{AgentEventKind, AgentSource, SpoolEvent};

/// Matches the `BridgeErrorKind` union the React bridge narrows on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ErrorKind {
    Auth,
    Transient,
    Conflict,
    Validation,
    Unknown,
    /// A sign-up for an email the sign-in service already holds, whose
    /// password did not sign in: the form moves to sign-in with the email.
    #[serde(rename = "account_exists")]
    AccountExists,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BridgeError {
    pub kind: ErrorKind,
    pub message: String,
}

impl BridgeError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn auth(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Auth, message)
    }

    pub fn transient(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Transient, message)
    }

    pub fn unknown(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Unknown, message)
    }
}

pub type ApiResult<T> = Result<T, BridgeError>;

/// Maps a status code onto the kind the UI branches on, and onto a message that
/// describes the situation without echoing anything the server sent back.
pub fn classify(status: u16) -> BridgeError {
    match status {
        401 | 403 => BridgeError::auth("Your session expired. Sign in again."),
        409 => BridgeError::new(
            ErrorKind::Conflict,
            "A timer is already running for this account.",
        ),
        // Only reached when the server gave no reason of its own.
        400 | 422 => BridgeError::new(
            ErrorKind::Validation,
            "The server rejected the request as invalid without saying why. Please report it at github.com/fpresta0607/SIQshift/issues.",
        ),
        408 | 429 => BridgeError::transient("The server is busy. Retrying shortly."),
        500..=599 => BridgeError::transient("The server is unavailable. Retrying shortly."),
        _ => BridgeError::unknown("The request did not complete."),
    }
}

async fn classify_api_error(response: reqwest::Response) -> BridgeError {
    let status = response.status().as_u16();
    let server_message = response
        .json::<ApiErrorBody>()
        .await
        .ok()
        .map(|body| body.error.message)
        .filter(|message| !message.is_empty());
    match server_message {
        Some(message) => BridgeError::new(classify(status).kind, message),
        None => classify(status),
    }
}

/// Neon Auth's own refusals, which are not this app's contract with its API.
///
/// `classify` answers for the API, where a 400 means the request shape was
/// wrong and no reader composed it. The auth host is the opposite case: its
/// 400 is the address typed into the box, so falling through to `classify`
/// answered a mistyped email with "The server rejected the request as
/// invalid." - a sentence about the server for a fault in the form.
///
/// The code is matched from a known set rather than echoing the server's text.
pub fn classify_auth(status: u16, code: Option<&str>) -> BridgeError {
    match code {
        // Older and newer releases of the sign-in service name this case
        // differently. The sentence does not say an account exists: the
        // service's own answer already tells anyone who asks it directly,
        // and the app does not repeat it in words (issue 84).
        Some("USER_ALREADY_EXISTS" | "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL") => BridgeError::new(
            ErrorKind::AccountExists,
            "This email can't start a new account, so sign in with it or check it for a typo.",
        ),
        Some("PASSWORD_TOO_SHORT") => BridgeError::new(
            ErrorKind::Validation,
            "Choose a password of at least 8 characters.",
        ),
        Some("INVALID_EMAIL") => {
            BridgeError::new(ErrorKind::Validation, "Enter a valid email address.")
        }
        _ => match status {
            401 | 403 => BridgeError::auth("Incorrect email or password."),
            400 | 422 => BridgeError::new(
                ErrorKind::Validation,
                "The sign-in service would not accept those details. Check them and try again.",
            ),
            408 | 429 => BridgeError::transient("Too many attempts. Wait a minute and try again."),
            500..=599 => {
                BridgeError::transient("The sign-in service is unavailable. Try again shortly.")
            }
            _ => BridgeError::unknown("The request did not complete."),
        },
    }
}

/// A network-level failure is always transient: nothing reached the server, so
/// retrying the identical idempotent payload is safe.
pub fn classify_transport(error: &reqwest::Error) -> BridgeError {
    if error.is_timeout() {
        BridgeError::transient("The server did not respond in time.")
    } else {
        BridgeError::transient("Cannot reach the server. Check your connection.")
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerUser {
    pub id: String,
    pub email: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerProject {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    /// One of the built-in icon names; absent from a server that predates them.
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(skip_serializing)]
    pub created_at: String,
}

#[derive(Deserialize)]
struct MeResponse {
    user: MeUser,
}

#[derive(Deserialize)]
struct MeUser {
    id: String,
    email: String,
    name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Organization {
    pub id: String,
    pub name: String,
    pub invite_code: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaderboardMember {
    pub id: String,
    pub name: String,
}

#[derive(Deserialize)]
struct OrganizationResponse {
    organization: Organization,
}

/// The team view: the caller's one workspace laid out as the home page's
/// example workspace. Every total is added up on the server; the webview
/// draws them as given.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReport {
    pub active_seconds: u64,
    pub agent_seconds: u64,
    /// One bucket per local hour of a bounded range; empty over all time.
    pub hourly: Vec<MeStatsHourlyBucket>,
    pub projects: Vec<WorkspaceProjectTotal>,
    pub agents: Vec<WorkspaceAgentTotal>,
    pub members: Vec<WorkspaceMember>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProjectTotal {
    pub project: WorkspaceProject,
    pub duration_seconds: u64,
}

/// A project as the team view lists it, with the icon and color the server
/// resolved for it; both are absent from a server that predates them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProject {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
}

/// A runtime id as the server sent it, so one this build has never heard of
/// still reads rather than failing the whole view.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceAgentTotal {
    pub source: String,
    pub duration_seconds: u64,
}

/// One board row, ranked as the leaderboard ranks, with the project the member
/// spent most time on, `None` when none had any.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMember {
    pub rank: u32,
    pub user: LeaderboardMember,
    pub active_seconds: u64,
    pub agent_seconds: u64,
    pub project: Option<LeaderboardMember>,
}

/// The Agents tab's whole story: what ran, where, grouped by codebase. Every
/// field is tolerant the way every response here is - the API deploys before
/// any installer can, so absence decodes as empty rather than as an error.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentShifts {
    #[serde(default)]
    pub total_agent_seconds: u64,
    /// Agent runtime by the hour, for the line above the groups. Empty over an
    /// unbounded range, and empty from an API old enough to have folded the
    /// series client-side from the shifts it used to send.
    #[serde(default)]
    pub hourly: Vec<MeStatsHourlyBucket>,
    #[serde(default)]
    pub groups: Vec<AgentShiftsGroup>,
    /// The token bars for the tab, computed by the server. Absent from an API
    /// that predates them, which leaves the tab without bars.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_chart: Option<TokenChart>,
    /// The groups' shifts rolled up by agent runtime. Absent from an API that
    /// predates it, which leaves the tab without its list of agents.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtimes: Option<Vec<AgentShiftsRuntime>>,
    /// The tokens the groups' shifts reported, as the server summed them.
    /// Absent when the server reads no token usage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_totals: Option<AgentShiftsTokenTotals>,
}

/// One agent runtime's share of the groups' shifts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentShiftsRuntime {
    pub source: AgentSource,
    #[serde(default)]
    pub agent_seconds: u64,
    #[serde(default)]
    pub shift_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<u64>,
}

/// The tokens the range's shifts reported, in and out, as the server summed them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentShiftsTokenTotals {
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub tokens: u64,
}

/// The Agents tab's token bars: the period's buckets, and each project's bars
/// over the same buckets with its total. Every figure is the server's; the
/// webview draws them as given.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenChart {
    pub bucket_seconds: u64,
    pub buckets: Vec<TokenBucket>,
    pub projects: Vec<TokenChartProject>,
}

/// One bar. All three counts are `None` when nothing in the bucket reported
/// tokens, never a zero the server did not send.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenBucket {
    pub start: String,
    pub tokens_in: Option<u64>,
    pub tokens_out: Option<u64>,
    pub tokens: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenChartProject {
    pub project: LeaderboardMember,
    pub tokens: u64,
    pub buckets: Vec<TokenBucket>,
}

/// One codebase's group head: its summed runtime and how many shifts made it.
/// `repo` is a folder name, never a path; `None` is a group of shifts that
/// could name no codebase at all, and `null_cause` says why - so a capture gap
/// and a run worktree with no repository never render as one collapsed row.
/// `None`/absent on an older API, which keeps the old wording.
///
/// The shifts themselves are a separate paged read keyed by `group_key`, made
/// when a reader opens a drawer. An API old enough to have sent them inline
/// sends no `group_key`, which lands here as an empty string; the webview
/// rebuilds the server's own key from `repo` and `null_cause` so the drawers
/// keep distinct identities, and reports that it could not load the shifts
/// from a route that API does not serve.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentShiftsGroup {
    #[serde(default)]
    pub group_key: String,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub null_cause: Option<String>,
    #[serde(default)]
    pub agent_seconds: u64,
    #[serde(default)]
    pub shift_count: u32,
    /// merged / decided; `None` while nothing has been decided yet.
    #[serde(default)]
    pub held_rate: Option<f64>,
    /// Tokens in and out the group's shifts reported; absent when the server
    /// reads no token usage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<u64>,
}

/// One shift: a terminal session, with the facts it attested itself.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentShiftRow {
    pub id: String,
    pub source: AgentSource,
    pub owner: LeaderboardMember,
    #[serde(default)]
    pub model: Option<String>,
    pub started_at: String,
    /// A running shift reads its last event here, never "still open".
    pub ended_at: String,
    #[serde(default)]
    pub agent_seconds: u64,
    /// How many commits the shift recorded; the subjects stay off this wire.
    #[serde(default)]
    pub commit_count: u32,
    /// The project tie the drawer is ordered by: set when the shift's
    /// attribution resolved to a project, `None` when its time landed in the
    /// default one. Absent on an API that predates the tie, which reads as
    /// untied - the position those rows already sat in.
    #[serde(default)]
    pub project: Option<LeaderboardMember>,
}

/// One page of one group's shifts, newest first, and where the next page
/// starts. `next_cursor` is `None` once the group is exhausted, which is the
/// whole of what a drawer needs to decide whether to offer another page.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentShiftRows {
    #[serde(default)]
    pub shifts: Vec<AgentShiftRow>,
    #[serde(default)]
    pub next_cursor: Option<AgentShiftCursor>,
}

/// Names the last shift a page returned, by the pair the rows are ordered on:
/// `started_at` descending, `id` ascending to break an equal instant. A shift
/// arriving at the head of the group does not move it, which is why the drawer
/// pages on this rather than on a row offset.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentShiftCursor {
    pub started_at: String,
    pub id: String,
    /// The cursor's partition in the project-tie ordering. Absent on a cursor
    /// from before the tie existed, which reads as the untied partition.
    #[serde(default)]
    pub project_tied: Option<bool>,
}

/// One agent session running at the moment the read answered, as the live
/// view renders it. The description is the server's own sentence, composed
/// once from captured facts; the webview renders it verbatim and never
/// re-derives it. Every field is tolerant the way every response here is.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveAgentSessionRow {
    pub id: String,
    pub source: AgentSource,
    pub description: String,
    #[serde(default)]
    pub repo: Option<String>,
}

/// One person's running sessions. Only people with at least one arrive, so
/// nobody stale can appear here; an empty list is the honest empty state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveAgentPerson {
    pub owner: LeaderboardMember,
    #[serde(default)]
    pub sessions: Vec<LiveAgentSessionRow>,
}

/// Who is running an agent right now, grouped by person. An absent list
/// decodes as none, never an error - the API deploys before any installer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveAgentSessions {
    #[serde(default)]
    pub people: Vec<LiveAgentPerson>,
}

#[derive(Deserialize)]
struct ProjectListResponse {
    projects: Vec<ProjectListItem>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectListItem {
    id: String,
    name: String,
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    icon: Option<String>,
    created_at: String,
    is_archived: bool,
}

#[derive(Deserialize)]
struct AuthErrorBody {
    #[serde(default)]
    code: Option<String>,
}

#[derive(Deserialize)]
struct ApiErrorBody {
    error: ApiErrorBodyError,
}

#[derive(Deserialize)]
struct ApiErrorBodyError {
    message: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    token: String,
}

/// A sign-up that finished: the session cookie value to keep, and an access
/// token already minted from it.
pub struct SignedUp {
    pub session: String,
    pub access_token: String,
}

/// What `/sessions/observed` answers with. Only the refusals matter to the
/// caller, and a refusal is permanent.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedSessionBatchOutcome {
    pub rejected: Vec<SegmentRejection>,
}

/// The server's verdict on an uploaded activity-segment batch. Rejected rows
/// are dropped, not retried: the reason is a permanent validation failure.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentBatchOutcome {
    pub accepted: u32,
    pub rejected: Vec<SegmentRejection>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentRejection {
    pub client_id: String,
    pub reason: String,
}

/// One captured commit, as `POST /shift-commits` accepts it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftCommitUpload {
    pub client_id: String,
    pub source: AgentSource,
    pub external_session_id: String,
    pub repo_root: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub sha: String,
    pub subject: String,
    pub authored_at: String,
    pub verification: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_at: Option<String>,
}

/// The server's verdict on an uploaded shift-commit batch. `unknown_session`
/// is retryable (the shift may not have landed on the server yet); every
/// other rejection reason is permanent.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftCommitBatchOutcome {
    pub accepted: u32,
    pub rejected: Vec<SegmentRejection>,
}

/// Per-event verdict from `/agent-sessions`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventOutcome {
    pub external_session_id: String,
    pub accepted: bool,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Deserialize)]
struct AgentEventBatchResponse {
    results: Vec<AgentEventOutcome>,
}

/// What `POST /agent-sessions` accepts, borrowed field-by-field from a spool
/// event. The spool line carries capture-only fields (`transcript_path`,
/// cumulative `tokens`) that the server's strict schema would reject - and a
/// transcript path is not ours to send - so the upload projects explicitly
/// instead of serializing the spool event itself. `skip_serializing` on the
/// spool struct is not an option: the same serde impl writes the spool file,
/// where those fields must survive.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventUpload<'a> {
    pub source: &'a AgentSource,
    pub external_session_id: &'a str,
    pub event: AgentEventKind,
    pub occurred_at: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<&'a str>,
    /// Contract data, unlike `start_head`: the path the shift's identity falls
    /// back to when no remote was read, and evidence of where the work
    /// happened otherwise. An older API rejects an unknown field outright,
    /// which is why the installer ships only after the API accepting it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_root: Option<&'a str>,
    /// The identity key the server actually uses, and contract data on the
    /// same terms as `repo_root`: an older API rejects an unknown field
    /// outright, so the installer ships only after the API accepting it.
    /// Carries no credential: the probe strips any `userinfo@` component
    /// before the value is spooled, so nothing token-shaped is ever uploaded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_remote: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule_id: Option<&'a str>,
}

impl<'a> From<&'a SpoolEvent> for AgentEventUpload<'a> {
    fn from(event: &'a SpoolEvent) -> Self {
        Self {
            source: &event.source,
            external_session_id: &event.external_session_id,
            event: event.event,
            occurred_at: &event.occurred_at,
            cwd: event.cwd.as_deref(),
            repo_root: event.repo_root.as_deref(),
            repo_remote: event.repo_remote.as_deref(),
            model: event.model.as_deref(),
            rule_id: event.rule_id.as_deref(),
        }
    }
}

/// One session's token counters for one hour bucket, as `POST /agent-usage`
/// accepts it. Counters are cumulative totals per (bucket, model, sidechain),
/// restated upward; the server upserts monotonically, so a replayed batch is
/// always safe to resend.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsageUpload {
    pub client_id: String,
    pub source: AgentSource,
    pub external_session_id: String,
    pub bucket_start_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub sidechain: bool,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
}

/// The server's verdict on an uploaded agent-usage batch. `unknown_session`
/// is retryable (the shift may not have landed on the server yet); every
/// other rejection reason is permanent.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsageBatchOutcome {
    pub accepted: u32,
    pub rejected: Vec<SegmentRejection>,
}

/// A per-user path prefix → project mapping, as `/path-mappings` returns it.
/// Read-only from the desktop: the host uses these to file an agent's work by
/// the folder it ran in. There is no longer a screen for editing them by hand.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathMapping {
    pub id: String,
    /// How the mapping matches: a filesystem path prefix (agent cwds), or a
    /// browser URL rule (extension span verdicts). The two kinds share the
    /// list endpoint but answer different questions, so the desktop must tell
    /// them apart rather than running one matcher over both.
    #[serde(default)]
    pub kind: MappingKind,
    pub path_prefix: String,
    #[serde(default)]
    pub repo_url: Option<String>,
    pub project_id: String,
}

/// The two mapping kinds the server models. Kept beside `PathMapping` because
/// the desktop reads both kinds from the one endpoint and filters per use.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MappingKind {
    /// Matches an agent working directory by longest path-prefix.
    #[default]
    PathPrefix,
    /// Matches a browser tab by URL-rule pattern; never a filesystem path.
    UrlRule,
}

#[derive(Deserialize)]
struct PathMappingListResponse {
    mappings: Vec<PathMapping>,
}

/// Active time split by how many agents ran at once, plus agent runtime that
/// fell outside the member's presence entirely.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeStatsConcurrency {
    pub t0_seconds: u64,
    pub t1_seconds: u64,
    pub t2_seconds: u64,
    pub t3_plus_seconds: u64,
    pub away_seconds: u64,
}

/// One agent runtime's share of agent time; sums to agent time, never to active time.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeStatsAgentSplit {
    pub source: String,
    #[serde(default)]
    pub model: Option<String>,
    pub duration_seconds: u64,
}

/// The dashboard view state both surfaces share. Only `scope` is synchronised:
/// the two surfaces offer different ranges on purpose (this app's "this week"
/// is a calendar week, the dashboard's "7d" is a rolling one), so each keeps
/// its own while the project scope follows you between them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewPreferences {
    pub scope: String,
    pub range: String,
}

/// What deleting a project takes with it, as `/projects/:id/usage` reports it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUsage {
    pub session_count: u64,
    pub duration_seconds: u64,
    pub agent_session_count: u64,
}

/// One hour of the caller's local calendar for the line graph: active time
/// and agent runtime bucketed to the hour.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeStatsHourlyBucket {
    pub hour_start: String,
    pub active_seconds: u64,
    pub agent_seconds: u64,
}

/// The `GET /me/stats` response: the reporting service's attribution totals
/// scoped to the caller.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeStats {
    pub filters: MeStatsFilters,
    /// Union of the member's working intervals - never exceeds wall clock.
    /// These four ride through to the webview, whose decoder requires them:
    /// a field missing here is a hard `invalidResponse()` over there.
    pub active_seconds: u64,
    /// Summed agent runtime; exceeding `active_seconds` is leverage, not an error.
    pub agent_seconds: u64,
    pub concurrency: MeStatsConcurrency,
    pub by_agent: Vec<MeStatsAgentSplit>,
    pub total_duration_seconds: u64,
    pub attributed_seconds: u64,
    pub unattributed_seconds: u64,
    pub projects: Vec<MeStatsProject>,
    // Without this field serde silently drops the array and the TS bridge
    // rejects the whole response as invalid.
    pub apps: Vec<MeStatsApp>,
    /// Hourly series for the line graph. Defaulted so an API from before the
    /// field shipped still parses; the webview reads an empty series as "no
    /// graph", exactly as it already does.
    #[serde(default)]
    pub hourly: Vec<MeStatsHourlyBucket>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeStatsApp {
    pub process_name: String,
    pub duration_seconds: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeStatsFilters {
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeStatsProject {
    pub project: MeStatsProjectRef,
    pub duration_seconds: u64,
    pub attributed_seconds: u64,
    pub unattributed_seconds: u64,
    pub session_count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeStatsProjectRef {
    pub id: String,
    pub name: String,
}

/// Neon Auth signs its session cookie: the value it honors on `/token` is
/// `token.signature` from Set-Cookie, not the bare token the JSON body returns
/// (the bare token gets a 401). Browsers store the Set-Cookie value verbatim —
/// still URL-encoded — so we keep it byte-for-byte and send it back untouched.
fn session_cookie_value(headers: &reqwest::header::HeaderMap) -> ApiResult<String> {
    const NAMES: [&str; 2] = [
        "__Secure-neon-auth.session_token=",
        "neon-auth.session_token=",
    ];
    for header in headers.get_all(reqwest::header::SET_COOKIE) {
        let Ok(header) = header.to_str() else {
            continue;
        };
        for name in NAMES {
            if let Some(rest) = header.strip_prefix(name) {
                let value = rest.split(';').next().unwrap_or_default();
                if !value.is_empty() {
                    return Ok(value.to_string());
                }
            }
        }
    }
    Err(BridgeError::unknown(
        "The sign-in response carried no session cookie.",
    ))
}

/// Talks to both services. `auth_base_url` is the Neon Auth base URL; `api_base_url`
/// is the SIQshift API. Cheap to clone: the inner HTTP client is reference-counted.
#[derive(Clone)]
pub struct ApiClient {
    http: reqwest::Client,
    auth_base_url: String,
    /// Scheme and host only. Neon Auth rejects a state-changing call that has no
    /// Origin, and an origin is never a path.
    auth_origin: String,
    api_base_url: String,
}

impl ApiClient {
    pub fn new(auth_base_url: String, api_base_url: String) -> ApiResult<Self> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|_| BridgeError::unknown("Could not start the network client."))?;
        let auth_origin = reqwest::Url::parse(&auth_base_url)
            .map_err(|_| BridgeError::unknown("The configured auth URL is not valid."))?
            .origin()
            .ascii_serialization();
        Ok(Self {
            http,
            auth_base_url: auth_base_url.trim_end_matches('/').to_string(),
            auth_origin,
            api_base_url: api_base_url.trim_end_matches('/').to_string(),
        })
    }

    /// Creates a Neon Auth account and returns its signed session cookie value.
    pub async fn sign_up(&self, email: &str, password: &str, name: &str) -> ApiResult<String> {
        let response = self
            .http
            .post(format!("{}/sign-up/email", self.auth_base_url))
            .header("origin", &self.auth_origin)
            .json(&serde_json::json!({ "email": email, "password": password, "name": name }))
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let code = response
                .json::<AuthErrorBody>()
                .await
                .ok()
                .and_then(|body| body.code);
            return Err(classify_auth(status, code.as_deref()));
        }

        session_cookie_value(response.headers())
    }

    /// Creates the account and places it in its workspace. An email the
    /// sign-in service already holds signs in instead when the password is
    /// right, which also finishes an account whose sign-up stopped before
    /// provisioning. The session comes back only once the account is
    /// provisioned: a session kept after a failed step made the next call
    /// give the account a personal workspace its invite code never chose
    /// (issue 84).
    pub async fn sign_up_and_provision(
        &self,
        email: &str,
        password: &str,
        name: &str,
        invite_code: Option<&str>,
    ) -> ApiResult<SignedUp> {
        let session = match self.sign_up(email, password, name).await {
            Err(taken) if taken.kind == ErrorKind::AccountExists => {
                match self.sign_in(email, password).await {
                    Err(refused) if refused.kind == ErrorKind::Auth => return Err(taken),
                    signed_in => signed_in?,
                }
            }
            signed_up => signed_up?,
        };
        let access_token = self.fetch_access_token(&session).await?;
        self.provision_account(&access_token, invite_code).await?;
        Ok(SignedUp {
            session,
            access_token,
        })
    }

    /// Exchanges email and password for the long-lived Neon Auth session cookie.
    pub async fn sign_in(&self, email: &str, password: &str) -> ApiResult<String> {
        let response = self
            .http
            .post(format!("{}/sign-in/email", self.auth_base_url))
            .header("origin", &self.auth_origin)
            .json(&serde_json::json!({ "email": email, "password": password }))
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;

        if !response.status().is_success() {
            // Neon Auth answers a bad password with 401 and a malformed address
            // with 400 INVALID_EMAIL; say which without echoing its text back.
            let status = response.status().as_u16();
            let code = response
                .json::<AuthErrorBody>()
                .await
                .ok()
                .and_then(|body| body.code);
            return Err(classify_auth(status, code.as_deref()));
        }

        session_cookie_value(response.headers())
    }

    /// Trades the session token for a short-lived JWT the API will accept.
    pub async fn fetch_access_token(&self, session_token: &str) -> ApiResult<String> {
        let response = self
            .http
            .get(format!("{}/token", self.auth_base_url))
            .header("origin", &self.auth_origin)
            .header(
                "cookie",
                format!("__Secure-neon-auth.session_token={session_token}"),
            )
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;

        if !response.status().is_success() {
            return Err(classify(response.status().as_u16()));
        }

        let body: TokenResponse = response
            .json()
            .await
            .map_err(|_| BridgeError::unknown("The access token could not be read."))?;
        Ok(body.token)
    }

    /// Sent once after sign-up. An invite code places the account in an existing
    /// organization; without one the API creates a personal workspace.
    pub async fn provision_account(
        &self,
        access_token: &str,
        invite_code: Option<&str>,
    ) -> ApiResult<TimerUser> {
        let body = match invite_code {
            Some(code) => serde_json::json!({ "inviteCode": code }),
            None => serde_json::json!({}),
        };
        let response = self
            .http
            .post(format!("{}/accounts", self.api_base_url))
            .bearer_auth(access_token)
            .json(&body)
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;

        if response.status().as_u16() == 404 {
            return Err(BridgeError::new(
                ErrorKind::Validation,
                "That invite code does not match a workspace. Check it and try again.",
            ));
        }
        if !response.status().is_success() {
            return Err(classify_api_error(response).await);
        }

        let body: MeResponse = response
            .json()
            .await
            .map_err(|_| BridgeError::unknown("The account response could not be read."))?;
        Ok(TimerUser {
            id: body.user.id,
            email: body.user.email,
            name: body.user.name,
        })
    }

    /// Moves an existing account into a teammate's workspace.
    pub async fn join_organization(&self, access_token: &str, invite_code: &str) -> ApiResult<()> {
        let response = self
            .http
            .post(format!("{}/organization/join", self.api_base_url))
            .bearer_auth(access_token)
            .json(&serde_json::json!({ "inviteCode": invite_code }))
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;

        if response.status().is_success() {
            return Ok(());
        }
        Err(match response.status().as_u16() {
            404 => BridgeError::new(
                ErrorKind::Validation,
                "That invite code does not match a workspace.",
            ),
            409 => BridgeError::new(
                ErrorKind::Validation,
                "This account already recorded time here, so it cannot move.",
            ),
            _ => classify_api_error(response).await,
        })
    }

    pub async fn organization(&self, access_token: &str) -> ApiResult<Organization> {
        let body: OrganizationResponse = self.get_json(access_token, "/organization").await?;
        Ok(body.organization)
    }

    /// Renames the caller's workspace. Whether they may is the server's call,
    /// so its refusal comes back in its own words.
    pub async fn rename_organization(
        &self,
        access_token: &str,
        name: &str,
    ) -> ApiResult<Organization> {
        let response = self
            .http
            .patch(format!("{}/organization", self.api_base_url))
            .bearer_auth(access_token)
            .json(&serde_json::json!({ "name": name }))
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;
        if !response.status().is_success() {
            return Err(classify_api_error(response).await);
        }
        let body: OrganizationResponse = response
            .json()
            .await
            .map_err(|_| BridgeError::unknown("The workspace response could not be read."))?;
        Ok(body.organization)
    }

    /// The team view for a range. Bounds arrive together or not at all; none
    /// means all time, exactly as `/reports/workspace` reads it.
    pub async fn workspace_report(
        &self,
        access_token: &str,
        from_at: Option<&str>,
        to_exclusive_at: Option<&str>,
    ) -> ApiResult<WorkspaceReport> {
        match (from_at, to_exclusive_at) {
            (Some(from_at), Some(to_exclusive_at)) => {
                self.get_json_query(
                    access_token,
                    "/reports/workspace",
                    &[("fromAt", from_at), ("toExclusiveAt", to_exclusive_at)],
                )
                .await
            }
            _ => self.get_json(access_token, "/reports/workspace").await,
        }
    }

    /// Every shift in the range grouped by the codebase it worked, for the
    /// Agents tab. Bounds arrive together or not at all; none means all time.
    pub async fn agent_shifts(
        &self,
        access_token: &str,
        from_at: Option<&str>,
        to_exclusive_at: Option<&str>,
    ) -> ApiResult<AgentShifts> {
        let query = match (from_at, to_exclusive_at) {
            (Some(from_at), Some(to_exclusive_at)) => {
                format!("?fromAt={from_at}&toExclusiveAt={to_exclusive_at}")
            }
            _ => String::new(),
        };
        self.get_json(access_token, &format!("/reports/agent-shifts{query}"))
            .await
    }

    /// One page of one group's shifts, from the cursor the page before it
    /// returned. The bounds are the ones the group heads were read with,
    /// because a drawer that asked under a different range would list shifts
    /// its own head never counted.
    pub async fn agent_shift_rows(
        &self,
        access_token: &str,
        group_key: &str,
        after: Option<&AgentShiftCursor>,
        from_at: Option<&str>,
        to_exclusive_at: Option<&str>,
    ) -> ApiResult<AgentShiftRows> {
        let mut pairs = vec![("groupKey", group_key)];
        // Both halves of the cursor or neither: the filters schema refuses a
        // half cursor rather than guessing what it names.
        if let Some(after) = after {
            pairs.push(("afterStartedAt", after.started_at.as_str()));
            pairs.push(("afterId", after.id.as_str()));
            // The cursor's partition travels only when the cursor carries one: a
            // cursor from before the tie existed reads as untied, which is the
            // position its rows already sat in.
            if let Some(project_tied) = after.project_tied {
                pairs.push(("projectTied", if project_tied { "true" } else { "false" }));
            }
        }
        if let (Some(from_at), Some(to_exclusive_at)) = (from_at, to_exclusive_at) {
            pairs.push(("fromAt", from_at));
            pairs.push(("toExclusiveAt", to_exclusive_at));
        }
        self.get_json_query(access_token, "/reports/agent-shifts/rows", &pairs)
            .await
    }

    /// Who is running an agent right now, grouped by person. No bounds: the
    /// live view reads now, and the desktop reads it for everyone.
    pub async fn live_agent_sessions(&self, access_token: &str) -> ApiResult<LiveAgentSessions> {
        self.get_json(access_token, "/reports/agent-sessions/live")
            .await
    }

    pub async fn me(&self, access_token: &str) -> ApiResult<TimerUser> {
        let body: MeResponse = self.get_json(access_token, "/me").await?;
        Ok(TimerUser {
            id: body.user.id,
            email: body.user.email,
            name: body.user.name,
        })
    }

    pub async fn projects(&self, access_token: &str) -> ApiResult<Vec<TimerProject>> {
        let body: ProjectListResponse = self.get_json(access_token, "/projects").await?;
        Ok(body
            .projects
            .into_iter()
            .filter(|project| !project.is_archived)
            .map(|project| TimerProject {
                id: project.id,
                name: project.name,
                color: project.color,
                icon: project.icon,
                created_at: project.created_at,
            })
            .collect())
    }

    /// Creates a project for the signed-in member; the API answers 201 with the
    /// created list item, the same shape `/projects` returns.
    pub async fn create_project(&self, access_token: &str, name: &str) -> ApiResult<TimerProject> {
        let response = self
            .http
            .post(format!("{}/projects", self.api_base_url))
            .bearer_auth(access_token)
            .json(&serde_json::json!({ "name": name }))
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;

        if !response.status().is_success() {
            return Err(classify_api_error(response).await);
        }
        let body: ProjectListItem = response
            .json()
            .await
            .map_err(|_| BridgeError::unknown("The project response could not be read."))?;
        Ok(TimerProject {
            id: body.id,
            name: body.name,
            color: body.color,
            icon: body.icon,
            created_at: body.created_at,
        })
    }

    /// Renames or archives a project, or sets its icon and color, via
    /// `PATCH /projects/:id`.
    pub async fn update_project(
        &self,
        access_token: &str,
        id: &str,
        name: Option<&str>,
        is_archived: Option<bool>,
        icon: Option<&str>,
        color: Option<&str>,
    ) -> ApiResult<TimerProject> {
        let mut body = serde_json::Map::new();
        if let Some(name) = name {
            body.insert("name".into(), serde_json::json!(name));
        }
        if let Some(is_archived) = is_archived {
            body.insert("isArchived".into(), serde_json::json!(is_archived));
        }
        if let Some(icon) = icon {
            body.insert("icon".into(), serde_json::json!(icon));
        }
        if let Some(color) = color {
            body.insert("color".into(), serde_json::json!(color));
        }
        let response = self
            .http
            .patch(format!("{}/projects/{id}", self.api_base_url))
            .bearer_auth(access_token)
            .json(&serde_json::Value::Object(body))
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;
        if !response.status().is_success() {
            return Err(classify_api_error(response).await);
        }
        let body: ProjectListItem = response
            .json()
            .await
            .map_err(|_| BridgeError::unknown("The project response could not be read."))?;
        Ok(TimerProject {
            id: body.id,
            name: body.name,
            color: body.color,
            icon: body.icon,
            created_at: body.created_at,
        })
    }

    /// The shared dashboard view state.
    pub async fn view_preferences(&self, access_token: &str) -> ApiResult<ViewPreferences> {
        self.get_json(access_token, "/me/preferences").await
    }

    /// Writes the shared view state. Absent fields are left as they were, so
    /// this app can move the scope without claiming anything about the range
    /// the dashboard is showing.
    pub async fn set_view_preferences(
        &self,
        access_token: &str,
        scope: Option<&str>,
        range: Option<&str>,
    ) -> ApiResult<ViewPreferences> {
        let mut body = serde_json::Map::new();
        if let Some(scope) = scope {
            body.insert("scope".into(), serde_json::json!(scope));
        }
        if let Some(range) = range {
            body.insert("range".into(), serde_json::json!(range));
        }
        let response = self
            .http
            .put(format!("{}/me/preferences", self.api_base_url))
            .bearer_auth(access_token)
            .json(&serde_json::Value::Object(body))
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;
        if !response.status().is_success() {
            return Err(classify_api_error(response).await);
        }
        response
            .json()
            .await
            .map_err(|_| BridgeError::unknown("The preferences response could not be read."))
    }

    /// What deleting the project would take with it, for the confirm dialog.
    pub async fn project_usage(&self, access_token: &str, id: &str) -> ApiResult<ProjectUsage> {
        self.get_json(access_token, &format!("/projects/{id}/usage"))
            .await
    }

    /// Deletes a project; `reassign_to` moves its data to another project first.
    pub async fn delete_project(
        &self,
        access_token: &str,
        id: &str,
        reassign_to: Option<&str>,
    ) -> ApiResult<()> {
        let response = self
            .http
            .delete(format!("{}/projects/{id}", self.api_base_url))
            .bearer_auth(access_token)
            .json(&serde_json::json!({ "reassignTo": reassign_to }))
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;
        if response.status().is_success() {
            return Ok(());
        }
        Err(classify_api_error(response).await)
    }

    /// Uploads one batch of finished sessions (at most 500 rows; the caller
    /// chunks). Returns how many rows the server refused.
    pub async fn upload_observed_sessions(
        &self,
        access_token: &str,
        sessions: &[ObservedSession],
    ) -> ApiResult<usize> {
        let response = self
            .http
            .post(format!("{}/sessions/observed", self.api_base_url))
            .bearer_auth(access_token)
            .json(&serde_json::json!({ "sessions": sessions }))
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;

        if !response.status().is_success() {
            return Err(classify(response.status().as_u16()));
        }
        let outcome: ObservedSessionBatchOutcome = response
            .json()
            .await
            .map_err(|_| BridgeError::unknown("The session upload response could not be read."))?;
        Ok(outcome.rejected.len())
    }

    /// Uploads one activity-segment batch (at most 500 rows; the caller chunks).
    /// Idempotent on `clientId`, so a replayed batch counts as accepted.
    pub async fn upload_segments(
        &self,
        access_token: &str,
        segments: &[SegmentRecord],
    ) -> ApiResult<SegmentBatchOutcome> {
        let response = self
            .http
            .post(format!("{}/activity/segments", self.api_base_url))
            .bearer_auth(access_token)
            .json(&serde_json::json!({ "segments": segments }))
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;

        if !response.status().is_success() {
            return Err(classify(response.status().as_u16()));
        }
        response
            .json()
            .await
            .map_err(|_| BridgeError::unknown("The segment upload response could not be read."))
    }

    /// Uploads one shift-commit batch (at most 500 rows; the caller chunks).
    /// Idempotent on `clientId`; verification only ever advances forward, so a
    /// replayed batch is always safe to resend.
    pub async fn upload_shift_commits(
        &self,
        access_token: &str,
        commits: &[ShiftCommitUpload],
    ) -> ApiResult<ShiftCommitBatchOutcome> {
        let response = self
            .http
            .post(format!("{}/shift-commits", self.api_base_url))
            .bearer_auth(access_token)
            .json(&serde_json::json!({ "commits": commits }))
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;

        if !response.status().is_success() {
            return Err(classify(response.status().as_u16()));
        }
        response.json().await.map_err(|_| {
            BridgeError::unknown("The shift-commit upload response could not be read.")
        })
    }

    /// Uploads one drained agent-event batch (at most 500 rows; the caller
    /// chunks). The wire shape is projected (`AgentEventUpload`): the spool
    /// line's capture-only fields never leave the machine.
    pub async fn upload_agent_events(
        &self,
        access_token: &str,
        events: &[SpoolEvent],
    ) -> ApiResult<Vec<AgentEventOutcome>> {
        let events: Vec<AgentEventUpload> = events.iter().map(AgentEventUpload::from).collect();
        let response = self
            .http
            .post(format!("{}/agent-sessions", self.api_base_url))
            .bearer_auth(access_token)
            .json(&serde_json::json!({ "events": events }))
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;

        if !response.status().is_success() {
            return Err(classify(response.status().as_u16()));
        }
        let body: AgentEventBatchResponse = response.json().await.map_err(|_| {
            BridgeError::unknown("The agent-event upload response could not be read.")
        })?;
        Ok(body.results)
    }

    /// Uploads one agent-usage batch (at most 500 rows; the caller chunks).
    /// Idempotent on `clientId`; counters only restate upward, so a replayed
    /// batch is always safe to resend.
    pub async fn upload_agent_usage(
        &self,
        access_token: &str,
        usage: &[AgentUsageUpload],
    ) -> ApiResult<AgentUsageBatchOutcome> {
        let response = self
            .http
            .post(format!("{}/agent-usage", self.api_base_url))
            .bearer_auth(access_token)
            .json(&serde_json::json!({ "usage": usage }))
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;

        if !response.status().is_success() {
            return Err(classify(response.status().as_u16()));
        }
        response
            .json()
            .await
            .map_err(|_| BridgeError::unknown("The agent-usage upload response could not be read."))
    }

    /// Stats for a range, for the caller or for a named teammate.
    ///
    /// Instant bounds rather than calendar dates: the server reads a bare date
    /// as a UTC day, which would roll "today" over in the afternoon for anyone
    /// west of Greenwich. The caller sends its own local midnight instead.
    /// Omitting both bounds asks for all time.
    ///
    /// `user_id` opens a teammate's breakdown from the leaderboard. An id from
    /// outside the caller's workspace is refused as a stable not_found, the
    /// same answer the org report gives.
    pub async fn me_stats(
        &self,
        access_token: &str,
        from_at: Option<&str>,
        to_exclusive_at: Option<&str>,
        user_id: Option<&str>,
        scope: Option<&str>,
    ) -> ApiResult<MeStats> {
        let mut query: Vec<(&str, &str)> = Vec::new();
        if let (Some(from_at), Some(to_exclusive_at)) = (from_at, to_exclusive_at) {
            query.push(("fromAt", from_at));
            query.push(("toExclusiveAt", to_exclusive_at));
        }
        if let Some(user_id) = user_id {
            query.push(("userId", user_id));
        }
        if let Some(scope) = scope.filter(|scope| *scope != "all") {
            query.push(("scope", scope));
        }
        let response = self
            .http
            .get(format!("{}/me/stats", self.api_base_url))
            .query(&query)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;

        if !response.status().is_success() {
            return Err(classify_api_error(response).await);
        }
        response
            .json()
            .await
            .map_err(|_| BridgeError::unknown("The stats response could not be read."))
    }

    pub async fn path_mappings(&self, access_token: &str) -> ApiResult<Vec<PathMapping>> {
        let body: PathMappingListResponse = self.get_json(access_token, "/path-mappings").await?;
        Ok(body.mappings)
    }

    /// A GET whose query carries values that have to be escaped. A codebase
    /// label is a folder name, so it can hold the very characters that divide
    /// a query string - `&`, `#`, a space - and interpolating one would split
    /// a single label into two parameters.
    async fn get_json_query<T: serde::de::DeserializeOwned>(
        &self,
        access_token: &str,
        path: &str,
        pairs: &[(&str, &str)],
    ) -> ApiResult<T> {
        let mut url = Url::parse(&format!("{}{}", self.api_base_url, path))
            .map_err(|_| BridgeError::unknown("The request address could not be built."))?;
        url.query_pairs_mut().extend_pairs(pairs);
        self.get_json_url(access_token, url.as_str()).await
    }

    async fn get_json<T: serde::de::DeserializeOwned>(
        &self,
        access_token: &str,
        path: &str,
    ) -> ApiResult<T> {
        self.get_json_url(access_token, &format!("{}{}", self.api_base_url, path))
            .await
    }

    async fn get_json_url<T: serde::de::DeserializeOwned>(
        &self,
        access_token: &str,
        url: &str,
    ) -> ApiResult<T> {
        let response = self
            .http
            .get(url)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;

        if !response.status().is_success() {
            return Err(classify_api_error(response).await);
        }
        response
            .json()
            .await
            .map_err(|_| BridgeError::unknown("The server response could not be read."))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shifts map decodes tolerantly: an API older than this build sends
    /// no groups at all, and that is an empty tab, never a decode error.
    #[test]
    fn reads_the_shifts_map_and_an_older_apis_absence_as_empty() {
        let shifts: AgentShifts = serde_json::from_str(
            r#"{
                "totalAgentSeconds": 5400,
                "hourly": [{
                    "hourStart": "2026-08-06T15:00:00.000Z",
                    "activeSeconds": 0,
                    "agentSeconds": 5400,
                    "inputTokens": null,
                    "outputTokens": null,
                    "cacheCreationInputTokens": null,
                    "cacheReadInputTokens": null
                }],
                "groups": [{
                    "groupKey": "siqshift",
                    "repo": "siqshift",
                    "nullCause": null,
                    "agentSeconds": 5400,
                    "shiftCount": 1,
                    "heldRate": 0.5,
                    "aFieldFromTheFuture": true
                }]
            }"#,
        )
        .expect("the full shape decodes");
        assert_eq!(shifts.total_agent_seconds, 5400);
        assert_eq!(shifts.groups[0].group_key, "siqshift");
        assert_eq!(shifts.groups[0].shift_count, 1);
        assert_eq!(shifts.groups[0].null_cause, None);
        // The line above the groups is the server's series now, not a fold over
        // rows this response no longer carries.
        assert_eq!(shifts.hourly[0].agent_seconds, 5400);
        // An API that predates the token bars sends none, and none go on.
        assert_eq!(shifts.token_chart, None);
        assert!(!serde_json::to_string(&shifts)
            .expect("serializes")
            .contains("tokenChart"));

        // A newer API's cause rides through to the webview, so the desktop can
        // name why a group has no codebase instead of rendering one row for
        // every reason.
        let caused: AgentShifts = serde_json::from_str(
            r#"{"groups": [{"groupKey": "null:no-working-directory", "repo": null, "nullCause": "no-working-directory"}]}"#,
        )
        .expect("a cause decodes");
        assert_eq!(
            caused.groups[0].null_cause.as_deref(),
            Some("no-working-directory")
        );
        // And serializes back with the same camelCase name the decoder reads.
        let wire = serde_json::to_string(&caused).expect("serializes");
        assert!(wire.contains("nullCause\":\"no-working-directory\""));

        let empty: AgentShifts = serde_json::from_str("{}").expect("absence decodes");
        assert_eq!(empty.total_agent_seconds, 0);
        assert!(empty.groups.is_empty());
        assert!(empty.hourly.is_empty());

        // An API old enough to have sent the shifts inline names no group and
        // no series. Both degrade to empty, so an installed build that predates
        // the split shows heads rather than dying on decode. The absent key
        // lands here as an empty string and reaches the webview as one, which
        // is why the decoder there rebuilds it rather than trusting it.
        let bare: AgentShifts =
            serde_json::from_str(r#"{"groups": [{"repo": null, "shifts": [{"id": "s1"}]}]}"#)
                .expect("a bare group decodes");
        assert_eq!(bare.groups[0].held_rate, None);
        assert_eq!(bare.groups[0].group_key, "");
        let wire = serde_json::to_string(&bare).expect("serializes");
        assert!(wire.contains("\"groupKey\":\"\""));
    }

    /// The token bars reach the webview exactly as the server sent them: the
    /// host adds nothing up, so a total that is not in + out stays as it came.
    #[test]
    fn carries_the_servers_token_bars_through_as_given() {
        let shifts: AgentShifts = serde_json::from_str(
            r#"{"tokenChart": {
                "bucketSeconds": 3600,
                "buckets": [{"start": "2026-08-06T15:00:00.000Z", "tokensIn": 100, "tokensOut": 50, "tokens": 999}],
                "projects": [{
                    "project": {"id": "p1", "name": "Ledger"},
                    "tokens": 0,
                    "buckets": [{"start": "2026-08-06T15:00:00.000Z", "tokensIn": null, "tokensOut": null, "tokens": null}]
                }]
            }}"#,
        )
        .expect("token bars decode");

        let echoed = serde_json::to_value(&shifts).expect("serializes");

        assert_eq!(echoed["tokenChart"]["bucketSeconds"], 3_600);
        assert_eq!(echoed["tokenChart"]["buckets"][0]["tokens"], 999);
        assert_eq!(echoed["tokenChart"]["buckets"][0]["tokensIn"], 100);
        assert_eq!(
            echoed["tokenChart"]["projects"][0]["project"]["name"],
            "Ledger"
        );
        assert_eq!(
            echoed["tokenChart"]["projects"][0]["buckets"][0]["tokens"],
            serde_json::Value::Null
        );
    }

    /// The tokens per repo, per runtime and in total reach the webview as the
    /// server sent them, and an API that sends none leaves all three absent
    /// rather than zero.
    #[test]
    fn carries_the_servers_shift_tokens_through_and_leaves_absence_absent() {
        let shifts: AgentShifts = serde_json::from_str(
            r#"{
                "groups": [{"groupKey": "siqshift", "repo": "siqshift", "agentSeconds": 60, "shiftCount": 1, "tokens": 1200}],
                "runtimes": [{"source": "claude_code", "agentSeconds": 60, "shiftCount": 1, "tokens": 1200}],
                "tokenTotals": {"tokensIn": 1000, "tokensOut": 200, "tokens": 1200}
            }"#,
        )
        .expect("shift tokens decode");
        let echoed = serde_json::to_value(&shifts).expect("serializes");
        assert_eq!(echoed["groups"][0]["tokens"], 1_200);
        assert_eq!(echoed["runtimes"][0]["source"], "claude_code");
        assert_eq!(echoed["runtimes"][0]["tokens"], 1_200);
        assert_eq!(echoed["tokenTotals"]["tokensIn"], 1_000);
        assert_eq!(echoed["tokenTotals"]["tokens"], 1_200);

        let older: AgentShifts =
            serde_json::from_str(r#"{"groups": [{"groupKey": "siqshift", "repo": "siqshift"}]}"#)
                .expect("an older shape decodes");
        let wire = serde_json::to_value(&older).expect("serializes");
        assert!(wire["groups"][0].get("tokens").is_none());
        assert!(wire.get("runtimes").is_none());
        assert!(wire.get("tokenTotals").is_none());
    }

    /// One group's page decodes the same tolerant way, and an endpoint that is
    /// not there yet is an empty drawer rather than a dead tab.
    #[test]
    fn reads_a_page_of_one_groups_shifts() {
        let rows: AgentShiftRows = serde_json::from_str(
            r#"{
                "filters": {"groupKey": "siqshift", "pageSize": 50},
                "shifts": [{
                    "id": "s1",
                    "source": "claude_code",
                    "owner": {"id": "u1", "name": "Alex"},
                    "model": "claude-opus-5",
                    "startedAt": "2026-08-06T15:00:00.000Z",
                    "endedAt": "2026-08-06T16:00:00.000Z",
                    "agentSeconds": 5400,
                    "commitCount": 2,
                    "aFieldFromTheFuture": true
                }],
                "nextCursor": {"startedAt": "2026-08-06T15:00:00.000Z", "id": "s1"}
            }"#,
        )
        .expect("a page decodes");
        assert_eq!(rows.shifts[0].commit_count, 2);
        // The cursor is what tells a drawer another page exists, and it names
        // the last row rather than a position a re-sorted list would move.
        assert_eq!(
            rows.next_cursor,
            Some(AgentShiftCursor {
                started_at: "2026-08-06T15:00:00.000Z".to_string(),
                id: "s1".to_string(),
                project_tied: None,
            })
        );

        // A cursor that carries the tie round-trips it, so the next page is
        // cut under the same ordering this one was built under.
        let tied: AgentShiftRows = serde_json::from_str(
            r#"{
                "shifts": [],
                "nextCursor": {"startedAt": "2026-08-06T15:00:00.000Z", "id": "s1", "projectTied": true}
            }"#,
        )
        .expect("a tied cursor decodes");
        assert_eq!(tied.next_cursor.unwrap().project_tied, Some(true));

        // Spent, and absent, both read as nowhere further to go.
        let spent: AgentShiftRows = serde_json::from_str(r#"{"shifts": [], "nextCursor": null}"#)
            .expect("a spent page decodes");
        assert_eq!(spent.next_cursor, None);
        let empty: AgentShiftRows = serde_json::from_str("{}").expect("absence decodes");
        assert!(empty.shifts.is_empty());
        assert_eq!(empty.next_cursor, None);
    }

    #[test]
    fn maps_status_codes_onto_the_kinds_the_ui_branches_on() {
        assert_eq!(classify(401).kind, ErrorKind::Auth);
        assert_eq!(classify(403).kind, ErrorKind::Auth);
        assert_eq!(classify(409).kind, ErrorKind::Conflict);
        assert_eq!(classify(400).kind, ErrorKind::Validation);
        assert_eq!(classify(422).kind, ErrorKind::Validation);
        assert_eq!(classify(429).kind, ErrorKind::Transient);
        assert_eq!(classify(503).kind, ErrorKind::Transient);
        assert_eq!(classify(418).kind, ErrorKind::Unknown);
    }

    #[test]
    fn the_auth_host_answers_for_the_form_rather_than_for_the_deploy() {
        // `<input type="email">` passes `nobody@localdomain` and Neon Auth
        // answers 400 INVALID_EMAIL. Sharing the API's classifier reported the
        // server as broken for a typo the reader could see.
        assert_eq!(
            classify_auth(400, Some("INVALID_EMAIL")).message,
            "Enter a valid email address."
        );
        assert_eq!(
            classify_auth(401, None).message,
            "Incorrect email or password."
        );
        assert_eq!(classify_auth(400, None).kind, ErrorKind::Validation);
        assert_eq!(classify_auth(429, None).kind, ErrorKind::Transient);
        assert_eq!(classify_auth(503, None).kind, ErrorKind::Transient);
    }

    #[test]
    fn no_sign_in_failure_is_ever_reported_as_a_stale_session() {
        // "Your session expired. Sign in again." is `classify`'s answer for a
        // 401, and it is nonsense on the form that creates the session.
        for status in [400, 401, 403, 422, 429, 500, 503, 418] {
            let message = classify_auth(status, None).message;
            assert!(!message.contains("session"), "status {status}: {message}");
            assert!(!message.contains("timer"), "status {status}: {message}");
            assert!(!message.is_empty());
        }
    }

    #[test]
    fn error_messages_never_leak_a_token_url_or_server_body() {
        let secret = "eyJhbGciOiJFZERTQSJ9.payload.signature";
        for status in [400, 401, 403, 409, 422, 429, 500, 503, 418] {
            let message = classify(status).message;
            assert!(!message.contains(secret));
            assert!(!message.contains("http"));
            assert!(!message.contains("Bearer"));
            assert!(!message.is_empty());
        }
    }

    #[test]
    fn serializes_errors_in_the_shape_the_bridge_narrows_on() {
        let json =
            serde_json::to_value(BridgeError::auth("Sign in again.")).expect("error serializes");

        assert_eq!(json["kind"], "auth");
        assert_eq!(json["message"], "Sign in again.");
    }

    #[test]
    fn archived_projects_never_reach_the_picker() {
        let body: ProjectListResponse = serde_json::from_str(
            r##"{"projects":[
                {"id":"a","name":"Active","color":null,"createdAt":"2026-08-10T12:00:00Z","isArchived":false},
                {"id":"b","name":"Archived","color":"#2563eb","createdAt":"2026-08-11T12:00:00Z","isArchived":true}
            ]}"##,
        )
        .expect("project list parses");
        let visible: Vec<_> = body
            .projects
            .into_iter()
            .filter(|project| !project.is_archived)
            .map(|project| project.name)
            .collect();

        assert_eq!(visible, vec!["Active".to_string()]);
    }

    #[test]
    fn reads_a_created_project_without_a_color() {
        let body: ProjectListItem =
            serde_json::from_str(r#"{"id":"p1","name":"Field work","createdAt":"2026-08-10T12:00:00Z","isArchived":false}"#)
                .expect("created project parses");

        assert_eq!(body.name, "Field work");
        assert_eq!(body.color, None);
        assert_eq!(body.icon, None);
        assert!(!body.is_archived);
    }

    /// Any member may pick a project's icon and color: the pair goes out as
    /// the built-in names, and the project the server answers with reads back.
    #[tokio::test(flavor = "multi_thread")]
    async fn sends_a_picked_icon_and_color_and_reads_the_project_back() {
        const UPDATED: StubAnswer = (
            "200 OK",
            "",
            r##"{"id": "p1", "name": "Field work", "icon": "bolt", "color": "#c6a1f4", "createdAt": "2026-08-10T12:00:00Z", "isArchived": false}"##,
        );
        let (client, served) = scripted_stub(vec![UPDATED]).await;

        let project = client
            .update_project("token", "p1", None, None, Some("bolt"), Some("#c6a1f4"))
            .await
            .expect("the update reads");

        let requests = requests_seen(served).await;
        assert_eq!(requests[0].0, "PATCH /projects/p1");
        let sent: serde_json::Value =
            serde_json::from_str(&requests[0].1).expect("the request body is JSON");
        assert_eq!(
            sent,
            serde_json::json!({ "icon": "bolt", "color": "#c6a1f4" })
        );
        assert_eq!(project.icon.as_deref(), Some("bolt"));
        assert_eq!(project.color.as_deref(), Some("#c6a1f4"));
    }

    #[test]
    fn carries_a_projects_icon_and_color_through_the_team_view() {
        let row: WorkspaceProjectTotal = serde_json::from_str(
            r##"{"project": {"id": "p1", "name": "General", "icon": "grid", "color": "#a3b3c2"}, "durationSeconds": 60}"##,
        )
        .expect("the project row parses");

        let sent = serde_json::to_value(&row).expect("the project row serializes");
        assert_eq!(sent["project"]["icon"], "grid");
        assert_eq!(sent["project"]["color"], "#a3b3c2");
    }

    #[test]
    fn keeps_the_signed_session_cookie_verbatim_and_drops_its_attributes() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.append(
            reqwest::header::SET_COOKIE,
            "__Secure-neon-auth.session_token=abc123.XYZ%2Fsig%3D; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=None"
                .parse()
                .expect("header parses"),
        );

        assert_eq!(
            session_cookie_value(&headers).expect("cookie found"),
            "abc123.XYZ%2Fsig%3D"
        );
    }

    #[test]
    fn accepts_the_unprefixed_cookie_name_and_skips_unrelated_cookies() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.append(
            reqwest::header::SET_COOKIE,
            "other-cookie=nope; Path=/".parse().expect("header parses"),
        );
        headers.append(
            reqwest::header::SET_COOKIE,
            "neon-auth.session_token=tok.sig; Path=/"
                .parse()
                .expect("header parses"),
        );

        assert_eq!(
            session_cookie_value(&headers).expect("cookie found"),
            "tok.sig"
        );
    }

    #[test]
    fn errors_clearly_when_no_session_cookie_arrives() {
        let headers = reqwest::header::HeaderMap::new();

        let error = session_cookie_value(&headers).expect_err("no cookie, no session");
        assert_eq!(error.kind, ErrorKind::Unknown);
        assert!(error.message.contains("no session cookie"));
    }

    #[test]
    fn trims_trailing_slashes_so_paths_never_double_up() {
        let client = ApiClient::new(
            "https://auth.test/neondb/auth/".to_string(),
            "https://api.test/".to_string(),
        )
        .expect("client builds");

        assert_eq!(client.auth_base_url, "https://auth.test/neondb/auth");
        assert_eq!(client.api_base_url, "https://api.test");
        // The Origin header must be scheme and host only, never the base path.
        assert_eq!(client.auth_origin, "https://auth.test");
    }

    #[test]
    fn names_the_sign_up_failures_a_user_can_act_on() {
        for code in [
            "USER_ALREADY_EXISTS",
            "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
        ] {
            let taken = classify_auth(422, Some(code));
            assert_eq!(taken.kind, ErrorKind::AccountExists);
            assert!(taken.message.contains("sign in with it"));
        }
        assert!(classify_auth(400, Some("PASSWORD_TOO_SHORT"))
            .message
            .contains("8 characters"));
        assert!(classify_auth(400, Some("INVALID_EMAIL"))
            .message
            .contains("valid email"));
        for error in [
            classify_auth(400, Some("PASSWORD_TOO_SHORT")),
            classify_auth(400, Some("INVALID_EMAIL")),
        ] {
            assert_eq!(error.kind, ErrorKind::Validation);
        }
        // An unrecognized code falls back to the status mapping.
        assert_eq!(
            classify_auth(503, Some("SOMETHING_NEW")).kind,
            ErrorKind::Transient
        );
        assert_eq!(classify_auth(500, None).kind, ErrorKind::Transient);
    }

    #[test]
    fn reads_the_me_stats_response_shape() {
        let stats: MeStats = serde_json::from_str(
            r#"{
                "filters": {"from": "2026-08-01"},
                "totalDurationSeconds": 7200,
                "attributedSeconds": 5400,
                "unattributedSeconds": 1800,
                "projects": [{
                    "project": {"id": "p1", "name": "SIQshift"},
                    "durationSeconds": 7200,
                    "attributedSeconds": 5400,
                    "unattributedSeconds": 1800,
                    "sessionCount": 3
                }],
                "apps": [
                    {"processName": "Code.exe", "durationSeconds": 4800},
                    {"processName": "chrome.exe", "durationSeconds": 1200}
                ],
                "activeSeconds": 7000,
                "agentSeconds": 10800,
                "concurrency": {
                    "t0Seconds": 3400,
                    "t1Seconds": 0,
                    "t2Seconds": 3600,
                    "t3PlusSeconds": 0,
                    "awaySeconds": 3600
                },
                "byAgent": [
                    {"source": "claude_code", "model": null, "durationSeconds": 7200},
                    {"source": "codex", "model": "gpt-5", "durationSeconds": 3600}
                ],
                "hourly": [
                    {
                        "hourStart": "2026-08-06T09:00:00.000Z",
                        "activeSeconds": 3600,
                        "agentSeconds": 1800,
                        "inputTokens": 12000,
                        "outputTokens": 800,
                        "cacheCreationInputTokens": 400,
                        "cacheReadInputTokens": 60000
                    },
                    {
                        "hourStart": "2026-08-06T10:00:00.000Z",
                        "activeSeconds": 3600,
                        "agentSeconds": 0,
                        "inputTokens": null,
                        "outputTokens": null,
                        "cacheCreationInputTokens": null,
                        "cacheReadInputTokens": null
                    }
                ]
            }"#,
        )
        .expect("stats parse");

        // The measurement block must survive the round trip: the webview's
        // decoder rejects the whole reading if any of it is missing.
        assert_eq!(stats.active_seconds, 7_000);
        assert_eq!(stats.agent_seconds, 10_800);
        assert_eq!(stats.concurrency.t2_seconds, 3_600);
        assert_eq!(stats.concurrency.away_seconds, 3_600);
        assert_eq!(stats.by_agent[1].source, "codex");
        assert_eq!(stats.by_agent[1].model.as_deref(), Some("gpt-5"));
        // The hourly series rides through too: a dropped field here is how
        // the chart once shipped painting nothing.
        assert_eq!(stats.hourly.len(), 2);
        assert_eq!(stats.hourly[0].agent_seconds, 1_800);
        // Re-serialized to the webview in the camelCase the decoder reads.
        let echoed = serde_json::to_value(&stats).expect("stats serialize");
        assert_eq!(echoed["activeSeconds"], 7_000);
        assert_eq!(echoed["concurrency"]["t3PlusSeconds"], 0);
        assert_eq!(echoed["byAgent"][0]["durationSeconds"], 7_200);
        assert_eq!(echoed["hourly"][0]["activeSeconds"], 3_600);

        assert_eq!(stats.filters.from.as_deref(), Some("2026-08-01"));
        assert_eq!(stats.filters.to, None);
        assert_eq!(stats.projects[0].project.name, "SIQshift");
        assert_eq!(stats.attributed_seconds, 5400);
        assert_eq!(stats.unattributed_seconds, 1_800);
        assert_eq!(stats.projects[0].attributed_seconds, 5400);
        assert_eq!(stats.projects[0].unattributed_seconds, 1_800);
        assert_eq!(stats.apps[0].process_name, "Code.exe");
        assert_eq!(stats.apps[0].duration_seconds, 4800);
    }

    /// The team view asks the workspace route with the overlay's bounds, and
    /// the report rides on to the webview in the camelCase it arrived in.
    #[tokio::test(flavor = "multi_thread")]
    async fn reads_the_workspace_report_for_the_overlays_range() {
        const WORKSPACE: StubAnswer = (
            "200 OK",
            "",
            r#"{"filters": {}, "activeSeconds": 11640, "agentSeconds": 10800,
                "hourly": [{"hourStart": "2026-08-06T13:00:00.000Z", "activeSeconds": 3000, "agentSeconds": 3600}],
                "projects": [{"project": {"id": "p1", "name": "General"}, "durationSeconds": 8040}],
                "agents": [{"source": "a_runtime_from_the_future", "durationSeconds": 10800}],
                "members": [
                    {"rank": 1, "user": {"id": "u1", "name": "Sam"}, "activeSeconds": 8040, "agentSeconds": 10800,
                     "project": {"id": "p1", "name": "General"}},
                    {"rank": 2, "user": {"id": "u2", "name": "Alex"}, "activeSeconds": 3600, "agentSeconds": 0,
                     "project": null}
                ]}"#,
        );
        let (client, served) = scripted_stub(vec![WORKSPACE]).await;

        let report = client
            .workspace_report(
                "token",
                Some("2026-08-06T00:00:00.000Z"),
                Some("2026-08-07T00:00:00.000Z"),
            )
            .await
            .expect("the report reads");

        let requests = served.await.expect("the stub finishes");
        assert_eq!(
            requests[0].0,
            "GET /reports/workspace?fromAt=2026-08-06T00%3A00%3A00.000Z&toExclusiveAt=2026-08-07T00%3A00%3A00.000Z"
        );
        assert_eq!(report.active_seconds, 11_640);
        assert_eq!(report.members[1].project, None);
        // A runtime this build has never heard of still reads.
        assert_eq!(report.agents[0].source, "a_runtime_from_the_future");
        let sent = serde_json::to_value(&report).expect("the report serializes");
        assert_eq!(sent["members"][0]["project"]["name"], "General");
        assert_eq!(sent["members"][1]["project"], serde_json::Value::Null);
        assert_eq!(sent["hourly"][0]["hourStart"], "2026-08-06T13:00:00.000Z");
        assert_eq!(sent["projects"][0]["durationSeconds"], 8_040);
        // A server that predates project icons sends none, and none is made up.
        assert_eq!(
            sent["projects"][0]["project"]["icon"],
            serde_json::Value::Null
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn asks_the_workspace_report_for_all_time_with_no_bounds() {
        const WORKSPACE: StubAnswer = (
            "200 OK",
            "",
            r#"{"activeSeconds": 0, "agentSeconds": 0, "hourly": [], "projects": [], "agents": [], "members": []}"#,
        );
        let (client, served) = scripted_stub(vec![WORKSPACE]).await;

        client
            .workspace_report("token", None, None)
            .await
            .expect("the report reads");

        let requests = served.await.expect("the stub finishes");
        assert_eq!(requests[0].0, "GET /reports/workspace");
    }

    #[test]
    fn reads_segment_and_agent_event_batch_outcomes() {
        let segments: SegmentBatchOutcome = serde_json::from_str(
            r#"{"accepted": 2, "rejected": [{"clientId": "c1", "reason": "endedAt must be after startedAt"}]}"#,
        )
        .expect("segment outcome parses");
        assert_eq!(segments.accepted, 2);
        assert_eq!(segments.rejected[0].client_id, "c1");

        let events: AgentEventBatchResponse = serde_json::from_str(
            r#"{"results": [{"externalSessionId": "s1", "accepted": true},
                            {"externalSessionId": "s2", "accepted": false, "reason": "stale"}]}"#,
        )
        .expect("agent outcome parses");
        assert!(events.results[0].accepted);
        assert_eq!(events.results[1].reason.as_deref(), Some("stale"));
    }

    /// A codebase label is a folder name, so a group key can hold the very
    /// characters that divide a query string. What matters is the request the
    /// drawer actually puts on the wire: one escaped `groupKey` the server
    /// reads back whole, beside the cursor and the range the head was read
    /// with - not a label split into extra parameters.
    #[tokio::test(flavor = "multi_thread")]
    async fn asks_for_a_page_with_the_group_key_escaped_on_the_wire() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let body = r#"{"shifts": [{"id": "s1", "source": "claude_code",
            "owner": {"id": "u1", "name": "Alex"}, "model": "claude-opus-5",
            "startedAt": "2026-08-06T15:00:00.000Z", "endedAt": "2026-08-06T16:00:00.000Z",
            "agentSeconds": 3600, "commitCount": 2}], "nextCursor": null}"#;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("the loopback stub binds");
        let port = listener
            .local_addr()
            .expect("the stub has an address")
            .port();
        let served = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("the stub accepts");
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4_096];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = stream.read(&mut buffer).await.expect("the stub reads");
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
            }
            let response = format!(
                "HTTP/1.1 200 STUB\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream
                .write_all(response.as_bytes())
                .await
                .expect("the stub answers");
            stream.flush().await.expect("the stub flushes");
            String::from_utf8_lossy(&request).into_owned()
        });

        let client = ApiClient::new(
            format!("http://127.0.0.1:{port}/auth"),
            format!("http://127.0.0.1:{port}"),
        )
        .expect("the stub client builds");
        let cursor = AgentShiftCursor {
            started_at: "2026-08-06T14:00:00.000Z".to_string(),
            id: "s0".to_string(),
            project_tied: Some(true),
        };
        let page = client
            .agent_shift_rows(
                "token",
                "retire & 91 #2",
                Some(&cursor),
                Some("2026-08-06T00:00:00.000Z"),
                Some("2026-08-07T00:00:00.000Z"),
            )
            .await
            .expect("the page reads");

        let request = served.await.expect("the stub finishes");
        let target = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .expect("the request has a target")
            .to_string();
        let url =
            Url::parse(&format!("http://127.0.0.1:{port}{target}")).expect("the target is a URL");
        let pairs: Vec<(String, String)> = url
            .query_pairs()
            .map(|(name, value)| (name.into_owned(), value.into_owned()))
            .collect();

        assert_eq!(url.path(), "/reports/agent-shifts/rows");
        // The label survives the trip whole, and the separators inside it are
        // escaped rather than starting a parameter of their own.
        assert!(!target.contains("retire & 91 #2"), "target was {target}");
        assert_eq!(
            pairs,
            vec![
                ("groupKey".to_string(), "retire & 91 #2".to_string()),
                (
                    "afterStartedAt".to_string(),
                    "2026-08-06T14:00:00.000Z".to_string()
                ),
                ("afterId".to_string(), "s0".to_string()),
                ("projectTied".to_string(), "true".to_string()),
                ("fromAt".to_string(), "2026-08-06T00:00:00.000Z".to_string()),
                (
                    "toExclusiveAt".to_string(),
                    "2026-08-07T00:00:00.000Z".to_string()
                ),
            ]
        );
        assert_eq!(page.shifts.len(), 1);
        assert_eq!(page.shifts[0].commit_count, 2);
        assert!(page.next_cursor.is_none());
    }

    #[test]
    fn decodes_the_live_sessions_read_tolerantly() {
        // The whole shape, decoded whole: person, session, the server's own
        // description, and the codebase label beside it.
        let full: LiveAgentSessions = serde_json::from_str(
            r#"{
                "people": [{
                    "owner": {"id": "u1", "name": "Alex"},
                    "sessions": [{
                        "id": "s1",
                        "source": "claude_code",
                        "description": "Claude Code in siqshift, running 12m",
                        "repo": "siqshift",
                        "aFieldFromTheFuture": true
                    }]
                }]
            }"#,
        )
        .expect("a live roster decodes");
        assert_eq!(full.people.len(), 1);
        assert_eq!(full.people[0].owner.name, "Alex");
        assert_eq!(full.people[0].sessions.len(), 1);
        assert_eq!(full.people[0].sessions[0].repo.as_deref(), Some("siqshift"));

        // Absence on an older API decodes as nobody running, never an error -
        // the exact bridge rule the rest of this file keeps.
        let empty: LiveAgentSessions = serde_json::from_str("{}").expect("absence decodes");
        assert!(empty.people.is_empty());
    }

    /// One scripted answer of the loopback stub: status, extra header lines
    /// (each ending in CRLF) and body.
    type StubAnswer = (&'static str, &'static str, &'static str);

    const SIGNED_IN: StubAnswer = (
        "200 OK",
        "set-cookie: __Secure-neon-auth.session_token=signed.value; Path=/; HttpOnly\r\n",
        r#"{"token":"bare"}"#,
    );
    const ACCESS_TOKEN: StubAnswer = ("200 OK", "", r#"{"token":"access-jwt"}"#);
    const PROVISIONED: StubAnswer = (
        "200 OK",
        "",
        r#"{"user":{"id":"u1","email":"new.person@example.test","name":"Sam Example"}}"#,
    );
    const EMAIL_TAKEN: StubAnswer = (
        "422 Unprocessable Entity",
        "",
        r#"{"code":"USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL","message":"User already exists. Use another email."}"#,
    );
    const WRONG_PASSWORD: StubAnswer = (
        "401 Unauthorized",
        "",
        r#"{"code":"INVALID_EMAIL_OR_PASSWORD","message":"Invalid email or password"}"#,
    );

    /// Answers each connection in turn with the next scripted answer and
    /// returns every request it read as ("METHOD /path", body, authorization).
    async fn scripted_stub(
        answers: Vec<StubAnswer>,
    ) -> (
        ApiClient,
        tokio::task::JoinHandle<Vec<(String, String, Option<String>)>>,
    ) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("the loopback stub binds");
        let port = listener
            .local_addr()
            .expect("the stub has an address")
            .port();
        let served = tokio::spawn(async move {
            let mut requests = Vec::new();
            for (status, headers, body) in answers {
                let (mut stream, _) = listener.accept().await.expect("the stub accepts");
                let mut request = Vec::new();
                let mut buffer = [0_u8; 4_096];
                let body_start = loop {
                    if let Some(end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                        break end + 4;
                    }
                    let read = stream.read(&mut buffer).await.expect("the stub reads");
                    assert!(read > 0, "the request ended inside its headers");
                    request.extend_from_slice(&buffer[..read]);
                };
                let head = String::from_utf8_lossy(&request[..body_start]).into_owned();
                let length = head
                    .lines()
                    .find_map(|line| {
                        let lower = line.to_ascii_lowercase();
                        lower
                            .strip_prefix("content-length:")
                            .map(|value| value.trim().parse::<usize>().expect("a numeric length"))
                    })
                    .unwrap_or(0);
                while request.len() < body_start + length {
                    let read = stream.read(&mut buffer).await.expect("the stub reads");
                    assert!(read > 0, "the request ended inside its body");
                    request.extend_from_slice(&buffer[..read]);
                }
                let target = head
                    .lines()
                    .next()
                    .unwrap_or_default()
                    .split_whitespace()
                    .take(2)
                    .collect::<Vec<_>>()
                    .join(" ");
                let authorization = head.lines().find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("authorization")
                        .then(|| value.trim().to_string())
                });
                let sent = String::from_utf8_lossy(&request[body_start..body_start + length]);
                requests.push((target, sent.into_owned(), authorization));
                let response = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\n{headers}content-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream
                    .write_all(response.as_bytes())
                    .await
                    .expect("the stub answers");
                stream.flush().await.expect("the stub flushes");
            }
            requests
        });
        let client = ApiClient::new(
            format!("http://127.0.0.1:{port}/auth"),
            format!("http://127.0.0.1:{port}"),
        )
        .expect("the stub client builds");
        (client, served)
    }

    async fn requests_seen(
        served: tokio::task::JoinHandle<Vec<(String, String, Option<String>)>>,
    ) -> Vec<(String, String, Option<String>)> {
        tokio::time::timeout(std::time::Duration::from_secs(5), served)
            .await
            .expect("the stub saw every scripted request")
            .expect("the stub finishes")
    }

    /// Issue 84: with no code typed, provisioning sent `"inviteCode": null`,
    /// which the API's contract refuses, so every desktop sign-up without a
    /// code ended in "The server rejected the request as invalid."
    #[tokio::test(flavor = "multi_thread")]
    async fn provisioning_sends_the_invite_code_only_when_one_was_typed() {
        for (invite_code, expected_body) in [
            (None, "{}"),
            (Some("ACDEF-GHJKM"), r#"{"inviteCode":"ACDEF-GHJKM"}"#),
        ] {
            // Arrange
            let (client, served) = scripted_stub(vec![PROVISIONED]).await;

            // Act
            let user = client
                .provision_account("access-jwt", invite_code)
                .await
                .expect("the account provisions");

            // Assert
            assert_eq!(user.id, "u1");
            let requests = requests_seen(served).await;
            assert_eq!(
                requests,
                vec![(
                    "POST /accounts".to_string(),
                    expected_body.to_string(),
                    Some("Bearer access-jwt".to_string())
                )]
            );
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_refused_join_says_what_the_server_said() {
        // Arrange
        let (client, served) = scripted_stub(vec![(
            "400 Bad Request",
            "",
            r#"{"error":{"code":"validation_error","message":"That invite code is not in the right format."}}"#,
        )])
        .await;

        // Act
        let error = client
            .join_organization("access-jwt", "ACDEF-GHJK")
            .await
            .expect_err("the join is refused");

        // Assert
        assert_eq!(error.kind, ErrorKind::Validation);
        assert_eq!(
            error.message,
            "That invite code is not in the right format."
        );
        assert_eq!(requests_seen(served).await.len(), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn rename_organization_patches_the_name_and_reads_the_renamed_workspace() {
        // Arrange
        let (client, served) = scripted_stub(vec![(
            "200 OK",
            "",
            r#"{"organization":{"id":"00000000-0000-4000-8000-000000000900","name":"Atlas Studio","inviteCode":"ACDEF-GHJKM"}}"#,
        )])
        .await;

        // Act
        let organization = client
            .rename_organization("access-jwt", "Atlas Studio")
            .await
            .expect("the rename lands");

        // Assert
        assert_eq!(
            organization,
            Organization {
                id: "00000000-0000-4000-8000-000000000900".to_string(),
                name: "Atlas Studio".to_string(),
                invite_code: "ACDEF-GHJKM".to_string(),
            }
        );
        assert_eq!(
            requests_seen(served).await,
            vec![(
                "PATCH /organization".to_string(),
                r#"{"name":"Atlas Studio"}"#.to_string(),
                Some("Bearer access-jwt".to_string())
            )]
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn rename_organization_refused_for_a_member_says_what_the_server_said() {
        // Arrange
        let (client, served) = scripted_stub(vec![(
            "403 Forbidden",
            "",
            r#"{"error":{"code":"forbidden","message":"Only a workspace administrator can rename the workspace."}}"#,
        )])
        .await;

        // Act
        let error = client
            .rename_organization("access-jwt", "Atlas Studio")
            .await
            .expect_err("the rename is refused");

        // Assert
        assert_eq!(
            error.message,
            "Only a workspace administrator can rename the workspace."
        );
        assert_eq!(requests_seen(served).await.len(), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_refused_stats_read_says_what_the_server_said() {
        // Arrange
        let (client, served) = scripted_stub(vec![(
            "400 Bad Request",
            "",
            r#"{"error":{"code":"validation_error","message":"Invalid stats filters."}}"#,
        )])
        .await;

        // Act
        let error = client
            .me_stats("access-jwt", None, None, None, None)
            .await
            .expect_err("the stats read is refused");

        // Assert
        assert_eq!(error.kind, ErrorKind::Validation);
        assert_eq!(error.message, "Invalid stats filters.");
        assert_eq!(requests_seen(served).await.len(), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_refused_provisioning_says_what_the_server_said() {
        // Arrange
        let (client, served) = scripted_stub(vec![
            SIGNED_IN,
            ACCESS_TOKEN,
            (
                "400 Bad Request",
                "",
                r#"{"error":{"code":"validation_error","message":"The invite code must be text, or left out."}}"#,
            ),
        ])
        .await;

        // Act
        let error = client
            .sign_up_and_provision(
                "new.person@example.test",
                "correct horse",
                "Sam Example",
                None,
            )
            .await
            .err()
            .expect("the provisioning is refused");

        // Assert: the reason reaches the person, and no session comes back
        // for the caller to keep, so no half-made account stays signed in.
        assert_eq!(error.kind, ErrorKind::Validation);
        assert_eq!(error.message, "The invite code must be text, or left out.");
        assert_eq!(requests_seen(served).await.len(), 3);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_sign_up_with_a_taken_email_and_its_password_signs_in_and_provisions() {
        // Arrange
        let (client, served) =
            scripted_stub(vec![EMAIL_TAKEN, SIGNED_IN, ACCESS_TOKEN, PROVISIONED]).await;

        // Act
        let signed_up = client
            .sign_up_and_provision(
                "new.person@example.test",
                "correct horse",
                "Sam Example",
                Some("ACDEF-GHJKM"),
            )
            .await
            .expect("the account signs in");

        // Assert
        assert_eq!(signed_up.session, "signed.value");
        assert_eq!(signed_up.access_token, "access-jwt");
        let requests = requests_seen(served).await;
        let targets: Vec<&str> = requests
            .iter()
            .map(|(target, _, _)| target.as_str())
            .collect();
        assert_eq!(
            targets,
            vec![
                "POST /auth/sign-up/email",
                "POST /auth/sign-in/email",
                "GET /auth/token",
                "POST /accounts"
            ]
        );
        // A half-made account (signed up, never provisioned) lands in the
        // workspace its code names, not a personal one.
        assert_eq!(requests[3].1, r#"{"inviteCode":"ACDEF-GHJKM"}"#);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_sign_up_with_a_taken_email_and_another_password_moves_to_sign_in() {
        // Arrange
        let (client, served) = scripted_stub(vec![EMAIL_TAKEN, WRONG_PASSWORD]).await;

        // Act
        let error = client
            .sign_up_and_provision("new.person@example.test", "not it", "Sam Example", None)
            .await
            .err()
            .expect("the sign-up does not complete");

        // Assert
        assert_eq!(error.kind, ErrorKind::AccountExists);
        assert_eq!(
            error.message,
            "This email can't start a new account, so sign in with it or check it for a typo."
        );
        assert_eq!(requests_seen(served).await.len(), 2);
    }

    #[test]
    fn a_reasonless_refusal_says_where_to_report_it() {
        for status in [400, 422] {
            let error = classify(status);
            assert_eq!(error.kind, ErrorKind::Validation);
            assert!(
                error
                    .message
                    .contains("github.com/fpresta0607/SIQshift/issues"),
                "{}",
                error.message
            );
        }
    }
}
