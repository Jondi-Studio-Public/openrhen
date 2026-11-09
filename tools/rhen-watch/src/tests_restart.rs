//! Restart on crash: the Scheduled Task XML, the fallback decision, the status line and the exit codes that
//! decide whether Task Scheduler restarts the agent. All pure, so they run on any OS.

use crate::restart::*;

const SID: &str = "S-1-5-21-1-2-3-1001";
const EXE: &str = r"C:\Users\Ann\AppData\Local\Programs\rhen-watch\rhen-watchw.exe";

#[test]
fn task_xml_golden() {
    let want = format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="{TASK_NS}">
  <RegistrationInfo>
    <Description>Starts the rhen-watch activity recorder when you log on.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>S-1-5-21-1-2-3-1001</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-21-1-2-3-1001</UserId>
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
      <Command>C:\Users\Ann\AppData\Local\Programs\rhen-watch\rhen-watchw.exe</Command>
      <Arguments>run</Arguments>
    </Exec>
  </Actions>
</Task>
"#
    );
    assert_eq!(task_xml(SID, EXE, TaskKind::Logon), want);
}

#[test]
fn task_xml_escapes_user_and_path() {
    let xml = task_xml(r"DOM<&>\o'brien", r#"C:\A&B\"x" <y>\rhen-watchw.exe"#, TaskKind::Logon);
    assert!(xml.contains(r"<UserId>DOM&lt;&amp;&gt;\o&apos;brien</UserId>"));
    assert!(xml.contains(r"<Command>C:\A&amp;B\&quot;x&quot; &lt;y&gt;\rhen-watchw.exe</Command>"));
    assert!(!xml.contains("<y>"));
}

#[test]
fn task_file_is_utf16le_with_a_bom() {
    let b = task_file_bytes("<a>é</a>");
    assert_eq!(&b[..2], &[0xFF, 0xFE]);
    let units: Vec<u16> = b[2..].chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    assert_eq!(String::from_utf16(&units).unwrap(), "<a>é</a>");
}

#[test]
fn schtasks_arguments() {
    assert_eq!(
        create_args("rhen-watch-keepalive", r"C:\t\x.xml"),
        ["/Create", "/TN", "rhen-watch-keepalive", "/XML", r"C:\t\x.xml", "/F"]
    );
    assert_eq!(run_args(), ["/Run", "/TN", "rhen-watch"]);
    assert_eq!(delete_args(TASK_NAME), ["/Delete", "/TN", "rhen-watch", "/F"]);
    assert_eq!(query_args(KEEPALIVE_TASK_NAME), ["/Query", "/TN", "rhen-watch-keepalive"]);
}

#[test]
fn create_failure_names_the_exit_code_and_the_first_line() {
    let r = create_failure(1, "\r\nERROR: Access is denied.\r\nmore\r\n");
    assert_eq!(r, "schtasks /Create failed (exit 1): ERROR: Access is denied.");
    assert_eq!(create_failure(2, "  \n"), "schtasks /Create failed (exit 2)");
}

#[test]
fn a_registered_task_replaces_the_run_entry_and_starts_through_the_task() {
    let p = plan(Ok(()));
    assert!(!p.keep_run_entry());
    assert!(p.start_via_task());
    assert_eq!(p.reason(), None);
}

#[test]
fn a_failed_task_keeps_the_run_entry_and_starts_directly() {
    let p = plan(Err("schtasks missing".into()));
    assert!(p.keep_run_entry());
    assert!(!p.start_via_task());
    assert_eq!(p.reason(), Some("schtasks missing"));
}

#[test]
fn status_line_says_yes_or_no_with_a_reason() {
    assert_eq!(status_line(true, None), "restart on crash: yes (scheduled task)");
    assert_eq!(status_line(true, Some("old reason")), "restart on crash: yes (scheduled task)");
    assert_eq!(
        status_line(false, Some("schtasks /Create failed (exit 1): ERROR: Access is denied.")),
        "restart on crash: no (schtasks /Create failed (exit 1): ERROR: Access is denied.)"
    );
    assert_eq!(
        status_line(false, None),
        "restart on crash: no (no scheduled task; run `rhen-watch install`)"
    );
}

#[test]
fn deleting_a_task_that_is_not_there_is_fine() {
    assert!(classify_delete(0, None).is_ok());
    assert!(
        classify_delete(1, Some(1)).is_ok(),
        "gone afterwards, whatever the message language"
    );
    assert!(classify_delete(1, Some(0)).is_err(), "still registered: report it");
}

#[test]
fn a_requested_stop_exits_zero() {
    assert_eq!(exit_code(&end_of_run(Some(Ok(())))), 0);
}

#[test]
fn a_crash_or_panic_exits_non_zero() {
    assert_eq!(exit_code(&end_of_run(Some(Err("the hook thread ended".into())))), 1);
    assert_eq!(exit_code(&end_of_run(None)), 1);
}

#[test]
fn not_starting_line_shows_only_for_a_stopped_agent_with_a_reason() {
    assert_eq!(
        not_starting_line(false, Some("bad config\n")).as_deref(),
        Some("not starting: bad config")
    );
    assert_eq!(not_starting_line(true, Some("stale")), None);
    assert_eq!(not_starting_line(false, None), None);
    assert_eq!(not_starting_line(false, Some("  ")), None);
}

#[test]
fn keepalive_xml_repeats_every_minute_runs_the_keepalive_and_has_no_failure_restart() {
    let xml = task_xml(SID, EXE, TaskKind::Keepalive);
    assert!(xml.contains("<Interval>PT1M</Interval>"));
    assert!(xml.contains("<TimeTrigger>"));
    assert!(!xml.contains("<LogonTrigger>"));
    assert!(xml.contains("<Arguments>run --keepalive</Arguments>"));
    assert!(xml.contains("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"));
    assert!(xml.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
    assert!(!xml.contains("RestartOnFailure"));
    assert!(task_xml(SID, EXE, TaskKind::Logon).contains("<Arguments>run</Arguments>"));
}

#[test]
fn keepalive_starts_unless_stopped_or_refused_until_the_settings_change() {
    use std::time::{Duration, SystemTime};
    let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(1000);
    let later = t0 + Duration::from_secs(60);
    assert!(keepalive_should_start(false, None, None), "died: bring it back");
    assert!(keepalive_should_start(false, None, Some(t0)));
    assert!(!keepalive_should_start(true, None, None), "stopped on request");
    assert!(!keepalive_should_start(true, Some(t0), Some(later)), "a stop beats an edit");
    assert!(!keepalive_should_start(false, Some(t0), None), "refused, nothing to edit");
    assert!(!keepalive_should_start(false, Some(t0), Some(t0)), "refused, not edited since");
    assert!(keepalive_should_start(false, Some(t0), Some(later)), "edited since: try again");
}
