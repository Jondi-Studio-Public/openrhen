import Foundation

/// What the session controls offer, given the cached view and what is still queued. Pure.
enum SessionAction: Equatable, Hashable {
    case start(actionId: String, title: String, minutes: Double)
    case pause
    case resume
    case done
    case stopForNow
}

struct SessionControls: Equatable {
    /// `running`, `paused` or `feedback` once queued commands are counted; nil when no session is open.
    let status: String?
    let target: SessionTarget?
    let title: String
    let actions: [SessionAction]
    /// Set when the server refused a command on this session: it waits for the person on the Sources screen.
    let blockedNote: String?
    /// Set when a command is queued but not sent yet.
    let pendingNote: String?

    static func make(view: ClientView?, outbox: CommandOutbox) -> SessionControls {
        let base = view?.pending?.session
        var keys = Set<String>()
        var status = base?.status
        var target: SessionTarget?
        var title = base?.title ?? ""
        if let base {
            keys.insert("session:\(base.id)")
            target = .known(sessionId: base.id, isActionSession: base.isActionSession)
        }
        // A start still queued here: its commands are keyed by the action until the server names the session.
        var directiveStart: (id: String, title: String, minutes: Double)?
        if base == nil, let directive = view?.now?.directive, directive.kind == "action", let id = directive.targetId, !id.isEmpty {
            directiveStart = (id, directive.title, directive.recommendedMinutes)
            keys.insert("action:\(id)")
        }
        for command in outbox.items where command.type == "start" && base == nil {
            keys.insert(command.entityKey)
        }
        var queuedCount = 0
        var blocked: String?
        for command in outbox.items(forEntityKeys: keys) {
            if let hold = command.hold { blocked = hold; break }
            queuedCount += 1
            switch command.type {
            case "start":
                status = "running"
                if case .string(let id)? = command.fields["actionId"] { target = .pendingStart(actionId: id) }
                title = command.label.hasPrefix("Start ") ? String(command.label.dropFirst(6)) : command.label
            case "pause", "pause_activity": status = "paused"
            case "resume", "resume_activity", "continue": status = "running"
            case "request_feedback": status = "feedback"
            case "finish", "finish_activity", "did_not_start", "block": status = nil; target = nil
            default: break
            }
        }
        var actions: [SessionAction] = []
        if blocked == nil {
            switch status {
            case "running"?: actions = [.pause, .done, .stopForNow]
            case "paused"?: actions = [.resume, .done, .stopForNow]
            case "feedback"?: actions = [.done, .stopForNow]
            default:
                if let start = directiveStart { actions = [.start(actionId: start.id, title: start.title, minutes: start.minutes)] }
            }
        }
        let pending = queuedCount > 0 ? "\(queuedCount) change\(queuedCount == 1 ? "" : "s") not sent yet; they go out in the order you made them." : nil
        return SessionControls(status: status, target: target, title: title, actions: actions, blockedNote: blocked, pendingNote: pending)
    }
}

/// Reads "how much is left" from his words, only where the words say it. It never guesses: no unit, no number, no
/// answer. A bare number is read as minutes only when the person was just asked for minutes (the second ask).
enum RemainingParser {
    static func minutes(from text: String, bareNumberIsMinutes: Bool = false) -> Int? {
        let lower = text.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        if lower.isEmpty { return nil }
        var total = 0.0
        var found = false
        if lower.contains("quarter of an hour") || lower.contains("quarter hour") { total += 15; found = true }
        else if lower.contains("half an hour") || lower.contains("half hour") { total += 30; found = true }
        else if lower.contains("an hour") || lower.contains("one hour") { total += 60; found = true }
        let extra = lower.contains("hour and a half") ? 30.0 : 0.0
        let scalars = Array(lower)
        var index = 0
        while index < scalars.count {
            if scalars[index].isNumber {
                var end = index
                var number = ""
                while end < scalars.count, scalars[end].isNumber || (scalars[end] == "." && end + 1 < scalars.count && scalars[end + 1].isNumber) {
                    number.append(scalars[end]); end += 1
                }
                while end < scalars.count, scalars[end] == " " { end += 1 }
                var unit = ""
                var cursor = end
                while cursor < scalars.count, scalars[cursor].isLetter { unit.append(scalars[cursor]); cursor += 1 }
                if let value = Double(number) {
                    if ["h", "hr", "hrs", "hour", "hours"].contains(unit) { total += value * 60; found = true }
                    else if ["m", "min", "mins", "minute", "minutes"].contains(unit) { total += value; found = true }
                }
                index = max(cursor, end, index + 1)
            } else {
                index += 1
            }
        }
        if found { return Int((total + extra).rounded()) }
        if bareNumberIsMinutes, let value = Int(lower) { return value }
        // Only when the whole text says it: "nothing", not "I did nothing" or "finished the intro".
        let nothing = ["nothing", "none", "nothing left", "none left", "all done", "finished", "zero"]
        if nothing.contains(lower) { return 0 }
        return nil
    }
}

/// "Stop for now" asks in words how much is left. If the minutes can't be read from the words the app asks once
/// more; if they still can't, the words are sent as they are with no minutes (outcome `unsure`), never a guess.
struct StopForNowFlow: Equatable {
    enum Phase: Equatable { case askingFirst, askingAgain }
    enum Outcome: Equatable {
        case askAgain
        case send(SessionRemaining)
    }
    enum SessionRemaining: Equatable {
        case minutes(Int, words: String)
        case unsure(words: String)
    }

    private(set) var phase: Phase = .askingFirst
    private var firstWords = ""

    var prompt: String {
        switch phase {
        case .askingFirst: return "How much is left? Say it in your own words, like \"about 20 minutes\"."
        case .askingAgain: return "I couldn't read a number of minutes from that. How many minutes are left? Or leave it and send your words as they are."
        }
    }

    mutating func submit(_ text: String) -> Outcome {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        switch phase {
        case .askingFirst:
            if let minutes = RemainingParser.minutes(from: words) { return .send(.minutes(minutes, words: words)) }
            phase = .askingAgain
            firstWords = words
            return .askAgain
        case .askingAgain:
            if let minutes = RemainingParser.minutes(from: words, bareNumberIsMinutes: true) {
                return .send(.minutes(minutes, words: [firstWords, words].filter { !$0.isEmpty }.joined(separator: " - ")))
            }
            return .send(.unsure(words: [firstWords, words].filter { !$0.isEmpty }.joined(separator: " - ")))
        }
    }

    /// The person chose to send what they said without minutes.
    mutating func sendWordsOnly() -> Outcome {
        .send(.unsure(words: firstWords))
    }
}
