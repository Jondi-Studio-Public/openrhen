import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The wire contract of the device sign-in routes and the location ping: request builders and response
/// interpretation, as pure functions. No networking here, so `Checks/main.swift` can run them on the runner.
/// Every `/api` call that holds the owner token sends it in `X-OpenRhen-Owner`.

enum ApiPath {
    static let redeem = "/api/owner/devices/redeem"
    static let codeStart = "/api/owner/devices/code"
    static let codePoll = "/api/owner/devices/code/token"
    static let webSession = "/api/owner/web-session"
    static let locationPing = "/api/location/ping"
}

/// What a call can fail with, each with the words the person sees.
enum ApiError: Error, Equatable {
    /// No answer: offline, the server is down, or the connection dropped.
    case unreachable
    /// 401 on a call that carried the token: the portal no longer knows this phone.
    case revoked
    /// 403 "This host is not allowed.": the name the phone used is not in the portal's allowed hosts.
    case hostNotAllowed
    case rateLimited(retryAfter: Int?)
    /// Any other 4xx, with the server's own message when it gave one.
    case rejected(message: String)
    case server(status: Int)
    /// A reply that is not the shape the contract says (including a refused redirect).
    case badResponse

    var message: String {
        switch self {
        case .unreachable:
            return "Can't reach your server. Check the phone is online (and on your private network, if the portal is on one)."
        case .revoked:
            return AuthState.removedNotice
        case .hostNotAllowed:
            return "Your server doesn't accept this name. Add it to PORTAL_ALLOWED_HOSTS or use the name your browser uses."
        case .rateLimited(let seconds):
            if let seconds { return "Too many attempts. Wait \(seconds) seconds and try again." }
            return "Too many attempts. Wait a moment and try again."
        case .rejected(let message):
            return message
        case .server(let status):
            return "The server had a problem (status \(status)). Try again shortly."
        case .badResponse:
            return "The server answered in a way this app does not understand."
        }
    }
}

/// The reply to `redeem` and to an approved `code/token` poll: `{token, credential}`.
struct IssuedCredential: Equatable {
    let token: String
    let credentialId: String?
    let label: String?
}

/// The reply to `POST /api/owner/devices/code`.
struct DeviceCodeStart: Equatable {
    let deviceCode: String
    /// Eight letters shown as `BCDF-GHJK`.
    let userCode: String
    let expiresIn: Int
    let interval: Int
}

/// The cookie `POST /api/owner/web-session` hands the web view.
struct WebSessionCookie: Equatable {
    let name: String
    let value: String
    let expiresAt: Date?
    let maxAgeSeconds: Int?
}

/// A raw HTTP answer, reduced to what the interpreters need.
struct HTTPAnswer: Equatable {
    let status: Int
    let body: Data
    let retryAfter: Int?
    /// The `ETag` response header, when there was one.
    var etag: String? = nil
}

enum ApiRequests {
    static let ownerHeader = "X-OpenRhen-Owner"
    static let timeout: TimeInterval = 20

    /// `origin` + `path`, only for a well-formed https origin: the token never goes anywhere else.
    static func endpoint(origin: String, path: String) -> URL? {
        guard let base = HostPolicy.httpsURL(origin), HostPolicy.origin(of: base) == origin,
              HostPolicy.mayCarryToken(to: base) else { return nil }
        return URL(string: origin + path)
    }

    static func redeem(origin: String, secret: String, name: String, installId: String) -> URLRequest? {
        post(origin: origin, path: ApiPath.redeem, token: nil, body: [
            "pairingSecret": secret, "name": DeviceName.clean(name), "installId": installId, "platform": "ios",
        ])
    }

    static func codeStart(origin: String, name: String, installId: String) -> URLRequest? {
        post(origin: origin, path: ApiPath.codeStart, token: nil, body: [
            "name": DeviceName.clean(name), "installId": installId, "platform": "ios",
        ])
    }

    static func codePoll(origin: String, deviceCode: String) -> URLRequest? {
        post(origin: origin, path: ApiPath.codePoll, token: nil, body: ["deviceCode": deviceCode])
    }

    static func webSession(origin: String, token: String) -> URLRequest? {
        post(origin: origin, path: ApiPath.webSession, token: token, body: [:])
    }

    /// The ping body is the portal's strict reading shape plus `device`, the install id as a plain string
    /// (the owner token names the phone too; if both are sent they must match).
    static func locationPing(origin: String, token: String, installId: String, ping: QueuedPing) -> URLRequest? {
        post(origin: origin, path: ApiPath.locationPing, token: token, body: [
            "latitude": ping.latitude,
            "longitude": ping.longitude,
            "accuracyMeters": max(ping.accuracyMeters, 0),
            "observedAt": ApiDates.string(ping.observedAt),
            "device": installId,
        ])
    }

    /// `DELETE /api/owner/credentials/{id}`: the phone revoking its own credential (a limited credential may revoke
    /// only itself). nil when `id` is not a plain id, so nothing is sent.
    static func revokeOwnCredential(origin: String, token: String, credentialId: String) -> URLRequest? {
        guard !credentialId.isEmpty, credentialId.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" }),
              let target = endpoint(origin: origin, path: "/api/owner/credentials/\(credentialId)") else { return nil }
        var request = URLRequest(url: target, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = "DELETE"
        request.setValue(token, forHTTPHeaderField: ownerHeader)
        return request
    }

    static func post(origin: String, path: String, token: String?, body: [String: Any]) -> URLRequest? {
        guard let target = endpoint(origin: origin, path: path),
              let data = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]) else { return nil }
        var request = URLRequest(url: target, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token, !token.isEmpty { request.setValue(token, forHTTPHeaderField: ownerHeader) }
        request.httpBody = data
        return request
    }
}

enum ApiDates {
    static func string(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    /// Accepts ISO 8601 with or without fractional seconds.
    static func parse(_ text: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: text) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: text)
    }
}

enum ApiResponses {
    static let hostNotAllowedMessage = "This host is not allowed."

    /// nil for a 2xx; otherwise what went wrong. `signed` is true when the call carried the owner token, so a
    /// 401 means the portal no longer knows this phone.
    static func failure(for answer: HTTPAnswer, signed: Bool) -> ApiError? {
        let status = answer.status
        if (200..<300).contains(status) { return nil }
        let message = errorText(answer.body)
        if status == 401 && signed { return .revoked }
        if status == 403 && message == hostNotAllowedMessage { return .hostNotAllowed }
        if status == 429 { return .rateLimited(retryAfter: answer.retryAfter) }
        if (400..<500).contains(status) { return .rejected(message: message ?? "The server refused the request (status \(status)).") }
        if status >= 500 { return .server(status: status) }
        return .badResponse
    }

    /// The `error` string of a JSON error body, if there is one.
    static func errorText(_ body: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let text = object["error"] as? String, !text.isEmpty else { return nil }
        return text
    }

    private struct IssuedRaw: Decodable {
        struct Credential: Decodable { let id: String?; let label: String? }
        let token: String?
        let credential: Credential?
    }

    /// `redeem`, and an approved `code/token` poll.
    static func issued(_ answer: HTTPAnswer) -> Result<IssuedCredential, ApiError> {
        if let error = failure(for: answer, signed: false) { return .failure(error) }
        guard let raw = try? JSONDecoder().decode(IssuedRaw.self, from: answer.body),
              let token = raw.token, !token.isEmpty else { return .failure(.badResponse) }
        return .success(IssuedCredential(token: token, credentialId: raw.credential?.id, label: raw.credential?.label))
    }

    private struct CodeStartRaw: Decodable {
        let deviceCode: String?
        let userCode: String?
        let expiresIn: Int?
        let interval: Int?
    }

    static func codeStart(_ answer: HTTPAnswer) -> Result<DeviceCodeStart, ApiError> {
        if let error = failure(for: answer, signed: false) { return .failure(error) }
        guard let raw = try? JSONDecoder().decode(CodeStartRaw.self, from: answer.body),
              let deviceCode = raw.deviceCode, !deviceCode.isEmpty,
              let userCode = raw.userCode, !userCode.isEmpty else { return .failure(.badResponse) }
        return .success(DeviceCodeStart(deviceCode: deviceCode, userCode: UserCode.display(userCode),
                                        expiresIn: raw.expiresIn ?? 600, interval: raw.interval ?? 5))
    }

    /// One poll of `code/token`: RFC 8628's error names arrive as HTTP 400 with `{"error": name}`.
    static func pollReply(_ answer: HTTPAnswer) -> DeviceCodeReply {
        if (200..<300).contains(answer.status) { return .approved }
        if answer.status == 429 { return .rateLimited(retryAfter: answer.retryAfter) }
        if answer.status >= 500 { return .networkError }
        switch errorText(answer.body) {
        case "authorization_pending": return .pending
        case "slow_down": return .slowDown
        case "expired_token": return .expired
        case "access_denied": return .denied
        case let other?: return .unknown(other)
        case nil: return .unknown("status \(answer.status)")
        }
    }

    private struct WebSessionRaw: Decodable {
        struct Session: Decodable {
            let cookie: String?
            let value: String?
            let expiresAt: String?
            let maxAgeSeconds: Int?
        }
        let session: Session?
    }

    static func webSession(_ answer: HTTPAnswer) -> Result<WebSessionCookie, ApiError> {
        if let error = failure(for: answer, signed: true) { return .failure(error) }
        guard let raw = try? JSONDecoder().decode(WebSessionRaw.self, from: answer.body),
              let session = raw.session, let name = session.cookie, !name.isEmpty,
              let value = session.value, !value.isEmpty else { return .failure(.badResponse) }
        return .success(WebSessionCookie(name: name, value: value,
                                         expiresAt: session.expiresAt.flatMap(ApiDates.parse),
                                         maxAgeSeconds: session.maxAgeSeconds))
    }
}

/// What to do with a queued location ping after the portal answered (or did not).
enum PingDisposition: Equatable {
    /// Accepted: remove it.
    case sent
    /// Not delivered for a reason that may pass (offline, 5xx, 429, 408): keep it, try again.
    case retryLater
    /// Refused in a way that will not change (bad shape, stale, host not allowed): drop it so it cannot loop.
    case discard
    /// 401: the phone was removed from the portal. Sign out.
    case revoked

    /// `status` is nil when there was no HTTP answer at all.
    static func forStatus(_ status: Int?) -> PingDisposition {
        guard let status else { return .retryLater }
        switch status {
        case 200..<300: return .sent
        case 401: return .revoked
        case 408, 429: return .retryLater
        case 500...: return .retryLater
        default: return .discard
        }
    }
}

/// The device code as the person reads it.
enum UserCode {
    /// Eight letters become `BCDF-GHJK`; anything else is shown as received.
    static func display(_ code: String) -> String {
        let letters = code.uppercased().filter { $0.isLetter }
        guard letters.count == 8, code.filter({ $0.isLetter || $0 == "-" || $0 == " " }).count == code.count else { return code }
        return String(letters.prefix(4)) + "-" + String(letters.suffix(4))
    }
}

/// How signing out went at the portal. The phone signs out locally whatever this is.
enum SignOutRevoke: Equatable {
    /// The portal revoked the credential (or no longer knew it, which comes to the same).
    case revoked
    /// No credential id was kept, so nothing was sent.
    case notAttempted
    /// No answer at all: the phone is offline or the portal is unreachable.
    case offline
    /// The portal answered but did not revoke it.
    case refused

    static func interpret(_ answer: HTTPAnswer?) -> SignOutRevoke {
        guard let answer else { return .offline }
        if (200..<300).contains(answer.status) || answer.status == 401 || answer.status == 404 { return .revoked }
        return .refused
    }

    /// What to tell the person after the local sign-out; nil when the portal confirmed it.
    var notice: String? {
        switch self {
        case .revoked:
            return nil
        case .notAttempted:
            return "Signed out of the app. This phone is still listed on the portal's Devices page; remove it there to end its access."
        case .offline:
            return "Signed out of the app, but the portal could not be reached to remove this phone. It is still listed on the portal's Devices page; remove it there to end its access."
        case .refused:
            return "Signed out of the app, but the portal did not remove this phone. It is still listed on the portal's Devices page; remove it there to end its access."
        }
    }
}
