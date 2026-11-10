import Foundation

/// The words and numbers the Now and Day screens show, worked out from a cached view. Pure, so the screens stay thin
/// and `Checks/main.swift` can check the sentences. All times are shown in the plan's time zone.

struct NowModel: Equatable {
    /// The one line of what to do now.
    let headline: String
    /// Why, in the server's words (reason, project), or nil.
    let why: String?
    /// How long this is meant to take, or what is left of the running session.
    let timeLine: String?
    let leaveByLine: String?
    /// The place card: "You may be at Studio", or nil.
    let placeLine: String?
    /// Stale facts the plan wants to ask about, as their questions.
    let questions: [String]
    /// A sentence the server sent about stretching the session, or about low energy.
    let offers: [String]
    /// Set when the plan's zone is not this phone's zone.
    let zoneNote: String?
}

enum ViewPresentation {
    static func zone(of view: ClientView) -> TimeZone { TimeZone(identifier: view.timezone) ?? TimeZone.current }

    static func now(_ view: ClientView, at now: Date, fetchedAt: Date, phoneZone: TimeZone = TimeZone.current) -> NowModel {
        let zone = zone(of: view)
        let directive = view.now?.directive
        let session = view.pending?.session
        var headline = "Nothing is planned right now"
        var why: String?
        if let session {
            headline = session.title
            why = "Session \(session.status == "paused" ? "paused" : session.status == "feedback" ? "waiting to hear how it went" : "running")"
        } else if let directive {
            headline = directive.title
            var parts: [String] = []
            if let reason = directive.reason, !reason.isEmpty { parts.append(reason) }
            if let project = directive.projectTitle, !project.isEmpty { parts.append(project) }
            if let place = directive.toLocationName, !place.isEmpty, directive.kind == "travel" { parts.append("to \(place)") }
            why = parts.isEmpty ? nil : parts.joined(separator: " - ")
        }
        var timeLine: String?
        if let session {
            timeLine = timeLeft(session, now: now, fetchedAt: fetchedAt)
        } else if let directive, directive.recommendedMinutes > 0 {
            timeLine = "About \(TimeText.minutes(directive.recommendedMinutes))"
        }
        var leaveByLine: String?
        if let leave = view.pending?.leaveBy { leaveByLine = leaveBy(leave, zone: zone) }
        else if let directive, directive.kind == "travel", let text = directive.leaveBy {
            leaveByLine = "Leave by \(TimeText.clock(iso: text, in: zone))"
        }
        var placeLine: String?
        if let suggestion = view.pending?.placeSuggestion {
            placeLine = "You may be at \(suggestion.locationName) (seen \(TimeText.clock(iso: suggestion.observedAt, in: zone)))."
        }
        let questions = (view.now?.needs ?? []).map { $0.question }
        let offers = [view.now?.stretchOffer?.text, view.now?.energyCost?.text].compactMap { $0 }
        var zoneNote: String?
        if zone.identifier != phoneZone.identifier {
            zoneNote = "Times are in the plan's time zone (\(zone.identifier)), not this phone's."
        }
        return NowModel(headline: headline, why: why, timeLine: timeLine, leaveByLine: leaveByLine, placeLine: placeLine,
                        questions: questions, offers: offers, zoneNote: zoneNote)
    }

    /// What is left of a session. A running one counts down to its planned end; a paused or waiting one is frozen at
    /// what the server said.
    static func timeLeft(_ session: ClientSession, now: Date, fetchedAt: Date) -> String {
        if session.status == "feedback" { return "Past its planned end; tell the plan how it went" }
        var left = session.minutesLeft
        if session.status == "running" {
            if let end = ApiDates.parse(session.plannedEndAt) { left = end.timeIntervalSince(now) / 60 }
            else { left = session.minutesLeft - now.timeIntervalSince(fetchedAt) / 60 }
        }
        if left < 0.5 && session.status == "running" { return "At its planned end" }
        let suffix = session.status == "paused" ? " left (paused)" : " left"
        return TimeText.minutes(left) + suffix
    }

    static func leaveBy(_ leave: ClientLeaveBy, zone: TimeZone) -> String {
        let at = TimeText.clock(iso: leave.leaveBy, in: zone)
        let starts = TimeText.clock(iso: leave.occurrenceStartsAt, in: zone)
        var text = leave.phase == "leave"
            ? "Time to leave for \(leave.title): by \(at), to be there for \(starts)"
            : "Leave by \(at) for \(leave.title) at \(starts)"
        text += " (allowing \(TimeText.minutes(leave.allowingMinutes)))"
        if leave.originAssumed { text += ", counted from where the plan assumes you are" }
        return text
    }

    // MARK: Day

    struct DayRow: Equatable {
        let id: String
        let range: String
        let title: String
        let detail: String
        let isProjected: Bool
        let isNow: Bool
        let changedBy: String?
    }

    static func day(_ view: ClientView, at now: Date) -> [DayRow] {
        let zone = zone(of: view)
        return (view.day ?? []).enumerated().map { index, entry in
            let start = ApiDates.parse(entry.startsAt)
            let end = ApiDates.parse(entry.endsAt)
            let running = start.map { $0 <= now } ?? false
            let notOver = end.map { $0 > now } ?? true
            var detail = TimeText.minutes(entry.minutes)
            if entry.confidence == "projected" { detail += " - a projection, not yet decided" }
            return DayRow(id: "\(index)-\(entry.startsAt)",
                          range: "\(TimeText.clock(iso: entry.startsAt, in: zone))-\(TimeText.clock(iso: entry.endsAt, in: zone))",
                          title: entry.title, detail: detail, isProjected: entry.confidence == "projected",
                          isNow: running && notOver,
                          changedBy: entry.changedBy.flatMap { $0.isEmpty ? nil : "Changed by \($0)" })
        }
    }

    // MARK: Check-in

    /// The question the sheet asks.
    static func checkInQuestion(_ checkIn: ClientCheckIn) -> String {
        "Still on \(checkIn.directiveTitle)?"
    }

    /// Where a waiting check-in is not worth interrupting for: one that already went unanswered shows quietly.
    static func checkInNote(_ checkIn: ClientCheckIn, zone: TimeZone) -> String {
        let slot = TimeText.clock(iso: checkIn.slotAt, in: zone)
        return checkIn.status == "unknown" ? "Asked at \(slot); no answer yet." : "Asked at \(slot)."
    }
}
