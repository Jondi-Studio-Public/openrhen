import Foundation

/// Pure URL rules, kept free of UIKit so `Checks/main.swift` can compile and run them on the runner.
enum HostPolicy {
    /// True when `url` is the portal's own origin (scheme, host and effective port) or `about:blank`.
    static func isPortalOrigin(_ url: URL, portal: URL) -> Bool {
        if url.absoluteString == "about:blank" { return true }
        guard let scheme = url.scheme?.lowercased(), scheme == portal.scheme?.lowercased(),
              let host = url.host?.lowercased(), host == portal.host?.lowercased() else { return false }
        return effectivePort(url) == effectivePort(portal)
    }

    private static func effectivePort(_ url: URL) -> Int? {
        if let port = url.port { return port }
        switch url.scheme?.lowercased() {
        case "http": return 80
        case "https": return 443
        default: return nil
        }
    }

    /// The bearer token only travels over https.
    static func mayCarryToken(to url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https", let host = url.host, !host.isEmpty else { return false }
        return true
    }

    /// The portal address as typed: an https URL with a host, or nil (http and other schemes are refused).
    static func httpsURL(_ text: String) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), url.scheme?.lowercased() == "https",
              let host = url.host, !host.isEmpty else { return nil }
        return url
    }

    /// `https://host` or `https://host:port`, lowercased, default port 443 dropped; nil unless https with a host.
    /// What a saved token is bound to: path, query and fragment never count.
    static func origin(of url: URL) -> String? {
        guard url.scheme?.lowercased() == "https", let host = url.host?.lowercased(), !host.isEmpty else { return nil }
        let name = host.contains(":") ? "[\(host)]" : host
        let port = effectivePort(url) ?? 443
        return port == 443 ? "https://\(name)" : "https://\(name):\(port)"
    }

    /// An origin as shown to the person: `host` or `host:port`.
    static func displayName(ofOrigin origin: String) -> String {
        origin.replacingOccurrences(of: "https://", with: "")
    }

    /// `/api/location/ping` on the portal's origin; never relative, never inherits the portal's path.
    static func pingURL(portal: URL) -> URL? {
        guard var parts = URLComponents(url: portal, resolvingAgainstBaseURL: true) else { return nil }
        parts.path = "/api/location/ping"
        parts.query = nil
        parts.fragment = nil
        return parts.url
    }
}
