import Foundation

/// The phone's own sign-in: the owner token the portal issued and the origin it came from. They are stored
/// together and only ever sent to that origin.
struct DeviceSession: Codable, Equatable {
    let token: String
    /// `https://host[:port]` (see `HostPolicy.origin`).
    let origin: String
}

/// Where the token and the install id live. Slice 1 keeps both in the app's own Keychain (no shared access
/// group: whether one survives free signing is unverified), behind this protocol so a shared group can be
/// switched on later without touching callers.
protocol CredentialStore: AnyObject {
    func loadSession() -> DeviceSession?
    /// False when the store refused the write (the caller must not treat the phone as signed in).
    @discardableResult func saveSession(_ session: DeviceSession) -> Bool
    /// Forgets the token. The install id stays, so a re-added phone keeps its slot.
    func clearSession()
    /// The random lowercase key naming this phone; created on first use and then stable.
    func installId() -> String
}

/// The test double: the same behaviour with no Keychain.
final class InMemoryCredentialStore: CredentialStore {
    private(set) var session: DeviceSession?
    private var storedInstallId: String?
    /// Set to make `saveSession` fail, like a Keychain that refuses a write.
    var refuseWrites = false

    init(session: DeviceSession? = nil, installId: String? = nil) {
        self.session = session
        self.storedInstallId = installId
    }

    func loadSession() -> DeviceSession? { session }

    @discardableResult
    func saveSession(_ session: DeviceSession) -> Bool {
        guard !refuseWrites else { return false }
        self.session = session
        return true
    }

    func clearSession() { session = nil }

    func installId() -> String {
        if let storedInstallId { return storedInstallId }
        let made = InstallId.generate()
        storedInstallId = made
        return made
    }
}
