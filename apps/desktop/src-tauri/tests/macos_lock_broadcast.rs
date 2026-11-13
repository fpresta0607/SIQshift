//! The lock observer sees the screen-lock broadcast once the main thread's run
//! loop runs, as AppKit runs it in the app. It has no test harness because the
//! default harness runs every test off the main thread and never runs that
//! loop, so there the broadcast never arrives.

#[cfg(target_os = "macos")]
fn main() {
    use std::time::{Duration, Instant};

    use objc2_core_foundation::{
        kCFRunLoopDefaultMode, CFNotificationCenter, CFRunLoop, CFRunLoopRunResult, CFString,
    };

    // Arrange: a private name, so the test never tells other apps the screen
    // locked.
    let name: &'static str = Box::leak(
        format!("com.siqshift.test.screenIsLocked.{}", std::process::id()).into_boxed_str(),
    );
    let has_seen_lock = siqshift_desktop_lib::macos_lock_probe(name);
    let center = CFNotificationCenter::distributed_center().expect("distributed center");
    let notification = CFString::from_str(name);

    // Act: post until the observer has registered and seen one, capped, while
    // this main thread runs its run loop between posts.
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut is_locked = false;
    while !is_locked && Instant::now() < deadline {
        unsafe { center.post_notification(Some(&notification), std::ptr::null(), None, true) };
        let pumped = CFRunLoop::run_in_mode(unsafe { kCFRunLoopDefaultMode }, 0.2, false);
        // A loop with no source returns at once; wait the slice anyway.
        if pumped == CFRunLoopRunResult::Finished {
            std::thread::sleep(Duration::from_millis(200));
        }
        is_locked = has_seen_lock();
    }

    // Assert
    assert!(
        is_locked,
        "no lock broadcast reached the observer with the main run loop running"
    );
    println!("lock broadcast reached the event queue");
}

#[cfg(not(target_os = "macos"))]
fn main() {}
