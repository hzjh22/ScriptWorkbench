use std::{mem::size_of, sync::Arc};

use anyhow::{anyhow, Context};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::GetProcessId,
    },
};

pub(crate) struct ProcessTree {
    handle: HANDLE,
}

unsafe impl Send for ProcessTree {}
unsafe impl Sync for ProcessTree {}

impl ProcessTree {
    pub(crate) fn attach(child: &tokio::process::Child) -> anyhow::Result<Arc<Self>> {
        let process_handle = child
            .raw_handle()
            .ok_or_else(|| anyhow!("无法获取子进程句柄"))? as HANDLE;
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(std::io::Error::last_os_error())
                    .context("创建 Windows Job Object 失败");
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                CloseHandle(job);
                return Err(std::io::Error::last_os_error())
                    .context("配置 Windows Job Object 失败");
            }
            if AssignProcessToJobObject(job, process_handle) == 0 {
                CloseHandle(job);
                return Err(std::io::Error::last_os_error())
                    .context("子进程加入 Windows Job Object 失败");
            }
            if GetProcessId(process_handle) == 0 {
                CloseHandle(job);
                return Err(std::io::Error::last_os_error()).context("验证子进程句柄失败");
            }
            Ok(Arc::new(Self { handle: job }))
        }
    }

    pub(crate) fn terminate(&self) -> anyhow::Result<()> {
        let result = unsafe { TerminateJobObject(self.handle, 1) };
        if result == 0 {
            Err(std::io::Error::last_os_error()).context("终止进程树失败")
        } else {
            Ok(())
        }
    }
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe { CloseHandle(self.handle) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn terminates_the_owned_process_tree() {
        let mut child = tokio::process::Command::new("cmd")
            .args(["/C", "ping -n 30 127.0.0.1 >NUL"])
            .spawn()
            .unwrap();
        let tree = ProcessTree::attach(&child).unwrap();
        tree.terminate().unwrap();
        let exit = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(!exit.success());
    }
}
