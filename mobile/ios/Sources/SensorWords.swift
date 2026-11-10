import Foundation

/// The words of the sensor part of the Sources screen. Foundation only. Each line says what is happening and why, and
/// never claims what the phone cannot know.
enum SensorWords {
    /// "Heart rate for 10:00 UTC" style label for a row, used when a row is set aside.
    static func rowLabel(_ event: SensorEvent) -> String {
        let name: String
        switch event.kind {
        case "steps": name = "Steps"
        case "heart_rate": name = "Heart rate"
        case "hrv": name = "Heart-rate variability"
        case "sleep": name = "Sleep"
        case "heartbeat": name = "Alive signal"
        default: name = event.kind
        }
        if event.kind == "heartbeat" { return name }
        if case .string(let date)? = event.attrs["local_date"] { return "\(name) for \(date)" }
        return "\(name) for \(ApiDates.string(event.start).prefix(13)):00 UTC"
    }

    struct QueueSummary: Equatable {
        let headline: String
        let warning: String?
    }

    /// How much sensor data is waiting, with a warning once something has waited a day and then a week (design section 9.5).
    static func queue(_ state: SensorState, now: Date) -> QueueSummary {
        let waiting = state.count
        var headline = waiting == 0 ? "No sensor data is waiting to be sent." : "\(waiting) sensor row\(waiting == 1 ? "" : "s") waiting to be sent."
        if state.notBefore != nil, let note = state.lastNote, waiting > 0 { headline += " " + note }
        guard let oldest = state.oldestQueuedAt else { return QueueSummary(headline: headline, warning: nil) }
        let age = now.timeIntervalSince(oldest)
        if age >= 7 * 86_400 {
            return QueueSummary(headline: headline, warning: "Something has been waiting for a week or more. Check your server can be reached; removing the app loses it.")
        }
        if age >= 86_400 {
            return QueueSummary(headline: headline, warning: "Something has been waiting for over a day. Removing the app now would lose it.")
        }
        return QueueSummary(headline: headline, warning: nil)
    }

    /// `45 minutes`, `3 hours`, `2 days`.
    static func span(_ seconds: TimeInterval) -> String {
        let minutes = Int((seconds / 60).rounded())
        if minutes < 90 { return "\(max(minutes, 1)) minute\(minutes <= 1 ? "" : "s")" }
        let hours = Int((seconds / 3600).rounded())
        if hours < 48 { return "\(hours) hours" }
        return "\(Int((seconds / 86_400).rounded())) days"
    }

    /// One line per kind of wake, from what the phone measured. Empty before iOS has woken the app in the background.
    static func wakes(_ log: WakeLog, zone: TimeZone) -> [String] {
        [WakeKind.location, WakeKind.health].compactMap { kind in
            guard let summary = log.summary(kind) else { return nil }
            var line = "\(kind.title) woke the app in the background \(summary.wakes) time\(summary.wakes == 1 ? "" : "s"), last at \(TimeText.clock(summary.last, in: zone))."
            if let median = summary.medianGap, let longest = summary.longestGap {
                line += " Usually \(span(median)) apart; the longest gap was \(span(longest))."
            }
            return line
        }
    }

    static let noWakesYet = "iOS has not woken the app in the background yet. How often it does is iOS's choice; the app records each wake here so the intervals are measured, not guessed."

    /// The portal has no route yet that says when it last heard from the phone, so the Sources screen says so rather than guess.
    static let serverSide = "Your server does not yet tell this phone when it last heard from it, so the times here are only what this phone knows. Rows it refuses are listed below."

    static let setAsideNote = "Your server refused these rows and gave the reason. They are not sent again unless the data changes."

    static func setAsideLine(_ row: SetAsideRow, zone: TimeZone) -> String {
        let times = row.count > 1 ? " (\(row.count) times, last at \(TimeText.clock(row.lastAt, in: zone)))" : " (at \(TimeText.clock(row.lastAt, in: zone)))"
        return "\(row.label)\(times)"
    }

    // MARK: Health

    static let healthBackgroundRefused = "iOS did not allow Health to wake the app for new data (free signing may not allow it). Health is read when the app opens and when a place change wakes it."
    static let healthNotAvailable = "Health data is not available on this device."
    static let healthOff = "Sending Health data is turned off in Settings."
    static let healthReadFailed = "Health could not be read just now (the phone may be locked). The app will try again."
    static let healthNoAnswerNote = "iOS never tells an app whether reading Health was allowed. If nothing arrives, check Settings > Health > Data Access & Devices > OpenRhen."

    static func healthRead(at date: Date, queued: Int, zone: TimeZone) -> String {
        let rows = queued == 0 ? "nothing new to send" : "\(queued) new row\(queued == 1 ? "" : "s") to send"
        return "Read Health at \(TimeText.clock(date, in: zone)): \(rows)."
    }
}
