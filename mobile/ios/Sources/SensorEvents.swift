import Foundation

/// A value inside a sensor row's `attrs`. Foundation only, so `Checks/main.swift` can run the row builders.
indirect enum SensorValue: Codable, Equatable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case null
    case array([SensorValue])
    case object([String: SensorValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null; return }
        if let value = try? container.decode(Bool.self) { self = .bool(value); return }
        if let value = try? container.decode(Int.self) { self = .int(value); return }
        if let value = try? container.decode(Double.self) { self = .double(value); return }
        if let value = try? container.decode(String.self) { self = .string(value); return }
        if let value = try? container.decode([SensorValue].self) { self = .array(value); return }
        self = .object(try container.decode([String: SensorValue].self))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .int(let value): try container.encode(value)
        case .double(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .null: try container.encodeNil()
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

/// One row the phone will post to `POST /api/activity-events`. `id` is the server's key; for a physiology row it
/// is `<kind>|<device>|<period>|v<v>` (docs/operations/posting-physiology-data.md section 3).
struct SensorEvent: Codable, Equatable {
    let id: String
    let source: String
    let kind: String
    let start: Date
    let end: Date?
    /// The phone's offset from UTC at the time of the event, in minutes east. Sent so the server need not guess.
    let tzOffsetMin: Int?
    let attrs: [String: SensorValue]
    /// `<kind>|<device>|<period>` for a physiology row: what a later version of the same period replaces. nil for a heartbeat.
    let ledgerKey: String?
    /// A short hash of what the row says (see `SensorFingerprint`), so unchanged data is never posted again.
    let fingerprint: String?
    let v: Int?
    let queuedAt: Date

    /// The row as the server reads it.
    var wire: SensorValue {
        var object: [String: SensorValue] = [
            "id": .string(id), "source": .string(source), "kind": .string(kind),
            "start": .string(ApiDates.string(start)), "attrs": .object(attrs),
        ]
        if let end { object["end"] = .string(ApiDates.string(end)) }
        if let tzOffsetMin { object["tzOffsetMin"] = .int(tzOffsetMin) }
        return .object(object)
    }
}

/// JSON for the wire. Numbers are written by Swift's own encoder (shortest form that reads back exactly), because the
/// server refuses a value with more decimal places than the kind allows.
enum SensorWire {
    static func data(_ value: SensorValue) -> Data? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try? encoder.encode(value)
    }

    /// `{schema: 1, device, events: [...]}`. `device` is the install id, which the heartbeat key and every physiology
    /// key name, so the server's key check passes.
    static func batchBody(device: String, events: [SensorEvent]) -> Data? {
        data(.object(["schema": .int(1), "device": .string(device), "events": .array(events.map { $0.wire })]))
    }

    /// The bytes one event adds to a batch (its JSON and a comma).
    static func size(of event: SensorEvent) -> Int {
        (data(event.wire)?.count ?? 0) + 1
    }
}

/// A 64-bit FNV-1a hash of a row's content, in hex. Not a secret and not for security: it only tells "the same data
/// as last time" from "changed", so a revised hour is posted as the next version and an unchanged one is not.
enum SensorFingerprint {
    static func of(_ row: PlannedRow) -> String {
        var object: [String: SensorValue] = [
            "kind": .string(row.kind), "period": .string(row.period),
            "start": .string(ApiDates.string(row.start)), "attrs": .object(row.attrs),
        ]
        if let end = row.end { object["end"] = .string(ApiDates.string(end)) }
        let bytes = SensorWire.data(.object(object)) ?? Data()
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in bytes {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01b3
        }
        return String(hash, radix: 16)
    }
}

/// The phone's device label in a physiology key: 1 to 64 characters from `A-Z a-z 0-9 . _ : -`. The install id is already
/// that; anything else is dropped rather than sent, so a key can never be refused for its device.
enum SensorDevice {
    static let maxLength = 64

    static func label(fromInstallId installId: String) -> String? {
        let allowed = installId.filter { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "_" || $0 == ":" || $0 == "-") }
        let cut = String(allowed.prefix(maxLength))
        return cut.isEmpty ? nil : cut
    }
}

/// The heartbeat: "this phone's app is alive", sent on every wake. Its key names the device and the UTC hour, so a
/// second wake in the same hour is `alreadyHeld`, never an error. The source is `phone` (live delivery, origin phone,
/// one row per install id), as the native app design says.
enum SensorHeartbeat {
    static let source = "phone"

    /// `hb:<device>:<UTC hour>:ok`, the exact key the server demands (`heartbeatKey` in activity-events.ts).
    static func id(device: String, at date: Date) -> String {
        "hb:\(device):\(ApiDates.string(date).prefix(13)):ok"
    }

    static func event(device: String, now: Date) -> SensorEvent {
        SensorEvent(id: id(device: device, at: now), source: source, kind: "heartbeat", start: now, end: nil, tzOffsetMin: nil,
                    attrs: ["status": .string("ok")], ledgerKey: nil, fingerprint: nil, v: nil, queuedAt: now)
    }
}
