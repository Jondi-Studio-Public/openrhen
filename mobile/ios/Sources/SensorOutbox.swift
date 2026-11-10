import Foundation

// The phone's sensor rows waiting for the server, what has been posted, and when iOS woke the app. Pure value types;
// the file and the network are in SensorCenter.swift. The design (section 9.3): rows are written before any network
// attempt, drained in batches that never block commands, an event the server refuses is set aside with its message and
// the rest continue, and nothing is dropped for age.

/// What the server said to one batch.
struct SensorRejection: Equatable {
    let index: Int
    let reason: String
}

enum SensorReply: Equatable {
    /// 2xx. Every row not listed was stored or already held.
    case accepted(rejected: [SensorRejection])
    /// No answer, a 5xx, a rate limit or a host the server does not allow: keep everything and try again later.
    case retry(after: TimeInterval?, note: String)
    /// A 4xx for the whole batch (too large, a malformed request). The batch is split until the one at fault stands alone.
    case refused(String)
    /// 401: the portal no longer knows this phone.
    case revoked

    static func interpret(_ answer: HTTPAnswer) -> SensorReply {
        if (200..<300).contains(answer.status) { return .accepted(rejected: rejections(in: answer.body)) }
        guard let failure = ApiResponses.failure(for: answer, signed: true) else {
            return .retry(after: nil, note: "The server answered in a way this app does not understand.")
        }
        switch failure {
        case .revoked: return .revoked
        case .rejected(let message): return .refused(message)
        case .rateLimited(let seconds): return .retry(after: seconds.map { TimeInterval($0) }, note: failure.message)
        case .unreachable, .hostNotAllowed, .server, .badResponse: return .retry(after: nil, note: failure.message)
        }
    }

    /// `rejected: [{index, reason}]` from the ingest reply.
    static func rejections(in body: Data) -> [SensorRejection] {
        guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let list = object["rejected"] as? [[String: Any]] else { return [] }
        return list.compactMap { entry in
            guard let index = entry["index"] as? Int, let reason = entry["reason"] as? String else { return nil }
            return SensorRejection(index: index, reason: String(reason.prefix(300)))
        }
    }
}

/// What was last posted for one period of one device, so unchanged data is not posted again and a changed period gets the next version.
struct LedgerEntry: Codable, Equatable {
    /// The highest version the server accepted; -1 when none was (only a refused one is known).
    var v: Int
    var fingerprint: String
    /// The content the server refused last time. The same content is not sent again.
    var refusedFingerprint: String?
    var touchedAt: Date
}

/// A row the server refused, kept to be read on the Sources screen. The same reason on the same kind is one entry with a count.
struct SetAsideRow: Codable, Equatable {
    let label: String
    let message: String
    var count: Int
    var lastAt: Date
}

enum WakeKind: String, Codable, Equatable {
    case location
    case health

    var title: String {
        switch self {
        case .location: return "A place change"
        case .health: return "New Health data"
        }
    }
}

struct WakeRecord: Codable, Equatable {
    let kind: WakeKind
    let at: Date
    /// True when iOS started or woke the app (it was not already in front). Only these say how often iOS wakes the app.
    let background: Bool
}

/// When iOS woke the app, so the place model can be tuned on measured numbers rather than guesses.
struct WakeLog: Codable, Equatable {
    static let maxRecords = 300
    /// Two records of one kind this close are one wake (a batch of readings arrives together).
    static let sameWake: TimeInterval = 5

    private(set) var records: [WakeRecord] = []

    mutating func record(_ kind: WakeKind, at: Date, background: Bool) {
        if let last = records.last(where: { $0.kind == kind }), abs(at.timeIntervalSince(last.at)) < WakeLog.sameWake { return }
        records.append(WakeRecord(kind: kind, at: at, background: background))
        if records.count > WakeLog.maxRecords { records.removeFirst(records.count - WakeLog.maxRecords) }
    }

    struct Summary: Equatable {
        let wakes: Int
        let last: Date
        /// nil with fewer than two wakes.
        let medianGap: TimeInterval?
        let longestGap: TimeInterval?
    }

    /// The background wakes of `kind`; nil when there were none.
    func summary(_ kind: WakeKind) -> Summary? {
        let times = records.filter { $0.kind == kind && $0.background }.map { $0.at }.sorted()
        guard let last = times.last else { return nil }
        let gaps = zip(times.dropFirst(), times).map { $0.timeIntervalSince($1) }.sorted()
        guard !gaps.isEmpty else { return Summary(wakes: times.count, last: last, medianGap: nil, longestGap: nil) }
        let middle = gaps.count / 2
        let median = gaps.count % 2 == 1 ? gaps[middle] : (gaps[middle - 1] + gaps[middle]) / 2
        return Summary(wakes: times.count, last: last, medianGap: median, longestGap: gaps.last)
    }
}

/// Everything the sensor side keeps on the phone, in one file so a crash cannot leave the ledger and the queue disagreeing.
struct SensorState: Codable, Equatable {
    static let maxBatchEvents = 1000
    /// Under the server's 1.5 MB advice for one request (its cap is 2 MB).
    static let maxBatchBytes = 1_000_000
    static let baseBackoff: TimeInterval = 5
    static let maxBackoff: TimeInterval = 300
    static let maxSetAside = 30
    static let ledgerKeepDays: TimeInterval = 60 * 86_400
    static let maxVersion = 999
    static let collectorVersion = "ios-app-1"
    static let route = "phone-app"

    private(set) var items: [SensorEvent] = []
    private(set) var setAside: [SetAsideRow] = []
    private(set) var ledger: [String: LedgerEntry] = [:]
    var wakes = WakeLog()
    /// The last heartbeat built, so one wake a minute does not build sixty.
    private(set) var lastHeartbeatId: String?
    /// The end of the last Health read that finished, or nil before the first.
    var healthReadThrough: Date?
    private(set) var attempts = 0
    private(set) var notBefore: Date?
    private(set) var lastNote: String?
    private var batchLimit: Int?
    /// Ids of the rows in the request that is in the air. Cleared when the app starts, because that request is gone.
    private(set) var sending: Set<String> = []

    init() {}

    private enum CodingKeys: String, CodingKey {
        case items, setAside, ledger, wakes, lastHeartbeatId, healthReadThrough, attempts, notBefore, lastNote, batchLimit, sending
    }

    /// Every field is optional on disk, so a file written by an older build still loads instead of emptying the queue.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        items = try container.decodeIfPresent([SensorEvent].self, forKey: .items) ?? []
        setAside = try container.decodeIfPresent([SetAsideRow].self, forKey: .setAside) ?? []
        ledger = try container.decodeIfPresent([String: LedgerEntry].self, forKey: .ledger) ?? [:]
        wakes = try container.decodeIfPresent(WakeLog.self, forKey: .wakes) ?? WakeLog()
        lastHeartbeatId = try container.decodeIfPresent(String.self, forKey: .lastHeartbeatId)
        healthReadThrough = try container.decodeIfPresent(Date.self, forKey: .healthReadThrough)
        attempts = try container.decodeIfPresent(Int.self, forKey: .attempts) ?? 0
        notBefore = try container.decodeIfPresent(Date.self, forKey: .notBefore)
        lastNote = try container.decodeIfPresent(String.self, forKey: .lastNote)
        batchLimit = try container.decodeIfPresent(Int.self, forKey: .batchLimit)
        sending = try container.decodeIfPresent(Set<String>.self, forKey: .sending) ?? []
    }

    var count: Int { items.count }
    var oldestQueuedAt: Date? { items.map { $0.queuedAt }.min() }

    mutating func clearInFlight() { sending.removeAll() }

    mutating func clearSetAside() { setAside.removeAll() }

    // MARK: Planning

    /// Adds the rows that are new or changed. A period never posted gets version 0; one whose content changed gets one more
    /// than the highest accepted. A row that is queued but not yet sent is replaced by the newer content at the same version;
    /// one already in the air is left alone and the change follows as the next version. Content the server refused is not
    /// sent again. Returns how many rows were queued.
    @discardableResult
    mutating func plan(_ rows: [PlannedRow], device: String, now: Date) -> Int {
        var added = 0
        for row in rows {
            let key = "\(row.kind)|\(device)|\(row.period)"
            let fingerprint = SensorFingerprint.of(row)
            let held = ledger[key]
            if held?.fingerprint == fingerprint || held?.refusedFingerprint == fingerprint { continue }
            var version = (held?.v ?? -1) + 1
            if let at = items.firstIndex(where: { $0.ledgerKey == key }) {
                let queued = items[at]
                if queued.fingerprint == fingerprint { continue }
                if sending.contains(queued.id) {
                    version = (queued.v ?? version) + 1
                } else {
                    version = queued.v ?? version
                    items.remove(at: at)
                }
            }
            guard version <= SensorState.maxVersion else { continue }
            var attrs = row.attrs
            attrs["device"] = .string(device)
            attrs["route"] = .string(SensorState.route)
            attrs["v"] = .int(version)
            attrs["collector_version"] = .string(SensorState.collectorVersion)
            items.append(SensorEvent(id: "\(key)|v\(version)", source: "physiology", kind: row.kind, start: row.start, end: row.end,
                                     tzOffsetMin: row.tzOffsetMin, attrs: attrs, ledgerKey: key, fingerprint: fingerprint,
                                     v: version, queuedAt: now))
            added += 1
        }
        return added
    }

    /// Queues this hour's heartbeat unless it was already built. Returns whether one was queued.
    @discardableResult
    mutating func planHeartbeat(device: String, now: Date) -> Bool {
        let id = SensorHeartbeat.id(device: device, at: now)
        if lastHeartbeatId == id || items.contains(where: { $0.id == id }) { return false }
        items.append(SensorHeartbeat.event(device: device, now: now))
        lastHeartbeatId = id
        return true
    }

    // MARK: Sending

    enum Pick: Equatable {
        case nothing
        /// Backing off; look again at this time.
        case wait(until: Date)
        case send([SensorEvent])
    }

    /// The next batch, oldest first, within the row and byte limits (and at least one row). Marks it as in the air.
    mutating func nextBatch(now: Date) -> Pick {
        if items.isEmpty { return .nothing }
        if let notBefore, notBefore > now { return .wait(until: notBefore) }
        let limit = min(batchLimit ?? SensorState.maxBatchEvents, SensorState.maxBatchEvents)
        var batch: [SensorEvent] = []
        var bytes = 0
        for item in items {
            let size = SensorWire.size(of: item)
            if !batch.isEmpty && (batch.count >= limit || bytes + size > SensorState.maxBatchBytes) { break }
            batch.append(item)
            bytes += size
        }
        sending = Set(batch.map { $0.id })
        return .send(batch)
    }

    enum Step: Equatable {
        case continueDraining
        case retryLater
        case signedOut
    }

    static func backoff(attempts: Int) -> TimeInterval {
        min(baseBackoff * pow(2, Double(max(attempts - 1, 0))), maxBackoff)
    }

    /// Applies the server's answer to the batch that was sent.
    mutating func apply(_ reply: SensorReply, sent batch: [SensorEvent], now: Date) -> Step {
        sending.removeAll()
        switch reply {
        case .accepted(let rejected):
            let sentIds = Set(batch.map { $0.id })
            items.removeAll { sentIds.contains($0.id) }
            var reasons: [Int: String] = [:]
            for rejection in rejected where reasons[rejection.index] == nil { reasons[rejection.index] = rejection.reason }
            for (index, event) in batch.enumerated() {
                if let reason = reasons[index] {
                    refuse(event, reason: reason, now: now)
                } else if let key = event.ledgerKey {
                    ledger[key] = LedgerEntry(v: event.v ?? 0, fingerprint: event.fingerprint ?? "", refusedFingerprint: nil, touchedAt: now)
                }
            }
            pruneLedger(now: now)
            attempts = 0
            notBefore = nil
            lastNote = nil
            batchLimit = nil
            return .continueDraining
        case .retry(let after, let note):
            attempts += 1
            notBefore = now.addingTimeInterval(max(after ?? 0, SensorState.backoff(attempts: attempts)))
            lastNote = note
            return .retryLater
        case .refused(let message):
            if batch.count > 1 {
                batchLimit = max(1, batch.count / 2)
                return .continueDraining
            }
            if let only = batch.first {
                items.removeAll { $0.id == only.id }
                refuse(only, reason: message, now: now)
            }
            return .continueDraining
        case .revoked:
            items.removeAll()
            setAside.removeAll()
            ledger.removeAll()
            return .signedOut
        }
    }

    private mutating func refuse(_ event: SensorEvent, reason: String, now: Date) {
        if let key = event.ledgerKey {
            var entry = ledger[key] ?? LedgerEntry(v: -1, fingerprint: "", refusedFingerprint: nil, touchedAt: now)
            entry.refusedFingerprint = event.fingerprint
            entry.touchedAt = now
            ledger[key] = entry
        }
        let label = SensorWords.rowLabel(event)
        if let at = setAside.firstIndex(where: { $0.label == label && $0.message == reason }) {
            setAside[at].count += 1
            setAside[at].lastAt = now
        } else {
            setAside.append(SetAsideRow(label: label, message: reason, count: 1, lastAt: now))
            if setAside.count > SensorState.maxSetAside { setAside.removeFirst(setAside.count - SensorState.maxSetAside) }
        }
    }

    /// Forgets periods not touched for 60 days. The re-read window is days, so these are never looked at again.
    mutating func pruneLedger(now: Date) {
        ledger = ledger.filter { now.timeIntervalSince($0.value.touchedAt) <= SensorState.ledgerKeepDays }
    }
}
