//! A Windows job object that ends every process in it when its last handle
//! closes, however that happens: dropped here, or closed by the OS when the
//! process holding it ends.

use std::mem::size_of;
use std::os::windows::io::AsRawHandle;
use std::process::Child;
use std::ptr::{addr_of, null};

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::GetCurrentProcess;

pub struct KillOnCloseJob {
    handle: HANDLE,
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
            let job = Self { handle };
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let is_configured = SetInformationJobObject(
                job.handle,
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
        unsafe { AssignProcessToJobObject(self.handle, GetCurrentProcess()) != 0 }
    }

    /// Adds a child, and every process it starts from then on, to the job.
    /// False when the OS refuses, such as for a child that already exited.
    pub fn assign_child(&self, child: &Child) -> bool {
        // SAFETY: the job handle is owned here and the child's handle stays
        // open for as long as `child` is borrowed.
        unsafe { AssignProcessToJobObject(self.handle, child.as_raw_handle()) != 0 }
    }
}

impl Drop for KillOnCloseJob {
    fn drop(&mut self) {
        // SAFETY: the handle was created by `create` and is closed only here.
        unsafe {
            CloseHandle(self.handle);
        }
    }
}
