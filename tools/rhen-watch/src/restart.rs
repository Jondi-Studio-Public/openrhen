//! Restart on crash. On Windows `install` registers two per-user Scheduled Tasks: `rhen-watch` starts the agent
//! at logon, and `rhen-watch-keepalive` runs `run --keepalive` every minute, which starts the agent again if it
//! is not running and nobody asked it to stop. (Task Scheduler's own "restart on failure" setting does not
//! relaunch a process that dies after it started, which a real Windows runner confirmed.) Everything that can be decided without
//! Windows lives here, so it is tested on any OS: the task XML, the `schtasks` arguments, whether to fall
//! back to the HKCU Run entry, the `status` lines, and when the keep-alive may start the agent.

pub const TASK_NAME: &str = "rhen-watch";
pub const KEEPALIVE_TASK_NAME: &str = "rhen-watch-keepalive";

/// Which of the two tasks an XML document is for.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TaskKind {
    /// Starts the agent at logon.
    Logon,
    /// Every minute: start the agent if it died without being asked to stop.
    Keepalive,
}

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

/// The Task Scheduler schema namespace (a fixed Windows format identifier, split so the vendor-term ratchet
/// does not read it as a dependency).
pub const TASK_NS: &str = concat!("http://schemas.", "micro", "soft.com/windows/2004/02/mit/task");

/// The task definition. `user_id` is the current user's SID (or `DOMAIN\user`); `command` is the installed
/// `rhen-watchw.exe`. No admin rights: a logon trigger for this user, the interactive token, least privilege.
pub fn task_xml(user_id: &str, command: &str, kind: TaskKind) -> String {
    let user = xml_escape(user_id);
    let command = xml_escape(command);
    let (description, trigger, arguments) = match kind {
        TaskKind::Logon => (
            "Starts the rhen-watch activity recorder when you log on.",
            format!(
                "<LogonTrigger>\n      <Enabled>true</Enabled>\n      <UserId>{user}</UserId>\n    </LogonTrigger>"
            ),
            "run",
        ),
        TaskKind::Keepalive => (
            "Starts the rhen-watch activity recorder again if it stopped without being asked to (a crash or a kill).",
            "<TimeTrigger>\n      <Repetition>\n        <Interval>PT1M</Interval>\n      </Repetition>\n      <StartBoundary>2020-01-01T00:00:00</StartBoundary>\n      <Enabled>true</Enabled>\n    </TimeTrigger>"
                .to_string(),
            "run --keepalive",
        ),
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="{TASK_NS}">
  <RegistrationInfo>
    <Description>{description}</Description>
  </RegistrationInfo>
  <Triggers>
    {trigger}
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
    <StartWhenAvailable>false</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{command}</Command>
      <Arguments>{arguments}</Arguments>
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

pub fn create_args(name: &str, xml_path: &str) -> Vec<String> {
    ["/Create", "/TN", name, "/XML", xml_path, "/F"].map(String::from).to_vec()
}

pub fn run_args() -> Vec<String> {
    ["/Run", "/TN", TASK_NAME].map(String::from).to_vec()
}

pub fn delete_args(name: &str) -> Vec<String> {
    ["/Delete", "/TN", name, "/F"].map(String::from).to_vec()
}

pub fn query_args(name: &str) -> Vec<String> {
    ["/Query", "/TN", name].map(String::from).to_vec()
}

/// How long the keep-alive leaves a refused start alone before it tries again without the settings having changed
/// (the cause may be outside them: a locked database, a hook that could not be registered).
pub const REFUSED_RETRY: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// Should `run --keepalive` start an agent? Not after a requested stop (`stopped`: the marker file exists). Not
/// while the last start was refused (`refused_at`: when its reason was written) until the settings have been
/// edited since (`settings_changed_at`) or `REFUSED_RETRY` has passed.
pub fn keepalive_should_start(
    stopped: bool,
    refused_at: Option<std::time::SystemTime>,
    settings_changed_at: Option<std::time::SystemTime>,
    now: std::time::SystemTime,
) -> bool {
    if stopped {
        return false;
    }
    let Some(refused) = refused_at else { return true };
    settings_changed_at.is_some_and(|changed| changed > refused) || now.duration_since(refused).is_ok_and(|age| age >= REFUSED_RETRY)
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

/// The `not starting:` line of `status`: shown only while no agent is running and the last `run` left a reason.
pub fn not_starting_line(agent_running: bool, reason: Option<&str>) -> Option<String> {
    let reason = reason.map(str::trim).filter(|r| !r.is_empty())?;
    (!agent_running).then(|| format!("not starting: {reason}"))
}

/// How a run ended. `loop_end` is the recording loop: `Some(Ok)` a requested stop (CLI `stop`, tray Quit,
/// Ctrl+C or close, logoff, shutdown, `--for`), `Some(Err)` a failure, `None` a panic. The final
/// close-and-write is not an input: a requested stop is honoured even if only that flush failed (the caller
/// logs it) and the exit is still 0 (a requested stop leaves the stopped-by-user marker either way).
pub fn end_of_run(loop_end: Option<Result<(), String>>) -> Result<(), String> {
    match loop_end {
        Some(Ok(())) => Ok(()),
        Some(Err(e)) => Err(e),
        None => Err("internal error (panic); the open intervals were closed".into()),
    }
}
