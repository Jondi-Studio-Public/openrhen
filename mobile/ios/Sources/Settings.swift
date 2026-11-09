import Foundation
import Security
import SwiftUI

/// Portal address and the location switch in UserDefaults; the location-ping token and the origin it
/// was saved for only in the Keychain. The token is sent only to that origin: changing the saved
/// address to another origin clears the token and turns reporting off.
final class AppSettings: ObservableObject {
    @Published private(set) var portalURLString: String { didSet { UserDefaults.standard.set(portalURLString, forKey: "portalURL") } }
    @Published var reportLocation: Bool { didSet { UserDefaults.standard.set(reportLocation, forKey: "reportLocation") } }
    @Published private(set) var tokenSaved: Bool
    /// The origin the saved token is bound to (`https://host[:port]`), nil when there is no token.
    @Published private(set) var tokenOrigin: String?
    /// Why the last address or token change did something the person should know about.
    @Published private(set) var addressNotice: String? = nil

    init() {
        let defaults = UserDefaults.standard
        let address = defaults.string(forKey: "portalURL") ?? ""
        var report = defaults.bool(forKey: "reportLocation")
        var origin = Keychain.get(Keychain.originKey)
        var hasToken = !(Keychain.get(Keychain.tokenKey) ?? "").isEmpty
        if hasToken && origin == nil {
            // Token from before origins were stored: bind it to the current https address, else drop it.
            if let bound = HostPolicy.httpsURL(address).flatMap(HostPolicy.origin(of:)),
               Keychain.set(bound, for: Keychain.originKey) {
                origin = bound
            } else {
                Keychain.set("", for: Keychain.tokenKey)
                hasToken = false
                report = false
                defaults.set(false, forKey: "reportLocation")
            }
        }
        portalURLString = address
        reportLocation = report
        tokenSaved = hasToken && origin != nil
        tokenOrigin = hasToken ? origin : nil
    }

    /// Only an https address with a host; a saved http address gives nil.
    var portalURL: URL? { HostPolicy.httpsURL(portalURLString) }

    /// Saves the address. A different origin from the token's clears the token and turns reporting off.
    func saveAddress(_ text: String) {
        guard let url = HostPolicy.httpsURL(text) else {
            addressNotice = "The portal address must start with https://"
            return
        }
        portalURLString = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let bound = tokenOrigin, HostPolicy.origin(of: url) != bound {
            clearToken()
            reportLocation = false
            addressNotice = "Address changed: location reporting is off and the token was cleared."
        } else {
            addressNotice = nil
        }
    }

    /// Binds the token to the saved address's origin. Returns false when there is no https address or the
    /// Keychain refused a write; an empty token clears it.
    @discardableResult
    func saveToken(_ token: String) -> Bool {
        let value = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { clearToken(); return true }
        guard let origin = portalURL.flatMap(HostPolicy.origin(of:)) else { return false }
        guard Keychain.set(value, for: Keychain.tokenKey), Keychain.set(origin, for: Keychain.originKey) else {
            clearToken()
            return false
        }
        tokenSaved = true
        tokenOrigin = origin
        return true
    }

    private func clearToken() {
        Keychain.set("", for: Keychain.tokenKey)
        Keychain.set("", for: Keychain.originKey)
        tokenSaved = false
        tokenOrigin = nil
    }
}

enum Keychain {
    static let tokenKey = "locationPingToken"
    static let originKey = "locationPingTokenOrigin"

    @discardableResult
    static func set(_ value: String, for key: String) -> Bool {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key]
        SecItemDelete(base as CFDictionary)
        guard !value.isEmpty else { return true }
        var item = base
        item[kSecValueData as String] = Data(value.utf8)
        // Readable after the first unlock so a background relaunch can send, and never copied to another device.
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
}

struct SettingsView: View {
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var location: LocationReporter
    @Environment(\.dismiss) private var dismiss
    @State private var addressDraft = ""
    @State private var tokenDraft = ""
    @State private var tokenMessage: String?

    var body: some View {
        NavigationView {
            Form {
                Section("Portal address") {
                    TextField("https://portal.example.com", text: $addressDraft)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        .onSubmit(commitAddress)
                    Button("Save address", action: commitAddress).disabled(!addressChanged)
                    if !settings.portalURLString.isEmpty && settings.portalURL == nil {
                        Text("The saved portal address must start with https://").font(.footnote)
                    }
                    if let notice = settings.addressNotice { Text(notice).font(.footnote) }
                }
                Section("Location") {
                    Toggle("Report place changes", isOn: $settings.reportLocation)
                    SecureField(settings.tokenSaved ? "Token saved (enter a new one to replace)" : "Location ping token",
                                text: $tokenDraft)
                        .onSubmit(commitToken)
                    Button("Save token", action: commitToken).disabled(tokenDraft.isEmpty)
                    if let tokenMessage { Text(tokenMessage).font(.footnote) }
                    if settings.reportLocation, let origin = settings.tokenOrigin {
                        Text("Sending to \(HostPolicy.displayName(ofOrigin: origin))").font(.footnote)
                    }
                    Text(location.status).font(.footnote).foregroundStyle(.secondary)
                }
                Section("Re-signing") {
                    Text(ResignReminder.summary()).font(.footnote)
                }
            }
            .navigationTitle("OpenRhen")
            .toolbar { Button("Done") { dismiss() } }
            .onAppear { addressDraft = settings.portalURLString }
        }
    }

    private var addressChanged: Bool {
        let text = addressDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        return !text.isEmpty && text != settings.portalURLString
    }

    private func commitAddress() {
        guard addressChanged else { return }
        settings.saveAddress(addressDraft)
    }

    private func commitToken() {
        guard !tokenDraft.isEmpty else { return }
        if settings.saveToken(tokenDraft) {
            tokenMessage = "Token saved."
        } else {
            tokenMessage = settings.portalURL == nil ? "Save an https portal address first." : "Could not save token."
        }
        tokenDraft = ""
    }
}
