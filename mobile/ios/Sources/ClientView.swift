import Foundation

/// The Swift side of `platform/contracts/client-view-schema.v1.json`: the answer of
/// `GET /api/client/view?parts=now,day,pending` and of `POST /api/check-ins/{id}/shown`. Foundation only, so
/// `Checks/main.swift` decodes every fixture in `client-view-fixtures.v1.json` with these types on the runner.
///
/// Every instant stays the ISO 8601 string the server sent (with its offset); `ApiDates.parse` reads it when a
/// screen needs a `Date`. A field the schema marks required is not optional here, so a payload without it fails to
/// decode. A field the schema does not list is ignored: objects may gain fields.

struct ClientView: Codable, Equatable {
    let schemaVersion: Int
    let timezone: String
    let planCurrent: Bool
    /// When the plan behind `now` and `day` stops being current; nil when there is none.
    let validUntil: String?
    let now: ClientNow?
    let day: [ClientDayEntry]?
    let pending: ClientPending?

    /// The contract version this app reads.
    static let supportedSchemaVersion = 1
}

struct ClientNow: Codable, Equatable {
    let directive: ClientDirective?
    let anchors: ClientAnchors
    let needs: [ClientNeed]
    let stretchOffer: ClientTextOffer?
    let energyCost: ClientTextOffer?
}

struct ClientAnchors: Codable, Equatable {
    let open: [String]
    let engaged: [String]
}

/// `stretchOffer` and `energyCost`: the server's own sentence to show.
struct ClientTextOffer: Codable, Equatable {
    let text: String
}

/// What to do now. Only the fields the screens use are kept; `kind` is the engine's own word (`action`, `travel`,
/// `sleep`, `boundary`, `answer`, ...).
struct ClientDirective: Codable, Equatable {
    let kind: String
    let title: String
    let recommendedMinutes: Double
    let targetId: String?
    let reason: String?
    let tier: String?
    let projectId: String?
    let projectTitle: String?
    let toLocationId: String?
    let toLocationName: String?
    let mode: String?
    let leaveBy: String?
    let typicalMinutes: Double?
    let originAssumed: Bool?
    let notBefore: String?
    let boundaryAt: String?
    let boundaryTitle: String?
    let question: String?
}

/// A stale fact the plan wants to ask about.
struct ClientNeed: Codable, Equatable {
    let fact: String
    let subjectId: String?
    let title: String
    let question: String
    let asOf: String?
    let blocksDirective: Bool
}

struct ClientDayEntry: Codable, Equatable {
    let startsAt: String
    let endsAt: String
    let kind: String
    let title: String
    let targetId: String?
    let minutes: Double
    /// `firm` is decided; `projected` is the engine's replay of what would follow.
    let confidence: String
    /// Who changed this entry, in words, when the server says. The schema has no such field yet; shown if it appears.
    let changedBy: String?
}

struct ClientCheckIn: Codable, Equatable {
    let id: String
    let version: Int
    let slotAt: String
    /// Nil until a surface reported showing it.
    let promptedAt: String?
    let directiveKind: String
    let directiveTargetId: String?
    let directivePhase: String?
    let directiveTitle: String
    /// `pending` is within its window; `unknown` went unanswered while nobody was looking.
    let status: String
}

struct ClientSession: Codable, Equatable {
    let id: String
    /// `running`, `paused` or `feedback`.
    let status: String
    let title: String
    let targetType: String?
    let targetId: String?
    let startedAt: String
    let plannedEndAt: String
    let plannedMinutes: Double
    let elapsedMinutes: Double
    /// What a pause froze while paused; otherwise the distance from the request time to `plannedEndAt`.
    let minutesLeft: Double

    /// Session commands cover an ordinary action; every other target takes the activity commands.
    var isActionSession: Bool { targetType == nil || targetType == "action" }
}

struct ClientLeaveBy: Codable, Equatable {
    let commitmentId: String
    let occurrenceStartsAt: String
    let title: String
    let leaveBy: String
    let remindAt: String
    /// `remind` or `leave`.
    let phase: String
    let typicalMinutes: Double
    let allowingMinutes: Double
    let originAssumed: Bool
}

struct ClientPlaceSuggestion: Codable, Equatable {
    let locationId: String
    let locationName: String
    let observedAt: String
}

struct ClientPending: Codable, Equatable {
    let checkIn: ClientCheckIn?
    let session: ClientSession?
    let leaveBy: ClientLeaveBy?
    let placeSuggestion: ClientPlaceSuggestion?
}

/// The answer of `POST /api/check-ins/{id}/shown`.
struct CheckInShown: Codable, Equatable {
    let id: String
    /// `pending`, `on_track`, `deviated`, `unknown` or `superseded`.
    let status: String
    let promptedAt: String?
    let stamped: Bool
}

/// Reads the contract's JSON. Strict about required fields (a missing one is a decode error), lenient about extras.
enum ClientViewCodec {
    static func decodeView(_ data: Data) -> ClientView? {
        guard let view = try? JSONDecoder().decode(ClientView.self, from: data),
              view.schemaVersion == ClientView.supportedSchemaVersion else { return nil }
        return view
    }

    static func decodeShown(_ data: Data) -> CheckInShown? {
        try? JSONDecoder().decode(CheckInShown.self, from: data)
    }

    /// Every fixture of the type named `type` in the fixtures file's JSON, re-serialised one by one, so a caller can
    /// decode each with its own type. Nil when the file is not the expected shape.
    static func fixtures(named type: String, in file: Data) -> [Data]? {
        guard let object = try? JSONSerialization.jsonObject(with: file) as? [String: Any],
              let list = object[type] as? [Any] else { return nil }
        var out: [Data] = []
        for item in list {
            guard let data = try? JSONSerialization.data(withJSONObject: item, options: [.sortedKeys]) else { return nil }
            out.append(data)
        }
        return out
    }
}
