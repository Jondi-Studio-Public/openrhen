import Foundation
import SwiftUI
import WebKit

/// How a typed-code sign-in ended.
enum CodeSignInOutcome: Equatable {
    case signedIn
    case failed(String)
    case cancelled
}

/// The signed-in state the screens watch, over `SessionCore` and the network. Mutating calls run on the main actor.
final class AppSession: ObservableObject {
    @Published private(set) var auth: AuthState
    let api: ApiClient
    private let core: SessionCore

    init(api: ApiClient, store: CredentialStore) {
        self.api = api
        let core = SessionCore(store: store)
        self.core = core
        self.auth = core.state
        // Every call into `core` is made on the main actor, so these run on the main thread too.
        core.onChange = { [weak self] state in self?.auth = state }
        core.onSignedOut = {
            // Nothing from the ended session stays in the web view.
            let store = WKWebsiteDataStore.default()
            store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: Date.distantPast) {}
        }
    }

    var installId: String { core.installId() }

    /// Redeems the QR's secret. Returns the words to show on failure, nil on success.
    @MainActor
    func pair(with payload: PairingPayload, name: String) async -> String? {
        let result = await api.redeem(origin: payload.origin, secret: payload.secret, name: name, installId: installId)
        switch result {
        case .failure(let error):
            return error.message
        case .success(let issued):
            guard core.complete(token: issued.token, origin: payload.origin) else {
                return "The phone could not keep the sign-in (its secure storage refused it). Try again."
            }
            return nil
        }
    }

    /// Asks the portal for a code to be approved on a signed-in screen.
    @MainActor
    func requestCode(origin: String, name: String) async -> Result<DeviceCodeStart, ApiError> {
        await api.startDeviceCode(origin: origin, name: name, installId: installId)
    }

    /// Polls until the code is approved, refused, expired or the task is cancelled. Honours `slow_down`.
    @MainActor
    func waitForApproval(origin: String, start: DeviceCodeStart) async -> CodeSignInOutcome {
        var poller = DeviceCodePoller(interval: start.interval, expiresIn: start.expiresIn, now: Date())
        var wait = TimeInterval(max(start.interval, 1))
        while true {
            do { try await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000)) } catch { return .cancelled }
            if Task.isCancelled { return .cancelled }
            let (reply, issued) = await api.pollDeviceCode(origin: origin, deviceCode: start.deviceCode)
            if Task.isCancelled { return .cancelled }
            switch poller.record(reply, now: Date()) {
            case .wait(let seconds):
                wait = seconds
            case .failed(let failure):
                return .failed(failure.message)
            case .approved:
                guard let issued else { return .failed(DeviceCodeFailure.unexpected("no token").message) }
                guard core.complete(token: issued.token, origin: origin) else {
                    return .failed("The phone could not keep the sign-in (its secure storage refused it). Try again.")
                }
                return .signedIn
            }
        }
    }

    /// The portal answered 401 to a call that carried `token`: the phone was removed there.
    @MainActor
    func tokenRejected(_ token: String) { core.tokenRejected(token) }

    /// The person chose to remove the phone from the app. (The portal's Devices page still lists it until removed there.)
    @MainActor
    func signOut() { core.signOut() }

    @MainActor
    func dismissNotice() { core.dismissNotice() }
}
