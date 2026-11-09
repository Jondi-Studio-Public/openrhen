//! Restart on crash. On Windows `install` registers a per-user Scheduled Task named `rhen-watch` that starts
//! the agent at logon and restarts it when it exits non-zero. Everything that can be decided without
//! Windows lives here, so it is tested on any OS: the task XML, the `schtasks` arguments, whether to fall
//! back to the HKCU Run entry, the `status` line, and the exit code that tells Task Scheduler "clean stop" (0,
//! no restart) from "crash" (non-zero, restart).

pub const TASK_NAME: &str = "rhen-watch";

pub fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}

/// The task definition. `user_id` is the current user's SID (or `DOMAIN\user`); `command` is the installed
/// `rhen-watchw.exe`. No admin rights: a logon trigger for this user, the interactive token, least privilege.
pub fn task_xml(user_id: &str, command: &str) -> String {
    let user = xml_escape(user_id);
    let command = xml_escape(command);
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Restarts the rhen-watch activity recorder if it crashes or is killed.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{user}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{command}</Command>
      <Arguments>run</Arguments>
    </Exec>
  </Actions>
</Task>
"#
    )
}

/// The bytes to write to the temp file `schtasks /XML` reads: UTF-16LE with a byte order mark, which is what
/// the declaration in the XML says and what Task Scheduler itself exports.
pub fn task_file_bytes(xml: &str) -> Vec<u8> {
    let mut out = vec![0xFF, 0xFE];
    for u in xml.encode_utf16() {
        out.extend_from_slice(&u.to_le_bytes());
    }
    out
}

pub fn create_args(xml_path: &str) -> Vec<String> {
    ["/Create", "/TN", TASK_NAME, "/XML", xml_path, "/F"].map(String::from).to_vec()
}

pub fn run_args() -> Vec<String> {
    ["/Run", "/TN", TASK_NAME].map(String::from).to_vec()
}

pub fn delete_args() -> Vec<String> {
    ["/Delete", "/TN", TASK_NAME, "/F"].map(String::from).to_vec()
}

pub fn query_args() -> Vec<String> {
    ["/Query", "/TN", TASK_NAME].map(String::from).to_vec()
}

/// One-line reason for a failed `schtasks /Create`, from its exit code and output.
pub fn create_failure(code: i32, output: &str) -> String {
    match output.lines().map(str::trim).find(|l| !l.is_empty()) {
        Some(line) => format!("schtasks /Create failed (exit {code}): {line}"),
        None => format!("schtasks /Create failed (exit {code})"),
    }
}

/// Deleting a task that is not there is fine; the message language varies, so ask `/Query` afterwards instead
/// of reading the error: if the task is gone (query fails) the delete did its job.
pub fn classify_delete(delete_code: i32, query_code_after: Option<i32>) -> Result<(), String> {
    if delete_code == 0 || query_code_after.is_some_and(|c| c != 0) {
        Ok(())
    } else {
        Err(format!(
            "schtasks /Delete failed (exit {delete_code}) and the task is still registered"
        ))
    }
}

/// What `install` does after trying to register the task.
#[derive(Debug, PartialEq)]
pub enum Autostart {
    /// The task is registered: it starts the agent at logon and restarts it; no Run entry.
    Task,
    /// It could not be registered: keep the HKCU Run entry and start the agent directly. Carries the reason.
    RunEntry(String),
}

pub fn plan(task: Result<(), String>) -> Autostart {
    match task {
        Ok(()) => Autostart::Task,
        Err(reason) => Autostart::RunEntry(reason),
    }
}

impl Autostart {
    pub fn keep_run_entry(&self) -> bool {
        matches!(self, Autostart::RunEntry(_))
    }

    /// A task only restarts a process it launched, so start the agent through it when it exists.
    pub fn start_via_task(&self) -> bool {
        matches!(self, Autostart::Task)
    }

    pub fn reason(&self) -> Option<&str> {
        match self {
            Autostart::Task => None,
            Autostart::RunEntry(r) => Some(r),
        }
    }
}

/// The `restart on crash:` line of `status`. `task_present` is a live `schtasks /Query`; `reason` is what
/// `install` saved when registering failed.
pub fn status_line(task_present: bool, reason: Option<&str>) -> String {
    if task_present {
        "restart on crash: yes (scheduled task)".to_string()
    } else {
        let why = reason.unwrap_or("no scheduled task; run `rhen-watch install`");
        format!("restart on crash: no ({why})")
    }
}

/// How a run ended. `loop_end` is the recording loop: `Some(Ok)` a requested stop (CLI `stop`, tray Quit,
/// Ctrl+C or close, logoff, shutdown, `--for`), `Some(Err)` a failure, `None` a panic. The final
/// close-and-write is not an input: a requested stop is honoured even if only that flush failed (the caller
/// logs it) and the exit is still 0, because a non-zero exit would make Task Scheduler restart an agent the user just stopped.
pub fn end_of_run(loop_end: Option<Result<(), String>>) -> Result<(), String> {
    match loop_end {
        Some(Ok(())) => Ok(()),
        Some(Err(e)) => Err(e),
        None => Err("internal error (panic); the open intervals were closed".into()),
    }
}

/// The process exit code: 0 only for success. Task Scheduler restarts on anything else.
pub fn exit_code(result: &Result<(), String>) -> i32 {
    if result.is_ok() { 0 } else { 1 }
}
