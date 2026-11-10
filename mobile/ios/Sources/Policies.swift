import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Pure decisions behind redirect refusal, the send throttle and the re-sign reminder.
/// Foundation only, so `Checks/main.swift` can compile and run them on the runner.
enum Policies {
    // MARK: Redirects

    /// The request to follow after a 3xx. Always nil: the bearer token never follows a redirect.
    static func redirectTarget(_ proposed: URLRequest) -> URLRequest? { nil }

    // MARK: Throttle

    static let minimumReportInterval: TimeInterval = 30

    /// Readings closer together than the minimum interval are skipped.
    static func mayReport(now: Date, lastSent: Date, minimumInterval: TimeInterval = minimumReportInterval) -> Bool {
        now.timeIntervalSince(lastSent) >= minimumInterval
    }

    // MARK: Re-sign reminder

    static let signingLifetime: TimeInterval = 7 * 86_400
    static let reminderLeadTime: TimeInterval = 1 * 86_400
    static let minimumReminderDelay: TimeInterval = 60

    /// The install date: the newer of the stored first-launch date and the bundle's creation date.
    /// A bundle date in the future is ignored; with neither, now.
    static func installDate(stored: Date?, bundle: Date?, now: Date) -> Date {
        let usableBundle = bundle.flatMap { $0 <= now ? $0 : nil }
        return [stored, usableBundle].compactMap { $0 }.max() ?? now
    }

    /// The date the first-launch record should take when none is stored yet.
    static func firstLaunchToRecord(bundle: Date?, now: Date) -> Date {
        bundle.flatMap { $0 <= now ? $0 : nil } ?? now
    }

    /// Seconds until the reminder should fire, or nil when the reminder time has already passed:
    /// it fires once, so a launch after day 6 schedules nothing. A re-sign moves the install date
    /// forward and makes this non-nil again. Never less than a minute away.
    static func reminderDelay(installDate: Date, now: Date) -> TimeInterval? {
        let remaining = installDate.addingTimeInterval(signingLifetime - reminderLeadTime).timeIntervalSince(now)
        guard remaining > 0 else { return nil }
        return max(remaining, minimumReminderDelay)
    }
}
