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
    kCFRunLoopDefaultMode, CFDictionary, CFNotificationCenter, CFNotificationName,
    CFNotificationSuspensionBehavior, CFNumber, CFRetained, CFRunLoop, CFRunLoopSource, CFString,
};
use objc2_core_graphics::{CGEventSource, CGEventSourceStateID, CGEventType};

use super::{read_poll, rescued, unix_now, ActivitySignal, ActivitySource, PlatformEvents};

pub struct Poller;

impl Poller {
    pub fn new() -> Self {
        Self
    }
}

impl ActivitySource for Poller {
    fn poll(&self) -> ActivitySignal {
        // Hands off is not always away, exactly as on Windows: video, a call
        // or a presentation holding the display awake, or a live microphone,
        // means the person is still engaged. A probe that cannot answer never
        // rescues.
        read_poll(
            idle_seconds(),
            || rescued(&[&display_kept_awake, &microphone_in_use]),
            frontmost_app_name,
        )
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
const AUDIO_DEFAULT_INPUT_DEVICE: u32 = four_char_code(b"dIn ");
const AUDIO_DEVICE_IS_RUNNING_SOMEWHERE: u32 = four_char_code(b"gone");
const AUDIO_SCOPE_GLOBAL: u32 = four_char_code(b"glob");
const AUDIO_ELEMENT_MAIN: u32 = 0;

fn audio_property(object: u32, selector: u32) -> Option<u32> {
    let address = AudioPropertyAddress {
        selector,
        scope: AUDIO_SCOPE_GLOBAL,
        element: AUDIO_ELEMENT_MAIN,
    };
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

fn default_input_device() -> Option<u32> {
    audio_property(AUDIO_SYSTEM_OBJECT, AUDIO_DEFAULT_INPUT_DEVICE).filter(|&device| device != 0)
}

/// Rescue probe: is any app capturing from the default microphone right now.
/// Reading the device's running state needs no Microphone grant, because
/// SIQshift never opens the device. `None` without an input device or when
/// CoreAudio errs, which never rescues.
fn microphone_in_use() -> Option<bool> {
    audio_property(default_input_device()?, AUDIO_DEVICE_IS_RUNNING_SOMEWHERE)
        .map(|running| running != 0)
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
    use std::time::{Duration, Instant};

    use objc2_core_foundation::CFRunLoopRunResult;

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

    #[test]
    fn poll_reads_active_or_idle_from_the_real_system() {
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

    #[test]
    fn microphone_probe_answers_whenever_an_input_device_exists() {
        // Arrange
        let has_input_device = default_input_device().is_some();

        // Act
        let in_use = microphone_in_use();

        // Assert
        assert_eq!(in_use.is_some(), has_input_device);
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

    #[test]
    fn lock_broadcast_reaches_the_event_queue() {
        // Arrange: a private name, so the test never tells other apps the
        // screen locked.
        let name: &'static str = Box::leak(
            format!("com.siqshift.test.screenIsLocked.{}", std::process::id()).into_boxed_str(),
        );
        let events = Arc::new(PlatformEvents::new());
        spawn_event_thread_for(Arc::clone(&events), name);
        let center = CFNotificationCenter::distributed_center().expect("distributed center");
        let notification = CFString::from_str(name);

        // Act: post until the observer has registered and seen one, capped.
        // The center delivers through the run loop of the thread that first
        // obtained it, which is this one or the event thread, so this thread
        // runs its own loop between posts. (In the app that thread is AppKit's
        // main thread, whose loop always runs.)
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut seen = Vec::new();
        while seen.is_empty() && Instant::now() < deadline {
            unsafe { center.post_notification(Some(&notification), std::ptr::null(), None, true) };
            let pumped = CFRunLoop::run_in_mode(unsafe { kCFRunLoopDefaultMode }, 0.2, false);
            // A loop with no source returns at once; wait the slice anyway.
            if pumped == CFRunLoopRunResult::Finished {
                std::thread::sleep(Duration::from_millis(200));
            }
            seen = events.drain();
        }

        // Assert
        assert!(
            seen.iter()
                .any(|(_, signal)| *signal == ActivitySignal::Locked),
            "{seen:?}"
        );
    }
}
