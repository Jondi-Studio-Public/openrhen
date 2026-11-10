import Foundation

/// What became of a command, kept so the screens can say it in words.
struct CommandOutcome: Codable, Equatable, Identifiable {
    enum Kind: String, Codable {
        /// Applied at the time the person did it.
        case applied
        /// Applied, but at the time the server received it, with the reason in the message.
        case atReceipt
        /// An answer to a check-in that had closed: his words were kept as a note, nothing else changed.
        case notDelivered
        /// Refused by the server: waiting for the person.
        case held
        /// The person dropped it.
        case dropped
    }

    var id: String
    let at: Date
    let kind: Kind
    let label: String
    let message: String
}

/// The ordered on-device queue of commands. One at a time, in the order they were made, across all entities. A
/// command the server refused is held and holds every later command on the same entity with it; commands on other
/// entities keep going. A network failure or a 5xx stops everything and retries later with backoff, so the order is
/// never broken. Pure value type; `CommandRunner` sends and `PrivateJSONFile` keeps it on disk.
struct CommandOutbox: Codable, Equatable {
    static let maxOutcomes = 30
    static let baseBackoff: TimeInterval = 5
    static let maxBackoff: TimeInterval = 300

    private(set) var items: [OutboxCommand] = []
    private(set) var outcomes: [CommandOutcome] = []

    init() {}

    var isEmpty: Bool { items.isEmpty }
    var count: Int { items.count }

    mutating func enqueue(_ command: OutboxCommand) { items.append(command) }

    static func backoff(attempts: Int) -> TimeInterval {
        min(baseBackoff * pow(2, Double(max(attempts - 1, 0))), maxBackoff)
    }

    enum Pick: Equatable {
        case nothing
        /// Send this one now.
        case send(OutboxCommand)
        /// The next command is backing off; look again at this time.
        case wait(until: Date)
    }

    /// The command to send next. Held commands, and later ones on their entity, are skipped.
    func next(now: Date) -> Pick {
        var blocked = Set<String>()
        for command in items {
            if command.hold != nil { blocked.insert(command.entityKey); continue }
            if blocked.contains(command.entityKey) { continue }
            if let at = command.nextAttemptAt, at > now { return .wait(until: at) }
            return .send(command)
        }
        return .nothing
    }

    enum Step: Equatable {
        /// Look at the next command.
        case continueDraining
        /// Stop for now; try again later.
        case stop
        /// The phone was removed from the portal; the queue was emptied.
        case signedOut
    }

    /// Applies the answer to command `commandId`.
    mutating func apply(_ result: SendResult, to commandId: String, now: Date) -> Step {
        guard let index = items.firstIndex(where: { $0.commandId == commandId }) else { return .continueDraining }
        switch result {
        case .applied(let reply):
            let done = items.remove(at: index)
            note(outcome(for: done, reply: reply, now: now))
            chain(after: done, reply: reply)
            return .continueDraining
        case .retry(let after):
            items[index].attempts += 1
            let wait = max(TimeInterval(after ?? 0), CommandOutbox.backoff(attempts: items[index].attempts))
            items[index].nextAttemptAt = now.addingTimeInterval(wait)
            return .stop
        case .held(let message):
            items[index].hold = message
            items[index].nextAttemptAt = nil
            note(CommandOutcome(id: items[index].commandId, at: now, kind: .held, label: items[index].label, message: message))
            return .continueDraining
        case .revoked:
            items.removeAll()
            outcomes.removeAll()
            return .signedOut
        }
    }

    /// The version a lookup found, or the session a start created, for a command about to be sent.
    mutating func fill(commandId: String, expectedVersion: Int, sessionId: String?) {
        guard let index = items.firstIndex(where: { $0.commandId == commandId }) else { return }
        items[index].expectedVersion = expectedVersion
        if let sessionId, items[index].sessionId == nil {
            let old = items[index].entityKey
            items[index].sessionId = sessionId
            for later in items.indices where items[later].entityKey == old {
                items[later].entityKey = "session:\(sessionId)"
                if items[later].sessionId == nil { items[later].sessionId = sessionId }
            }
        }
    }

    /// The person chose Try again for a held command: it is sent anew, its version looked up afresh.
    mutating func retryHeld(commandId: String) {
        guard let index = items.firstIndex(where: { $0.commandId == commandId }), items[index].hold != nil else { return }
        items[index].hold = nil
        items[index].attempts = 0
        items[index].nextAttemptAt = nil
        // A version looked up before the hold (or named by an answer against an older view) is stale now; the server
        // refuses a mismatch, so every kind sends anew without one (a check-in answer then means "any version").
        items[index].expectedVersion = nil
    }

    /// The person chose Drop: the command goes, and so do the later commands on its entity (they depended on it).
    mutating func drop(commandId: String, now: Date) {
        guard let index = items.firstIndex(where: { $0.commandId == commandId }) else { return }
        let key = items[index].entityKey
        var removed: [OutboxCommand] = []
        var kept: [OutboxCommand] = []
        for (position, command) in items.enumerated() {
            if position >= index && command.entityKey == key { removed.append(command) } else { kept.append(command) }
        }
        items = kept
        for command in removed {
            note(CommandOutcome(id: command.commandId, at: now, kind: .dropped, label: command.label,
                                message: "Dropped. It was not sent."))
        }
    }

    mutating func dismissOutcome(id: String) { outcomes.removeAll { $0.id == id } }

    mutating func removeAll() { items.removeAll(); outcomes.removeAll() }

    // MARK: Reading

    func hasQueuedAnswer(forCheckIn id: String) -> Bool { items.contains { $0.entityKey == "check-in:\(id)" } }
    var heldItems: [OutboxCommand] { items.filter { $0.hold != nil } }
    var oldestMadeAt: Date? { items.map { $0.madeAt }.min() }
    func isHeld(entityKey: String) -> Bool { items.contains { $0.entityKey == entityKey && $0.hold != nil } }

    /// Items about one session, in order: its own key, or a start still queued for its action.
    func items(forEntityKeys keys: Set<String>) -> [OutboxCommand] { items.filter { keys.contains($0.entityKey) } }

    // MARK: Internals

    private mutating func note(_ outcome: CommandOutcome) {
        outcomes.removeAll { $0.id == outcome.id }
        outcomes.append(outcome)
        if outcomes.count > CommandOutbox.maxOutcomes { outcomes.removeFirst(outcomes.count - CommandOutbox.maxOutcomes) }
    }

    private func outcome(for command: OutboxCommand, reply: CommandReply, now: Date) -> CommandOutcome {
        guard let report = reply.report else {
            return CommandOutcome(id: command.commandId, at: now, kind: .applied, label: command.label, message: "Done.")
        }
        if report.delivered == false {
            let message = "Not delivered: the check-in closed while you were offline. Your words were kept as a note, and the plan was not changed."
            return CommandOutcome(id: command.commandId, at: now, kind: .notDelivered, label: command.label,
                                  message: report.message.isEmpty ? message : message + " " + report.message)
        }
        if report.applied {
            return CommandOutcome(id: command.commandId, at: now, kind: .applied, label: command.label,
                                  message: report.message.isEmpty ? "Recorded at the time you did it." : report.message)
        }
        return CommandOutcome(id: command.commandId, at: now, kind: .atReceipt, label: command.label,
                              message: report.message.isEmpty ? "Applied when the server received it, not when you did it." : report.message)
    }

    /// Hands the reply's version to the next command on the same entity, so the app never conflicts with its own
    /// earlier command. A start's reply names the session its later commands act on.
    private mutating func chain(after done: OutboxCommand, reply: CommandReply) {
        guard done.kind != .checkIn else { return }
        let ended = ["finish", "finish_activity", "did_not_start", "block"].contains(done.type)
        let key = done.entityKey
        if done.type == "start" {
            guard let sessionId = reply.sessionId else { return }
            var first = true
            for index in items.indices where items[index].entityKey == key {
                items[index].entityKey = "session:\(sessionId)"
                items[index].sessionId = sessionId
                if first, let version = reply.sessionVersion { items[index].expectedVersion = version }
                first = false
            }
            return
        }
        if ended {
            for index in items.indices where items[index].entityKey == key {
                items[index].hold = "This was queued after the session ended, so it was not sent."
            }
            return
        }
        guard reply.sessionId == done.sessionId, let version = reply.sessionVersion,
              let next = items.firstIndex(where: { $0.entityKey == key }) else { return }
        items[next].expectedVersion = version
    }
}
