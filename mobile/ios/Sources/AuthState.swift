import Foundation

/// Whether the phone is paired, and the note to show when it just stopped being. Pure.
struct AuthState: Equatable {
    static let removedNotice = "This phone was removed from the portal"

    var session: DeviceSession?
    var notice: String?
}

/// Pairing state over a `CredentialStore`. The rules: a 401 on a call that carried the current token signs the
/// phone out and says why; a 401 for an older token (a request still in flight when the phone was paired
/// again) changes nothing; signing out keeps the install id.
final class SessionCore {
    private let store: CredentialStore
    private(set) var state: AuthState
    /// Called after every change to `state`.
    var onChange: ((AuthState) -> Void)?
    /// Called once each time a session ends (rejected or chosen), to clear everything that belonged to it.
    var onSignedOut: (() -> Void)?

    init(store: CredentialStore) {
        self.store = store
        self.state = AuthState(session: store.loadSession(), notice: nil)
    }

    func installId() -> String { store.installId() }

    /// Keeps a freshly issued token. False (and still signed out) when the store refused to keep it.
    @discardableResult
    func complete(token: String, origin: String) -> Bool {
        let session = DeviceSession(token: token, origin: origin)
        guard store.saveSession(session) else { return false }
        set(AuthState(session: session, notice: nil))
        return true
    }

    /// The portal answered 401 to a call that carried `token`.
    func tokenRejected(_ token: String) {
        guard let current = state.session, current.token == token else { return }
        end(notice: AuthState.removedNotice)
    }

    /// The person chose to remove the phone from the app.
    func signOut() {
        guard state.session != nil else { return }
        end(notice: nil)
    }

    func dismissNotice() {
        guard state.notice != nil else { return }
        var next = state
        next.notice = nil
        set(next)
    }

    private func end(notice: String?) {
        store.clearSession()
        set(AuthState(session: nil, notice: notice))
        onSignedOut?()
    }

    private func set(_ next: AuthState) {
        state = next
        onChange?(next)
    }
}
