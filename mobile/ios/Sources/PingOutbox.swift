import Foundation

/// A location fix waiting to be sent to `POST /api/location/ping`.
struct QueuedPing: Codable, Equatable {
    let latitude: Double
    let longitude: Double
    let accuracyMeters: Double
    /// When the phone took the fix. The portal reads presence on this time, so a stale one is never sent.
    let observedAt: Date
}

/// The queue of pings that have not been accepted yet, oldest first. Only live fixes go to the ping route (a
/// drained backlog would pretend the phone just arrived), so a ping older than `maxAge` is dropped, never
/// sent. Pure value type; `OutboxFile` keeps it on disk.
struct PingOutbox: Codable, Equatable {
    /// Five minutes: past this a fix is no longer "where the phone is now".
    static let maxAge: TimeInterval = 300
    /// A hard stop on size; at one ping per 30 seconds the age limit keeps it far below this.
    static let maxCount = 20

    private(set) var items: [QueuedPing] = []

    init() {}

    var isEmpty: Bool { items.isEmpty }
    var count: Int { items.count }

    /// Adds `ping` at the end, after dropping what has expired. Over `maxCount` the oldest go first.
    mutating func enqueue(_ ping: QueuedPing, now: Date) {
        prune(now: now)
        if now.timeIntervalSince(ping.observedAt) > PingOutbox.maxAge { return }
        items.append(ping)
        if items.count > PingOutbox.maxCount { items.removeFirst(items.count - PingOutbox.maxCount) }
    }

    /// Drops every ping older than `maxAge`.
    mutating func prune(now: Date) {
        items.removeAll { now.timeIntervalSince($0.observedAt) > PingOutbox.maxAge }
    }

    /// The oldest ping still worth sending (expired ones are pruned first).
    mutating func next(now: Date) -> QueuedPing? {
        prune(now: now)
        return items.first
    }

    enum Next: Equatable {
        /// The head was dealt with; look at the next one.
        case continueDraining
        /// Stop for now and try again later; the head stays.
        case retryLater
        /// The phone was removed from the portal; the queue was emptied.
        case signedOut
    }

    /// Applies the portal's answer to the head of the queue, in order: a ping is removed only after it was
    /// accepted or can never be accepted; a transient failure keeps it (and everything behind it) in place.
    mutating func apply(_ disposition: PingDisposition) -> Next {
        switch disposition {
        case .sent, .discard:
            if !items.isEmpty { items.removeFirst() }
            return .continueDraining
        case .retryLater:
            return .retryLater
        case .revoked:
            items.removeAll()
            return .signedOut
        }
    }

    mutating func removeAll() { items.removeAll() }
}

/// The outbox as a JSON file in Application Support: complete-until-first-user-authentication file
/// protection, and kept out of device backups. Foundation only.
final class OutboxFile {
    let directory: URL
    let fileURL: URL

    init(directory: URL) {
        self.directory = directory
        self.fileURL = directory.appendingPathComponent("location-outbox.json")
    }

    static func defaultDirectory() -> URL {
        let base = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                 appropriateFor: nil, create: true))
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return base.appendingPathComponent("OpenRhen", isDirectory: true)
    }

    private static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        return encoder
    }

    private static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        return decoder
    }

    /// An unreadable or missing file is an empty queue.
    func load() -> PingOutbox {
        guard let data = try? Data(contentsOf: fileURL),
              let outbox = try? OutboxFile.decoder().decode(PingOutbox.self, from: data) else { return PingOutbox() }
        return outbox
    }

    @discardableResult
    func save(_ outbox: PingOutbox) -> Bool {
        guard prepareDirectory(), let data = try? OutboxFile.encoder().encode(outbox) else { return false }
        var options: Data.WritingOptions = [.atomic]
        #if os(iOS)
        options.insert(.completeFileProtectionUntilFirstUserAuthentication)
        #endif
        return (try? data.write(to: fileURL, options: options)) != nil
    }

    func delete() { try? FileManager.default.removeItem(at: fileURL) }

    /// Creates the folder and marks it as excluded from backups (the mark covers what is written inside).
    private func prepareDirectory() -> Bool {
        let manager = FileManager.default
        if !manager.fileExists(atPath: directory.path) {
            do {
                var attributes: [FileAttributeKey: Any] = [:]
                #if os(iOS)
                attributes[.protectionKey] = FileProtectionType.completeUntilFirstUserAuthentication
                #endif
                try manager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: attributes)
            } catch {
                return false
            }
        }
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var target = directory
        try? target.setResourceValues(values)
        return true
    }
}
