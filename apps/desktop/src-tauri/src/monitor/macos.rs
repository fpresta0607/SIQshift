//! Read-only macOS access behind `ActivitySource`, plus the run-loop thread
//! that turns screen-lock and sleep broadcasts into signals. The mirror of
//! the Windows `platform` module: the same four signals, read through APIs
//! that need no privacy grant (no Accessibility, Input Monitoring, Screen
//! Recording or Microphone permission). Window titles are never read.

use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use objc2::rc::autoreleasepool;
use objc2_app_kit::NSWorkspace;
use objc2_core_foundation::{
    kCFRunLoopDefaultMode, CFBoolean, CFDictionary, CFNotificationCenter, CFNotificationName,
    CFNotificationSuspensionBehavior, CFNumber, CFRetained, CFRunLoop, CFRunLoopSource, CFString,
    CFType,
};
use objc2_core_graphics::{
    CGEventSource, CGEventSourceStateID, CGEventType, CGSessionCopyCurrentDictionary,
};

use super::{read_poll, rescued, unix_now, ActivitySignal, ActivitySource, PlatformEvents};

pub struct Poller;

impl Poller {
    pub fn new() -> Self {
        Self
    }
}

impl ActivitySource for Poller {
    fn poll(&self) -> ActivitySignal {
        poll_unless_locked(read_login_session(), || {
            // Hands off is not always away, exactly as on Windows: video, a
            // call or a presentation holding the display awake, or a live
            // microphone, means the person is still engaged. A probe that
            // cannot answer never rescues.
            read_poll(
                idle_seconds(),
                || rescued(&[&display_kept_awake, &microphone_in_use]),
                frontmost_app_name,
            )
        })
    }
}

/// A locked screen, or a session another user has switched in front of with
/// fast user switching, reads as locked, and nothing else is read: the input
/// clock and the probes describe the whole machine, so they would record the
/// other user's work or input at the lock screen. A session the window server
/// will not describe polls as usual.
fn poll_unless_locked(
    session: LoginSession,
    poll: impl FnOnce() -> ActivitySignal,
) -> ActivitySignal {
    if session.is_screen_locked || session.on_console == Some(false) {
        ActivitySignal::Locked
    } else {
        poll()
    }
}

/// What the window server says about this login session.
#[derive(Debug, PartialEq, Eq)]
struct LoginSession {
    /// Whether this session is the one on the screen. `None` when the window
    /// server will not say.
    on_console: Option<bool>,
    is_screen_locked: bool,
}

/// `kCGSessionOnConsoleKey`, a `CFSTR` macro in CGSession.h rather than an
/// exported symbol.
const SESSION_ON_CONSOLE_KEY: &str = "kCGSSessionOnConsoleKey";

/// Undocumented: the window server puts this entry in the session dictionary
/// only while the screen is locked. Read on every poll, it lets a process
/// started during a lock, which never receives the broadcast sent before it
/// ran, see that lock from its first poll.
const SCREEN_IS_LOCKED_KEY: &str = "CGSSessionScreenIsLocked";

/// One read of the session dictionary. A session the window server will not
/// describe reads as on an unknown console and not locked.
fn read_login_session() -> LoginSession {
    match CGSessionCopyCurrentDictionary() {
        // SAFETY: CGSession.h documents the session dictionary's keys as CFStrings.
        Some(dictionary) => {
            login_session(unsafe { dictionary.cast_unchecked::<CFString, CFType>() })
        }
        None => LoginSession {
            on_console: None,
            is_screen_locked: false,
        },
    }
}

/// The lock entry counts only as a true CFBoolean or a non-zero CFNumber;
/// any other value, or no entry, reads as not locked.
fn login_session(dictionary: &CFDictionary<CFString, CFType>) -> LoginSession {
    let on_console = dictionary
        .get(&CFString::from_static_str(SESSION_ON_CONSOLE_KEY))
        .and_then(|value| Some(value.downcast_ref::<CFBoolean>()?.as_bool()));
    let is_screen_locked = dictionary
        .get(&CFString::from_static_str(SCREEN_IS_LOCKED_KEY))
        .is_some_and(|value| match value.downcast_ref::<CFBoolean>() {
            Some(boolean) => boolean.as_bool(),
            None => value
                .downcast_ref::<CFNumber>()
                .and_then(CFNumber::as_i64)
                .is_some_and(|number| number != 0),
        });
    LoginSession {
        on_console,
        is_screen_locked,
    }
}

/// `kCGAnyInputEventType`: the last keyboard, mouse or trackpad event of any kind.
const ANY_INPUT_EVENT: CGEventType = CGEventType(u32::MAX);

/// Seconds since the last hardware input, per the HID system state. Reading
/// the time of the last event needs no Input Monitoring grant; reading the
/// events themselves would, and this never does.
fn idle_seconds() -> Option<u32> {
    let seconds = CGEventSource::seconds_since_last_event_type(
        CGEventSourceStateID::HIDSystemState,
        ANY_INPUT_EVENT,
    );
    (seconds.is_finite() && seconds >= 0.0).then_some(seconds as u32)
}

/// The frontmost app's name, never a window title. The bundle's file name
/// ("Google Chrome", "Visual Studio Code") rather than the executable's,
/// because Electron apps ship an executable literally named "Electron"; an
/// app without a bundle falls back to its executable's name. `None` when
/// nothing is frontmost, which the segment simply records without one.
fn frontmost_app_name() -> Option<String> {
    // The poll runs on a tokio worker that has no autorelease pool of its own.
    autoreleasepool(|_| {
        let app = NSWorkspace::sharedWorkspace().frontmostApplication()?;
        let url = app.bundleURL().or_else(|| app.executableURL())?;
        bare_app_name(&url.lastPathComponent()?.to_string())
    })
}

fn bare_app_name(file_name: &str) -> Option<String> {
    let name = file_name.strip_suffix(".app").unwrap_or(file_name).trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// `IOServiceInterestCallback`.
type PowerCallback = unsafe extern "C" fn(
    refcon: *mut c_void,
    service: u32,
    message_type: u32,
    argument: *mut c_void,
);

#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IOPMCopyAssertionsStatus(status: *mut *const CFDictionary) -> i32;
    fn IORegisterForSystemPower(
        refcon: *mut c_void,
        port: *mut *mut c_void,
        callback: PowerCallback,
        notifier: *mut u32,
    ) -> u32;
    fn IONotificationPortGetRunLoopSource(port: *mut c_void) -> *mut CFRunLoopSource;
    fn IOAllowPowerChange(root_port: u32, notification_id: isize) -> i32;
}

/// Rescue probe: does any app hold the display awake right now. Video
/// players, browsers playing video, call apps and presentations all take
/// this assertion; music alone does not, so it never rescues. `None` when
/// the power manager will not say, which never rescues.
fn display_kept_awake() -> Option<bool> {
    let mut status: *const CFDictionary = std::ptr::null();
    if unsafe { IOPMCopyAssertionsStatus(&mut status) } != 0 {
        return None;
    }
    let status = NonNull::new(status.cast_mut())?.cast::<CFDictionary<CFString, CFNumber>>();
    // SAFETY: a Copy-rule result this function now owns; IOPMLib documents
    // its keys as assertion type names and its values as CFNumber counts.
    let status = unsafe { CFRetained::from_raw(status) };
    let holders = status
        .get(&CFString::from_static_str("PreventUserIdleDisplaySleep"))?
        .as_i64()?;
    Some(holders > 0)
}

/// `AudioObjectPropertyAddress`.
#[repr(C)]
struct AudioPropertyAddress {
    selector: u32,
    scope: u32,
    element: u32,
}

#[link(name = "CoreAudio", kind = "framework")]
extern "C" {
    fn AudioObjectGetPropertyDataSize(
        object: u32,
        address: *const AudioPropertyAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        data_size: *mut u32,
    ) -> i32;
    fn AudioObjectGetPropertyData(
        object: u32,
        address: *const AudioPropertyAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        data_size: *mut u32,
        data: *mut c_void,
    ) -> i32;
}

const fn four_char_code(code: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*code)
}

const AUDIO_SYSTEM_OBJECT: u32 = 1;
/// `kAudioHardwarePropertyProcessObjectList`, macOS 14 and later.
const AUDIO_PROCESS_OBJECT_LIST: u32 = four_char_code(b"prs#");
/// `kAudioProcessPropertyIsRunningInput`, macOS 14 and later.
const AUDIO_PROCESS_IS_RUNNING_INPUT: u32 = four_char_code(b"piri");
const AUDIO_SCOPE_GLOBAL: u32 = four_char_code(b"glob");
const AUDIO_ELEMENT_MAIN: u32 = 0;

fn audio_address(selector: u32) -> AudioPropertyAddress {
    AudioPropertyAddress {
        selector,
        scope: AUDIO_SCOPE_GLOBAL,
        element: AUDIO_ELEMENT_MAIN,
    }
}

fn audio_property(object: u32, selector: u32) -> Option<u32> {
    let address = audio_address(selector);
    let mut value = 0u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(
            object,
            &address,
            0,
            std::ptr::null(),
            &mut size,
            (&mut value as *mut u32).cast(),
        )
    };
    (status == 0 && size == std::mem::size_of::<u32>() as u32).then_some(value)
}

/// A property holding a list of audio object IDs.
fn audio_object_list(object: u32, selector: u32) -> Option<Vec<u32>> {
    let address = audio_address(selector);
    let mut size = 0u32;
    let status =
        unsafe { AudioObjectGetPropertyDataSize(object, &address, 0, std::ptr::null(), &mut size) };
    if status != 0 {
        return None;
    }
    let mut objects = vec![0u32; size as usize / std::mem::size_of::<u32>()];
    size = std::mem::size_of_val(objects.as_slice()) as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(
            object,
            &address,
            0,
            std::ptr::null(),
            &mut size,
            objects.as_mut_ptr().cast(),
        )
    };
    if status != 0 {
        return None;
    }
    objects.truncate(size as usize / std::mem::size_of::<u32>());
    Some(objects)
}

/// Rescue probe: is any app capturing audio input right now. Asked of each
/// process, not of a device, because a headset is one device for both
/// directions and music playing through it would read as a live microphone.
/// Reading it needs no Microphone grant, because SIQshift never opens a
/// device. `None` before macOS 14, which has no process list, or when
/// CoreAudio errs; either never rescues. Before macOS 14 there is
/// deliberately no device-wide fallback, which would bring back that
/// headset's music reading as a live microphone.
fn microphone_in_use() -> Option<bool> {
    let processes = audio_object_list(AUDIO_SYSTEM_OBJECT, AUDIO_PROCESS_OBJECT_LIST)?;
    Some(processes.into_iter().any(|process| {
        audio_property(process, AUDIO_PROCESS_IS_RUNNING_INPUT).is_some_and(|running| running != 0)
    }))
}

/// The distributed notification loginwindow posts when the screen locks.
const SCREEN_LOCKED_NOTIFICATION: &str = "com.apple.screenIsLocked";

/// `kIOMessageCanSystemSleep`: idle sleep is being considered.
const CAN_SYSTEM_SLEEP: u32 = 0xe000_0270;
/// `kIOMessageSystemWillSleep`: the machine is going to sleep.
const SYSTEM_WILL_SLEEP: u32 = 0xe000_0280;

/// The root power port `IOAllowPowerChange` answers through, set once the
/// registration succeeds and before the run loop can deliver a message.
static ROOT_POWER_PORT: AtomicU32 = AtomicU32::new(0);

/// Publishes screen-lock and sleep broadcasts into `events`. Runs for the
/// process lifetime: the thread is created once, and between broadcasts it
/// sleeps inside its run loop at zero background cost.
pub fn spawn_event_thread(events: Arc<PlatformEvents>) {
    spawn_event_thread_for(events, SCREEN_LOCKED_NOTIFICATION);
}

/// `spawn_event_thread` with the lock notification's name as a parameter, so
/// a test can broadcast a private name instead of telling every app on the
/// machine that the screen locked.
fn spawn_event_thread_for(events: Arc<PlatformEvents>, lock_notification: &'static str) {
    std::thread::spawn(move || event_loop(events, lock_notification));
}

/// Starts the event thread on a private lock name and returns whether it has
/// queued a lock yet. Only `tests/macos_lock_broadcast.rs` calls it: the
/// broadcast arrives through the main thread's run loop, which the default
/// test harness never runs.
#[doc(hidden)]
pub fn lock_probe(lock_notification: &'static str) -> impl Fn() -> bool {
    let events = Arc::new(PlatformEvents::new());
    spawn_event_thread_for(Arc::clone(&events), lock_notification);
    move || {
        events
            .drain()
            .iter()
            .any(|(_, signal)| *signal == ActivitySignal::Locked)
    }
}

fn event_loop(events: Arc<PlatformEvents>, lock_notification: &'static str) {
    let Some(run_loop) = CFRunLoop::current() else {
        return;
    };
    // Both callbacks find the queue through this pointer. The Arc is
    // deliberately leaked, as on Windows: the observers outlive any monitor
    // start/stop.
    let events = Arc::into_raw(events).cast::<c_void>();

    if let Some(center) = CFNotificationCenter::distributed_center() {
        let name = CFString::from_static_str(lock_notification);
        unsafe {
            center.add_observer(
                events,
                Some(on_screen_locked),
                Some(&name),
                std::ptr::null(),
                CFNotificationSuspensionBehavior::DeliverImmediately,
            );
        }
    }

    let mut port: *mut c_void = std::ptr::null_mut();
    let mut notifier = 0u32;
    let root_port = unsafe {
        IORegisterForSystemPower(
            events.cast_mut(),
            &mut port,
            on_power_message,
            &mut notifier,
        )
    };
    if root_port != 0 && !port.is_null() {
        ROOT_POWER_PORT.store(root_port, Ordering::SeqCst);
        let source = unsafe { IONotificationPortGetRunLoopSource(port) };
        if let Some(source) = unsafe { source.as_ref() } {
            run_loop.add_source(Some(source), unsafe { kCFRunLoopDefaultMode });
        }
    }

    CFRunLoop::run();
}

unsafe extern "C-unwind" fn on_screen_locked(
    _center: *mut CFNotificationCenter,
    observer: *mut c_void,
    _name: *const CFNotificationName,
    _object: *const c_void,
    _user_info: *const CFDictionary,
) {
    if let Some(events) = unsafe { observer.cast::<PlatformEvents>().as_ref() } {
        events.push(unix_now(), ActivitySignal::Locked);
    }
}

/// The signal a power message raises. Only the sleep itself counts; wake
/// raises nothing, because the next poll's Active or Idle signal closes the
/// span the same way a transition would.
fn power_message_signal(message_type: u32) -> Option<ActivitySignal> {
    (message_type == SYSTEM_WILL_SLEEP).then_some(ActivitySignal::Suspended)
}

unsafe extern "C" fn on_power_message(
    refcon: *mut c_void,
    _service: u32,
    message_type: u32,
    argument: *mut c_void,
) {
    let events = unsafe { refcon.cast::<PlatformEvents>().as_ref() };
    if let (Some(signal), Some(events)) = (power_message_signal(message_type), events) {
        events.push(unix_now(), signal);
    }
    // Both messages wait for an answer (sleep stalls up to 30 seconds
    // without one); SIQshift never vetoes or delays sleep.
    if matches!(message_type, CAN_SYSTEM_SLEEP | SYSTEM_WILL_SLEEP) {
        unsafe { IOAllowPowerChange(ROOT_POWER_PORT.load(Ordering::SeqCst), argument as isize) };
    }
}

// These run against the real platform and only on macOS: CI's macOS job is
// where they prove the module, since a cross-compile cannot.
#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    #[test]
    fn idle_seconds_reads_the_input_clock() {
        // Act
        let idle = idle_seconds();

        // Assert
        assert!(
            idle.is_some(),
            "the HID system state always has a last input"
        );
    }

    // The test process runs inside the runner's logged-in GUI session, on the
    // console and unlocked, so the window server must describe it as such. A
    // missing console entry means a wrong key or value type, and the fast user
    // switching guard could never fire; a lock read here means the
    // undocumented lock entry reads as locked on an unlocked screen, and every
    // poll would record nothing.
    #[test]
    fn session_probe_reads_the_window_server() {
        // Act
        let session = read_login_session();

        // Assert
        assert!(
            session.on_console.is_some(),
            "CGSession did not say whether this session is on the console"
        );
        assert!(
            !session.is_screen_locked,
            "CGSession read the runner's unlocked screen as locked"
        );
    }

    // The same unlocked session on the console: the poll must read the input
    // clock and never read Locked.
    #[test]
    fn poll_reads_the_runners_unlocked_session_as_active_or_idle() {
        // Act
        let signal = Poller::new().poll();

        // Assert
        assert!(
            matches!(
                signal,
                ActivitySignal::Active { .. } | ActivitySignal::Idle { .. }
            ),
            "{signal:?}"
        );
    }

    #[test]
    fn a_locked_screen_or_a_session_off_the_console_reads_locked_without_polling() {
        let active = ActivitySignal::Active {
            process_name: Some("Terminal".to_string()),
            idle_seconds: Some(3),
        };
        let cases = [
            (Some(true), false, active.clone(), true),
            (Some(false), false, ActivitySignal::Locked, false),
            (None, false, active.clone(), true),
            (Some(true), true, ActivitySignal::Locked, false),
            (Some(false), true, ActivitySignal::Locked, false),
            (None, true, ActivitySignal::Locked, false),
        ];
        for (on_console, is_screen_locked, expected, should_poll) in cases {
            // Arrange
            let session = LoginSession {
                on_console,
                is_screen_locked,
            };
            let has_polled = Cell::new(false);

            // Act
            let signal = poll_unless_locked(session, || {
                has_polled.set(true);
                active.clone()
            });

            // Assert
            assert_eq!(signal, expected, "{on_console:?} {is_screen_locked}");
            assert_eq!(
                has_polled.get(),
                should_poll,
                "{on_console:?} {is_screen_locked}"
            );
        }
    }

    #[test]
    fn the_lock_entry_reads_locked_only_as_true_or_a_non_zero_number() {
        let on_console_key = CFString::from_static_str(SESSION_ON_CONSOLE_KEY);
        let screen_is_locked_key = CFString::from_static_str(SCREEN_IS_LOCKED_KEY);
        let on_console: &CFType = CFBoolean::new(true);
        let one = CFNumber::new_i32(1);
        let zero = CFNumber::new_i32(0);
        let text = CFString::from_static_str("1");
        let cases: [(Option<&CFType>, bool); 6] = [
            (Some(CFBoolean::new(true)), true),
            (Some(&one), true),
            (Some(CFBoolean::new(false)), false),
            (Some(&zero), false),
            (Some(&text), false),
            (None, false),
        ];
        for (lock_entry, is_screen_locked) in cases {
            // Arrange
            let dictionary = match lock_entry {
                Some(lock_entry) => CFDictionary::from_slices(
                    &[&*on_console_key, &*screen_is_locked_key],
                    &[on_console, lock_entry],
                ),
                None => CFDictionary::from_slices(&[&*on_console_key], &[on_console]),
            };

            // Act
            let session = login_session(&dictionary);

            // Assert
            assert_eq!(
                session,
                LoginSession {
                    on_console: Some(true),
                    is_screen_locked,
                },
                "{lock_entry:?}"
            );
        }
    }

    #[test]
    fn frontmost_app_name_is_a_bare_name_when_an_app_is_in_front() {
        // Act
        let name = frontmost_app_name();

        // Assert
        if let Some(name) = name {
            assert!(!name.is_empty(), "{name}");
            assert!(!name.contains('/'), "{name}");
            assert!(!name.ends_with(".app"), "{name}");
        }
    }

    #[test]
    fn bare_app_name_strips_only_the_bundle_suffix() {
        let cases = [
            ("Google Chrome.app", Some("Google Chrome")),
            ("Visual Studio Code.app", Some("Visual Studio Code")),
            ("codex", Some("codex")),
            ("zoom.us.app", Some("zoom.us")),
            (".app", None),
            ("", None),
        ];
        for (file_name, expected) in cases {
            // Act
            let name = bare_app_name(file_name);

            // Assert
            assert_eq!(name.as_deref(), expected, "{file_name}");
        }
    }

    #[test]
    fn display_probe_reads_the_power_manager() {
        // Act
        let kept_awake = display_kept_awake();

        // Assert
        assert!(
            kept_awake.is_some(),
            "IOPMCopyAssertionsStatus answered nothing"
        );
    }

    // CI's macOS runners are macOS 14 or later, where CoreAudio lists its
    // client processes; a `None` here means the process list never loaded.
    #[test]
    fn microphone_probe_reads_coreaudio_process_list() {
        // Act
        let in_use = microphone_in_use();

        // Assert
        assert!(in_use.is_some(), "CoreAudio listed no processes");
    }

    #[test]
    fn power_messages_raise_suspended_only_for_the_sleep_itself() {
        let cases = [
            (SYSTEM_WILL_SLEEP, Some(ActivitySignal::Suspended)),
            (CAN_SYSTEM_SLEEP, None),
            // kIOMessageSystemHasPoweredOn: wake raises nothing.
            (0xe000_0300, None),
        ];
        for (message_type, expected) in cases {
            // Act
            let signal = power_message_signal(message_type);

            // Assert
            assert_eq!(signal, expected, "{message_type:#x}");
        }
    }
}
