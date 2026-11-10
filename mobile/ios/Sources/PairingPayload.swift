import Foundation

/// What the pairing QR holds, as JSON text: `{"v":1,"origin":"https://host","secret":"..."}`.
/// Pure Foundation, so `Checks/main.swift` can compile and run it on the runner.
struct PairingPayload: Equatable {
    /// `https://host[:port]`, lowercased, default port dropped (see `HostPolicy.origin`).
    let origin: String
    let secret: String

    var url: URL? { URL(string: origin) }
    /// `host` or `host:port`, as shown in "Connect to ...?".
    var host: String { HostPolicy.displayName(ofOrigin: origin) }
}

enum PairingPayloadError: Error, Equatable {
    case notAPairingCode
    case unsupportedVersion
    case missingField(String)
    case notHTTPS
    case notAnOrigin
    case unusableHost
    case badSecret

    /// Said to the person, in words, with the next step.
    var message: String {
        switch self {
        case .notAPairingCode:
            return "That is not a code from your portal. Open Devices on a signed-in portal and choose Add a phone."
        case .unsupportedVersion:
            return "This code was made by a different version of the portal. Update the app, or make a new code."
        case .missingField(let name):
            return "The code is incomplete (\(name) is missing). Make a new one from the portal."
        case .notHTTPS:
            return "The portal address must start with https://. The app will not connect over plain http."
        case .notAnOrigin:
            return "The portal address must be just the site, such as https://portal.example.com."
        case .unusableHost:
            return "That address cannot be reached from a phone (localhost, a bare IP address or a one-word name). Use the https name your browser uses."
        case .badSecret:
            return "The code is not valid. Make a new one from the portal."
        }
    }
}

enum PairingPayloadParser {
    static let supportedVersion = 1
    static let maxSecretLength = 200

    private struct Raw: Decodable {
        let v: Int?
        let origin: String?
        let secret: String?
    }

    /// Reads and validates scanned text. Nothing is sent anywhere by this.
    static func parse(_ text: String) -> Result<PairingPayload, PairingPayloadError> {
        guard let data = text.data(using: .utf8),
              let raw = try? JSONDecoder().decode(Raw.self, from: data) else { return .failure(.notAPairingCode) }
        guard let version = raw.v else { return .failure(.missingField("v")) }
        guard version == supportedVersion else { return .failure(.unsupportedVersion) }
        guard let originText = raw.origin, !originText.trimmingCharacters(in: .whitespaces).isEmpty else {
            return .failure(.missingField("origin"))
        }
        guard let secretText = raw.secret, !secretText.isEmpty else { return .failure(.missingField("secret")) }
        let secret = secretText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !secret.isEmpty, secret.count <= maxSecretLength, secret.rangeOfCharacter(from: .whitespacesAndNewlines) == nil else {
            return .failure(.badSecret)
        }
        switch validateOrigin(originText) {
        case .failure(let error): return .failure(PairingPayloadError(error))
        case .success(let origin): return .success(PairingPayload(origin: origin, secret: secret))
        }
    }

    /// An https site address a phone can use: no credentials, path, query or fragment; not localhost, not an IP
    /// address, not a one-word name. The same rules the portal applies before it shows a QR. Returns the
    /// normalised origin (`HostPolicy.origin`).
    static func validateOrigin(_ text: String) -> Result<String, PairingOriginError> {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased() else { return .failure(.notAnOrigin) }
        guard scheme == "https" else { return .failure(.notHTTPS) }
        guard let host = url.host, !host.isEmpty else { return .failure(.notAnOrigin) }
        guard url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else { return .failure(.notAnOrigin) }
        guard isUsableHost(host) else { return .failure(.unusableHost) }
        guard let origin = HostPolicy.origin(of: url) else { return .failure(.notAnOrigin) }
        return .success(origin)
    }

    static func isUsableHost(_ rawHost: String) -> Bool {
        var host = rawHost.lowercased()
        while host.hasSuffix(".") { host.removeLast() }
        if host.isEmpty || host.hasPrefix("[") || host.contains(":") { return false }
        if host == "localhost" || host.hasSuffix(".localhost") { return false }
        if isIPv4Literal(host) { return false }
        return host.contains(".")
    }

    private static func isIPv4Literal(_ host: String) -> Bool {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        return parts.allSatisfy { part in
            !part.isEmpty && part.count <= 3 && part.unicodeScalars.allSatisfy { $0.value >= 48 && $0.value <= 57 }
        }
    }
}

/// Origin errors share the payload's wording; a distinct type keeps the typed-address screen from handling
/// payload-only cases.
enum PairingOriginError: Error, Equatable {
    case notHTTPS
    case notAnOrigin
    case unusableHost

    var message: String {
        switch self {
        case .notHTTPS: return PairingPayloadError.notHTTPS.message
        case .notAnOrigin: return PairingPayloadError.notAnOrigin.message
        case .unusableHost: return PairingPayloadError.unusableHost.message
        }
    }
}

extension PairingPayloadError {
    init(_ error: PairingOriginError) {
        switch error {
        case .notHTTPS: self = .notHTTPS
        case .notAnOrigin: self = .notAnOrigin
        case .unusableHost: self = .unusableHost
        }
    }
}

/// The name the person gives this phone (the portal lists it under Devices).
enum DeviceName {
    static let maxLength = 60
    static let fallback = "Phone"

    /// Trimmed and cut to the portal's limit (counted in UTF-16 units, as the portal counts); empty becomes `fallback`.
    static func clean(_ typed: String) -> String {
        var text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        while text.utf16.count > maxLength { text.removeLast() }
        text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? fallback : text
    }
}

/// The phone's own random key, kept in the Keychain. Lowercase, 8 to 64 characters, the portal's `deviceKey` shape.
enum InstallId {
    static func isValid(_ text: String) -> Bool {
        let scalars = Array(text.unicodeScalars)
        guard scalars.count >= 8, scalars.count <= 64 else { return false }
        func alnum(_ s: Unicode.Scalar) -> Bool { (s.value >= 97 && s.value <= 122) || (s.value >= 48 && s.value <= 57) }
        guard alnum(scalars[0]) else { return false }
        return scalars.dropFirst().allSatisfy { alnum($0) || $0 == "_" || $0 == "-" }
    }

    /// 16 random bytes as 32 lowercase hex characters.
    static func make(from bytes: [UInt8]) -> String {
        bytes.map { byte -> String in
            let hex = String(byte, radix: 16)
            return hex.count == 1 ? "0" + hex : hex
        }.joined()
    }

    static func generate() -> String {
        var generator = SystemRandomNumberGenerator()
        var bytes: [UInt8] = []
        for _ in 0..<16 { bytes.append(UInt8.random(in: 0...255, using: &generator)) }
        return make(from: bytes)
    }
}
