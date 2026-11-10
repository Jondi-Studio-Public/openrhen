import Foundation
import Security

/// The phone's token and install id in the app's own Keychain (no shared access group: whether one survives
/// free signing is unverified). The token item is readable after the first unlock and never copied to another
/// device, so a background relaunch can send and a backup restore cannot carry it away.
final class KeychainCredentialStore: CredentialStore {
    private static let sessionKey = "deviceSession"
    private static let installIdKey = "installId"
    /// Items the earlier token-paste app kept; they are removed on first run so no old secret lingers.
    private static let legacyKeys = ["locationPingToken", "locationPingTokenOrigin"]
    private static let legacyDefaults = ["portalURL", "reportLocation"]

    init() {
        for key in KeychainCredentialStore.legacyKeys { Keychain.delete(key) }
        for key in KeychainCredentialStore.legacyDefaults { UserDefaults.standard.removeObject(forKey: key) }
    }

    func loadSession() -> DeviceSession? {
        guard let text = Keychain.get(KeychainCredentialStore.sessionKey), let data = text.data(using: .utf8),
              let session = try? JSONDecoder().decode(DeviceSession.self, from: data),
              !session.token.isEmpty, HostPolicy.httpsURL(session.origin) != nil else { return nil }
        return session
    }

    @discardableResult
    func saveSession(_ session: DeviceSession) -> Bool {
        guard let data = try? JSONEncoder().encode(session), let text = String(data: data, encoding: .utf8) else { return false }
        return Keychain.set(text, for: KeychainCredentialStore.sessionKey)
    }

    func clearSession() { Keychain.delete(KeychainCredentialStore.sessionKey) }

    func installId() -> String {
        if let existing = Keychain.get(KeychainCredentialStore.installIdKey), InstallId.isValid(existing) { return existing }
        let made = InstallId.generate()
        Keychain.set(made, for: KeychainCredentialStore.installIdKey)
        return made
    }
}

enum Keychain {
    @discardableResult
    static func set(_ value: String, for key: String) -> Bool {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key]
        SecItemDelete(base as CFDictionary)
        guard !value.isEmpty else { return true }
        var item = base
        item[kSecValueData as String] = Data(value.utf8)
        // Readable after the first unlock (a relaunch while the phone is locked is unverified), and never copied to another device.
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    static func get(_ key: String) -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key,
                                    kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete(_ key: String) {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key]
        SecItemDelete(base as CFDictionary)
    }
}
