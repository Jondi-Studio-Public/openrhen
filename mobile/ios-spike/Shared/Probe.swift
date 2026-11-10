import Foundation
import Security

/// Signing-spike probe (slice 0.5). Reports whether App Groups and Keychain groups survive free-account sideload signing.
enum Probe {
    /// The app's own bundle id, whichever process asks (extensions drop their last component).
    static var baseBundleId: String {
        let id = Bundle.main.bundleIdentifier ?? "unknown"
        if Bundle.main.bundleURL.pathExtension == "appex" {
            return id.split(separator: ".").dropLast().joined(separator: ".")
        }
        return id
    }
    /// The group name the design derives at run time from the signed bundle id.
    static var derivedGroup: String { "group." + baseBundleId }
    /// The group name written into the entitlements at build time.
    static let originalGroup = "group.org.openrhen.spike"

    static var me: String { Bundle.main.bundleURL.pathExtension == "appex" ? "extension" : "app" }

    static func groupDefaults(_ name: String) -> UserDefaults? { UserDefaults(suiteName: name) }

    /// Team id prefix, found by adding a throwaway item with no group and reading back its default group.
    static func teamPrefix() -> String? {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                   kSecAttrService as String: "spike-probe", kSecAttrAccount as String: "prefix-" + me]
        SecItemDelete(base as CFDictionary)
        var add = base; add[kSecValueData as String] = Data("x".utf8)
        guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { return nil }
        var q = base; q[kSecReturnAttributes as String] = true
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let attrs = out as? [String: Any], let g = attrs[kSecAttrAccessGroup as String] as? String else { return nil }
        return g.split(separator: ".").first.map(String.init)
    }

    static func keychainWrite(group: String, account: String, value: String) -> OSStatus {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "spike-shared",
                                   kSecAttrAccount as String: account, kSecAttrAccessGroup as String: group]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil)
    }

    static func keychainRead(group: String, account: String) -> String {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "spike-shared",
                                kSecAttrAccount as String: account, kSecAttrAccessGroup as String: group,
                                kSecReturnData as String: true]
        var out: CFTypeRef?
        let s = SecItemCopyMatching(q as CFDictionary, &out)
        if s == errSecSuccess, let d = out as? Data { return String(decoding: d, as: UTF8.self) }
        return "none (status \(s))"
    }

    /// Writes this process's marker to the group defaults and the shared keychain group, then reads everyone's.
    static func run(write: Bool) -> [String] {
        var lines = ["process: \(me)", "bundle id: \(Bundle.main.bundleIdentifier ?? "nil")", "derived group: \(derivedGroup)"]
        let stamp = ISO8601DateFormatter().string(from: Date())
        for name in [derivedGroup, originalGroup] {
            let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: name)
            lines.append("group \(name): container " + (container == nil ? "NO" : "yes"))
            if let d = groupDefaults(name), container != nil {
                if write { d.set(me + " " + stamp, forKey: "marker-" + me) }
                lines.append("  app marker: \(d.string(forKey: "marker-app") ?? "none")")
                lines.append("  extension marker: \(d.string(forKey: "marker-extension") ?? "none")")
            }

        }
        guard let team = teamPrefix() else { lines.append("keychain: could not find team prefix"); return lines }
        lines.append("team prefix: \(team)")
        let group = team + "." + baseBundleId
        if write { lines.append("keychain write (\(group)): status \(keychainWrite(group: group, account: me, value: me + " " + stamp))") }
        lines.append("  keychain app: \(keychainRead(group: group, account: "app"))")
        lines.append("  keychain extension: \(keychainRead(group: group, account: "extension"))")
        return lines
    }
}
