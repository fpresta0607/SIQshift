//! A Windows job object that ends every process in it when its last handle
//! closes, however that happens: dropped here, or closed by the OS when the
//! process holding it ends.

use std::mem::size_of;
use std::os::windows::io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle};
use std::ptr::{addr_of, null};

use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::GetCurrentProcess;

/// Owns the job's handle, which closes when this drops. A kernel handle may be
/// used and closed from any thread, so a job can be held across an `.await`.
pub struct KillOnCloseJob {
    handle: OwnedHandle,
}

impl KillOnCloseJob {
    /// `None` when the OS refuses the job or its kill-on-close limit.
    pub fn create() -> Option<Self> {
        // SAFETY: plain Win32 calls on a handle created here and owned by the
        // returned value, with a zeroed all-integer limit struct whose size is
        // passed alongside it.
        unsafe {
            let handle = CreateJobObjectW(null(), null());
            if handle.is_null() {
                return None;
            }
            let job = Self {
                handle: OwnedHandle::from_raw_handle(handle),
            };
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let is_configured = SetInformationJobObject(
                job.handle.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                addr_of!(limits).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) != 0;
            is_configured.then_some(job)
        }
    }

    /// Adds this process, and every process it starts from then on, to the
    /// job. False when the OS refuses.
    pub fn assign_current_process(&self) -> bool {
        // SAFETY: the job handle is owned here and the pseudo handle of the
        // current process is always valid.
        unsafe { AssignProcessToJobObject(self.handle.as_raw_handle(), GetCurrentProcess()) != 0 }
    }

    /// Adds a process, by a handle to it, and every process it starts from
    /// then on, to the job. False when the OS refuses, such as for a process
    /// that already exited.
    pub fn assign_process(&self, process: BorrowedHandle<'_>) -> bool {
        // SAFETY: the job handle is owned here and the process handle stays
        // open for as long as it is borrowed.
        unsafe {
            AssignProcessToJobObject(self.handle.as_raw_handle(), process.as_raw_handle()) != 0
        }
    }
}
