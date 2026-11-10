import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The commands the live screens send, as pure values and pure request building. Everything goes through the
/// ordinary command routes (`/api/commands/session`, `/activity`, `/check-in`); the only extra field is
/// `occurredAt`, the time the person really did it (docs/design/real-times-for-owner-commands.md).

/// A scalar in a queued command's fields.
enum JSONValue: Codable, Equatable {
    case string(String)
    case int(Int)
    case bool(Bool)
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null; return }
        if let value = try? container.decode(Bool.self) { self = .bool(value); return }
        if let value = try? container.decode(Int.self) { self = .int(value); return }
        self = .string(try container.decode(String.self))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .int(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    var foundationValue: Any {
        switch self {
        case .string(let value): return value
        case .int(let value): return value
        case .bool(let value): return value
        case .null: return NSNull()
        }
    }
}

enum CommandKind: String, Codable {
    case checkIn
    case session
    case activity

    var path: String {
        switch self {
        case .checkIn: return "/api/commands/check-in"
        case .session: return "/api/commands/session"
        case .activity: return "/api/commands/activity"
        }
    }
}

/// One command waiting in the outbox.
struct OutboxCommand: Codable, Equatable, Identifiable {
    var id: String { commandId }
    /// Kept across retries, so a replay is answered from the server's receipt.
    let commandId: String
    /// When the person did it: sent as `occurredAt`.
    let madeAt: Date
    let kind: CommandKind
    let type: String
    /// Words for lists: "Pause Write section 2".
    let label: String
    /// What the command acts on: `session:<id>`, `action:<id>` (a start, until its reply names the session) or
    /// `check-in:<id>`. Commands on one entity stay in order and are held together.
    var entityKey: String
    /// The session a session or activity command acts on; nil while its start is still queued.
    var sessionId: String?
    let fields: [String: JSONValue]
    /// The version the server must still hold. Nil on a check-in means "any" (offline answers); nil on a session
    /// command means "look it up when sending".
    var expectedVersion: Int?
    /// What the person saw the session doing (`running`, `paused`, `feedback`) when they made the command.
    let seenStatus: String?
    var attempts: Int
    var nextAttemptAt: Date?
    /// Why the server refused it, in words. A held command waits for the person: Try again or Drop.
    var hold: String?

    var needsVersionLookup: Bool { kind != .checkIn && expectedVersion == nil }
}

/// How the person answers a check-in. The status is always the owner's own yes / no / not sure.
enum CheckInChoice: String, Equatable {
    case yes
    case no
    case notSure

    var status: String {
        switch self {
        case .yes: return "on_track"
        case .no: return "deviated"
        case .notSure: return "unknown"
        }
    }

    var label: String {
        switch self {
        case .yes: return "Yes, on it"
        case .no: return "No, I'm doing something else"
        case .notSure: return "Not sure"
        }
    }
}

/// What a session command acts on.
enum SessionTarget: Equatable {
    /// A session the view names.
    case known(sessionId: String, isActionSession: Bool)
    /// A session whose start is still queued here.
    case pendingStart(actionId: String)
}

enum CommandBuilders {
    static let maxWords = 8000
    static let maxPlannedMinutes = 1440

    static func newId() -> String { UUID().uuidString.lowercased() }

    /// The words on a check-in answer: trimmed, nil when empty. `tooLong` when over the server's cap (never cut).
    static func cleanWords(_ text: String) -> (words: String?, tooLong: Bool) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return (nil, false) }
        return (trimmed, trimmed.count > maxWords)
    }

    /// `expectedVersion` is the check-in's version when the person answered against a current view, and nil
    /// (any version) when answering offline or from an old view.
    static func answerCheckIn(checkInId: String, title: String, choice: CheckInChoice, words: String?, expectedVersion: Int?,
                              at: Date, id: String = newId()) -> OutboxCommand {
        var fields: [String: JSONValue] = [
            "checkInId": .string(checkInId), "status": .string(choice.status), "answerSource": .string("app"),
        ]
        if let words, !words.isEmpty { fields["deviationNote"] = .string(words) }
        return OutboxCommand(commandId: id, madeAt: at, kind: .checkIn, type: "answer_check_in",
                             label: "Answer \"\(title)\"", entityKey: "check-in:\(checkInId)", sessionId: nil, fields: fields,
                             expectedVersion: expectedVersion, seenStatus: nil, attempts: 0, nextAttemptAt: nil, hold: nil)
    }

    static func startSession(actionId: String, title: String, minutes: Double, at: Date, id: String = newId()) -> OutboxCommand {
        let planned = min(max(Int(minutes.rounded()), 1), maxPlannedMinutes)
        return OutboxCommand(commandId: id, madeAt: at, kind: .session, type: "start", label: "Start \(title)",
                             entityKey: "action:\(actionId)", sessionId: nil,
                             fields: ["actionId": .string(actionId), "plannedMinutes": .int(planned)],
                             expectedVersion: nil, seenStatus: nil, attempts: 0, nextAttemptAt: nil, hold: nil)
    }

    enum SessionVerb: Equatable {
        case pause
        case resume
        /// `completed`: the person said it is done.
        case done
        /// Stopped part way, with how many minutes are left (0 or more) and his words.
        case stopWithRemaining(minutes: Int, words: String)
        /// Stopped part way and the minutes could not be read from his words: his words stand, no minutes.
        case stopUnsure(words: String)
    }

    static func sessionCommand(_ verb: SessionVerb, target: SessionTarget, title: String, seenStatus: String,
                               at: Date, id: String = newId()) -> OutboxCommand {
        let isAction: Bool
        let sessionId: String?
        let key: String
        switch target {
        case .known(let known, let action):
            isAction = action; sessionId = known; key = "session:\(known)"
        case .pendingStart(let actionId):
            isAction = true; sessionId = nil; key = "action:\(actionId)"
        }
        var fields: [String: JSONValue] = [:]
        let type: String
        let verbText: String
        switch verb {
        case .pause:
            type = isAction ? "pause" : "pause_activity"; verbText = "Pause"
        case .resume:
            type = isAction ? "resume" : "resume_activity"; verbText = "Resume"
        case .done:
            type = isAction ? "finish" : "finish_activity"; verbText = "Finish"
            fields["outcome"] = .string("completed")
        case .stopWithRemaining(let minutes, let words):
            type = isAction ? "finish" : "finish_activity"; verbText = "Stop"
            if isAction {
                fields["outcome"] = .string("progress")
                fields["remainingMinutes"] = .int(max(minutes, 0))
            } else {
                fields["outcome"] = .string("stopped")
            }
            if !words.isEmpty { fields["note"] = .string(String(words.prefix(2000))) }
        case .stopUnsure(let words):
            type = isAction ? "finish" : "finish_activity"; verbText = "Stop"
            fields["outcome"] = .string(isAction ? "unsure" : "stopped")
            if !words.isEmpty { fields["note"] = .string(String(words.prefix(2000))) }
        }
        return OutboxCommand(commandId: id, madeAt: at, kind: isAction ? .session : .activity, type: type,
                             label: "\(verbText) \(title)", entityKey: key, sessionId: sessionId, fields: fields,
                             expectedVersion: nil, seenStatus: seenStatus, attempts: 0, nextAttemptAt: nil, hold: nil)
    }
}

/// Request building for a queued command.
enum CommandRequests {
    /// `occurredAt` with the phone's offset (`Z` for zero), as the C4 rules ask.
    static func occurredAtString(_ date: Date, timeZone: TimeZone = TimeZone.current) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = timeZone
        return formatter.string(from: date)
    }

    static func body(_ command: OutboxCommand, timeZone: TimeZone = TimeZone.current) -> [String: Any] {
        var body: [String: Any] = [:]
        for (name, value) in command.fields { body[name] = value.foundationValue }
        body["commandId"] = command.commandId
        body["type"] = command.type
        if let version = command.expectedVersion { body["expectedVersion"] = version } else { body["expectedVersion"] = NSNull() }
        body["occurredAt"] = occurredAtString(command.madeAt, timeZone: timeZone)
        if let sessionId = command.sessionId { body["sessionId"] = sessionId }
        return body
    }

    static func request(_ command: OutboxCommand, origin: String, token: String, timeZone: TimeZone = TimeZone.current) -> URLRequest? {
        ApiRequests.post(origin: origin, path: command.kind.path, token: token, body: body(command, timeZone: timeZone))
    }
}

/// What the server said about the time it used (`occurredAt` in a command's reply).
struct OccurredAtReport: Codable, Equatable {
    let claimedAt: String
    let applied: Bool
    let appliedAt: String
    let reason: String?
    let message: String
    /// False when the target had closed and the words were kept elsewhere.
    let delivered: Bool?
}

/// A successful command's reply, reduced to what the outbox needs.
struct CommandReply: Equatable {
    let report: OccurredAtReport?
    /// The open session after the command, if any.
    let sessionId: String?
    let sessionVersion: Int?
    let sessionStatus: String?
}

/// What came of sending one command.
enum SendResult: Equatable {
    case applied(CommandReply)
    /// Network error, 408, 429 or 5xx: keep it and try again later.
    case retry(afterSeconds: Int?)
    /// Refused (409 or another 4xx): it waits for the person, in words.
    case held(message: String)
    /// 401: the phone was removed from the portal.
    case revoked
}

enum CommandResults {
    private struct Raw: Decodable {
        struct State: Decodable {
            struct Active: Decodable {
                let id: String?
                let version: Int?
                let status: String?
            }
            let activeSession: Active?
        }
        let state: State?
        let occurredAt: OccurredAtReport?
    }

    static func parseReply(_ body: Data) -> CommandReply {
        guard let raw = try? JSONDecoder().decode(Raw.self, from: body) else {
            return CommandReply(report: nil, sessionId: nil, sessionVersion: nil, sessionStatus: nil)
        }
        let active = raw.state?.activeSession
        return CommandReply(report: raw.occurredAt, sessionId: active?.id, sessionVersion: active?.version, sessionStatus: active?.status)
    }

    static func interpret(_ answer: HTTPAnswer?) -> SendResult {
        guard let answer else { return .retry(afterSeconds: nil) }
        if (200..<300).contains(answer.status) { return .applied(parseReply(answer.body)) }
        if answer.status == 401 { return .revoked }
        if answer.status == 408 || answer.status == 429 || answer.status >= 500 { return .retry(afterSeconds: answer.retryAfter) }
        let error = ApiResponses.failure(for: answer, signed: true)
        let message = error?.message ?? "The server refused it (status \(answer.status))."
        return .held(message: message)
    }
}

/// The few facts of `GET /api/state` a command needs: which session is open and its version, and the version of the
/// action a start names. (The client view carries neither; see the notes in the README.)
struct StateProbe: Decodable, Equatable {
    struct Active: Decodable, Equatable {
        let id: String
        let version: Int?
        let status: String?
        let actionId: String?
    }
    struct Item: Decodable, Equatable {
        let id: String
        let version: Int?
        let actionId: String?
    }
    private struct Wrapper: Decodable { let state: StateProbe }

    let activeSession: Active?
    let actions: [Item]?
    let occurrences: [Item]?

    static func decode(_ body: Data) -> StateProbe? { (try? JSONDecoder().decode(Wrapper.self, from: body))?.state }

    /// The version a start of `actionId` must name: the action's, or for an occurrence id the version of its action.
    func actionVersion(forStartOf actionId: String) -> Int? {
        let owner = occurrences?.first(where: { $0.id == actionId })?.actionId ?? actionId
        return actions?.first(where: { $0.id == owner })?.version
    }
}

/// Fills in the version a command must carry from what the server holds now, or says in words why it can no longer
/// be sent as the person made it.
enum VersionResolution: Equatable {
    case send(expectedVersion: Int, sessionId: String?)
    case conflict(String)

    static func resolve(_ command: OutboxCommand, probe: StateProbe) -> VersionResolution {
        if command.type == "start" {
            if let active = probe.activeSession {
                return .conflict("\(command.label) wasn't sent: another session is already open (\(active.status ?? "running")). Finish it first.")
            }
            guard case .string(let actionId)? = command.fields["actionId"], let version = probe.actionVersion(forStartOf: actionId) else {
                return .conflict("\(command.label) wasn't sent: the plan no longer has that task.")
            }
            return .send(expectedVersion: version, sessionId: nil)
        }
        guard let active = probe.activeSession else {
            return .conflict("\(command.label) wasn't sent: no session is open now.")
        }
        if let wanted = command.sessionId, wanted != active.id {
            return .conflict("\(command.label) wasn't sent: that session is no longer the open one.")
        }
        if let seen = command.seenStatus, let now = active.status, seen != now {
            return .conflict("\(command.label) wasn't applied: the session is now \(SessionWords.status(now)), not \(SessionWords.status(seen)) as you left it.")
        }
        guard let version = active.version else {
            return .conflict("\(command.label) wasn't sent: the server didn't say which version of the session to change.")
        }
        return .send(expectedVersion: version, sessionId: active.id)
    }
}

enum SessionWords {
    static func status(_ raw: String) -> String {
        switch raw {
        case "running": return "running"
        case "paused": return "paused"
        case "feedback", "awaiting_feedback": return "waiting to hear how it went"
        default: return raw
        }
    }
}
