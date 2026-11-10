import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The last client view the phone showed, with what it needs to revalidate and to say how old it is. Kept on disk
/// (`PrivateJSONFile`) so the screens render offline.
struct CachedView: Codable, Equatable {
    let view: ClientView
    /// The server's tag for this body, sent back as `If-None-Match`.
    let etag: String?
    /// When this phone last got an answer (a 200 or a 304) for it.
    let fetchedAt: Date
}

/// How current the cached view is, and the words for it.
struct ViewFreshness: Equatable {
    /// A view older than this is shown as "as of ..." and dimmed, whatever `validUntil` says.
    static let maxAge: TimeInterval = 15 * 60

    let isStale: Bool
    /// "as of 10:42", in the plan's time zone.
    let asOfText: String
    /// Why it is stale, in words, or nil when it is current.
    let reason: String?

    static func assess(_ cached: CachedView, now: Date, lastRefreshFailed: Bool) -> ViewFreshness {
        let zone = TimeZone(identifier: cached.view.timezone) ?? TimeZone.current
        let asOf = "as of " + TimeText.clock(cached.fetchedAt, in: zone)
        if let text = cached.view.validUntil, let until = ApiDates.parse(text), now > until {
            return ViewFreshness(isStale: true, asOfText: asOf, reason: "The plan has moved on since \(TimeText.clock(cached.fetchedAt, in: zone)).")
        }
        if now.timeIntervalSince(cached.fetchedAt) > maxAge {
            let why = lastRefreshFailed ? "Can't reach your server." : "Not refreshed for a while."
            return ViewFreshness(isStale: true, asOfText: asOf, reason: why)
        }
        if lastRefreshFailed {
            return ViewFreshness(isStale: false, asOfText: asOf, reason: "Can't reach your server; showing the last good view.")
        }
        if !cached.view.planCurrent {
            return ViewFreshness(isStale: false, asOfText: asOf, reason: "The plan is being recalculated.")
        }
        return ViewFreshness(isStale: false, asOfText: asOf, reason: nil)
    }
}

/// Clock and duration words. Fixed formats, so the same instant reads the same on every phone and in the checks.
enum TimeText {
    /// 24-hour `HH:mm` in `zone`.
    static func clock(_ date: Date, in zone: TimeZone) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = zone
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: date)
    }

    /// `45 min`, `1 h`, `1 h 15 min`.
    static func minutes(_ value: Double) -> String {
        let total = max(Int(value.rounded()), 0)
        if total < 60 { return "\(total) min" }
        let hours = total / 60
        let rest = total % 60
        return rest == 0 ? "\(hours) h" : "\(hours) h \(rest) min"
    }

    /// An ISO 8601 instant as a clock time in `zone`; the text itself when it does not parse.
    static func clock(iso text: String, in zone: TimeZone) -> String {
        guard let date = ApiDates.parse(text) else { return text }
        return clock(date, in: zone)
    }
}

/// The requests the live screens make, built like `ApiRequests`: https origin only, the token in the owner header.
enum ClientRequests {
    static let viewPath = "/api/client/view?parts=now,day,pending"
    static let eventsPath = "/api/events"

    private static func get(origin: String, path: String, token: String, headers: [String: String] = [:], timeout: TimeInterval = ApiRequests.timeout) -> URLRequest? {
        guard let target = ApiRequests.endpoint(origin: origin, path: path) else { return nil }
        var request = URLRequest(url: target, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = "GET"
        request.setValue(token, forHTTPHeaderField: ApiRequests.ownerHeader)
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        return request
    }

    /// The client view, revalidating by tag when one is held.
    static func view(origin: String, token: String, etag: String?) -> URLRequest? {
        var headers: [String: String] = ["Accept": "application/json"]
        if let etag, !etag.isEmpty { headers["If-None-Match"] = etag }
        return get(origin: origin, path: viewPath, token: token, headers: headers)
    }

    /// The server's event stream. The server pings every 25 seconds, so a connection silent for 90 is dead.
    static func events(origin: String, token: String) -> URLRequest? {
        get(origin: origin, path: eventsPath, token: token, headers: ["Accept": "text/event-stream"], timeout: 90)
    }

    /// `POST /api/check-ins/{id}/shown`, no body. nil when `id` is not a plain id (nothing is sent).
    static func shown(origin: String, token: String, checkInId: String) -> URLRequest? {
        guard !checkInId.isEmpty, checkInId.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }) else { return nil }
        return ApiRequests.post(origin: origin, path: "/api/check-ins/\(checkInId)/shown", token: token, body: [:])
    }
}

/// What a refresh came to.
enum ViewFetchResult: Equatable {
    /// A new body.
    case updated(CachedView)
    /// 304: nothing changed; the same view, now confirmed at `fetchedAt`.
    case unchanged(CachedView)
    /// No answer at all.
    case unreachable
    /// 401 on a call that carried the token.
    case revoked
    /// Any other failure, in words.
    case failed(String)
}

enum ViewFetch {
    static func interpret(_ answer: HTTPAnswer?, previous: CachedView?, now: Date) -> ViewFetchResult {
        guard let answer else { return .unreachable }
        if answer.status == 304 {
            guard let previous else { return .failed(ApiError.badResponse.message) }
            return .unchanged(CachedView(view: previous.view, etag: previous.etag, fetchedAt: now))
        }
        if let error = ApiResponses.failure(for: answer, signed: true) {
            if error == .revoked { return .revoked }
            return .failed(error.message)
        }
        guard let view = ClientViewCodec.decodeView(answer.body) else { return .failed(ApiError.badResponse.message) }
        return .updated(CachedView(view: view, etag: answer.etag, fetchedAt: now))
    }
}

/// How often to look again when no event stream is carrying changes, and the delays between stream reconnects.
enum RefreshPolicy {
    /// Poll interval while the app is in the foreground and the stream is not connected.
    static let pollInterval: TimeInterval = 60
    /// A safety poll while the stream is connected (a missed event must not leave the screen wrong for long).
    static let streamSafetyInterval: TimeInterval = 300

    /// Seconds to wait before reconnect attempt number `attempt` (1 is the first): 2, 4, 8 ... capped at 60.
    static func reconnectDelay(attempt: Int) -> TimeInterval {
        let exponent = min(max(attempt, 1), 6)
        return min(TimeInterval(1 << exponent), 60)
    }
}

/// Server-sent events, parsed incrementally from the lines of the stream. Foundation only.
struct EventStreamParser {
    struct Event: Equatable {
        let name: String
        let data: String
    }

    private var name = ""
    private var data: [String] = []

    /// Feeds one line (without its line ending). A blank line ends an event and returns it; a comment line (the
    /// server's `: ping`) and any field this reader does not use return nil.
    mutating func feed(line rawLine: String) -> Event? {
        var line = rawLine
        if line.hasSuffix("\r") { line.removeLast() }
        if line.isEmpty {
            defer { name = ""; data = [] }
            guard !data.isEmpty || !name.isEmpty else { return nil }
            return Event(name: name.isEmpty ? "message" : name, data: data.joined(separator: "\n"))
        }
        if line.hasPrefix(":") { return nil }
        let field: String
        var value: String
        if let colon = line.firstIndex(of: ":") {
            field = String(line[line.startIndex..<colon])
            value = String(line[line.index(after: colon)...])
            if value.hasPrefix(" ") { value.removeFirst() }
        } else {
            field = line
            value = ""
        }
        switch field {
        case "event": name = value
        case "data": data.append(value)
        default: break
        }
        return nil
    }
}

/// Cuts a byte stream into lines, keeping the empty ones (an event stream ends each event with a blank line;
/// `URLSession.AsyncBytes.lines` drops those, so the stream is read byte by byte through this).
struct LineSplitter {
    private var buffer: [UInt8] = []

    /// Feeds one byte; returns a line when it was a line feed.
    mutating func feed(_ byte: UInt8) -> String? {
        if byte == 0x0A {
            defer { buffer.removeAll(keepingCapacity: true) }
            return String(decoding: buffer, as: UTF8.self)
        }
        buffer.append(byte)
        return nil
    }
}

/// How the screen is being kept current.
enum LiveMode: Equatable {
    /// The app is not in the foreground.
    case stopped
    /// The server's event stream is connected: it says when to look again.
    case stream
    /// No stream: the view is polled by tag.
    case polling
}

/// The words of the Sources screen: what is live, when the server was last heard, what is waiting to send.
enum SourcesWords {
    static func liveMode(_ mode: LiveMode) -> String {
        switch mode {
        case .stream: return "Live: your server tells this phone when the plan changes."
        case .polling: return "Checking your server about once a minute."
        case .stopped: return "Paused while the app is closed."
        }
    }

    static func lastHeard(_ date: Date?, now: Date, zone: TimeZone) -> String {
        guard let date else { return "Not heard from your server yet." }
        let seconds = now.timeIntervalSince(date)
        if seconds < 90 { return "Last heard just now." }
        return "Last heard at \(TimeText.clock(date, in: zone))."
    }

    struct QueueSummary: Equatable {
        let headline: String
        let warning: String?
    }

    /// How much is waiting, and a warning once something has waited a day, then a week.
    static func queue(_ box: CommandOutbox, now: Date) -> QueueSummary {
        let waiting = box.count
        let held = box.heldItems.count
        var headline = waiting == 0 ? "Nothing is waiting to be sent." : "\(waiting) waiting to be sent, in the order you made them."
        if held > 0 { headline += " \(held) need\(held == 1 ? "s" : "") your answer." }
        guard let oldest = box.oldestMadeAt else { return QueueSummary(headline: headline, warning: nil) }
        let age = now.timeIntervalSince(oldest)
        if age >= 7 * 86_400 {
            return QueueSummary(headline: headline, warning: "Something has been waiting for a week or more. Check your server can be reached; removing the app loses it.")
        }
        if age >= 86_400 {
            return QueueSummary(headline: headline, warning: "Something has been waiting for over a day. Removing the app now would lose it.")
        }
        return QueueSummary(headline: headline, warning: nil)
    }
}
