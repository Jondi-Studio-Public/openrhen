import SwiftUI

@main
struct OpenRhenApp: App {
    @StateObject private var session: AppSession
    @StateObject private var location: LocationReporter
    @StateObject private var live: LiveDay
    @Environment(\.scenePhase) private var scenePhase

    // Built here, not in onAppear: significant-change monitoring relaunches the app in the
    // background with no UI, and the reporter must already exist to receive the reading that woke it.
    init() {
        let session = AppSession(api: ApiClient(), store: KeychainCredentialStore())
        _session = StateObject(wrappedValue: session)
        _location = StateObject(wrappedValue: LocationReporter(session: session, file: OutboxFile(directory: OutboxFile.defaultDirectory())))
        _live = StateObject(wrappedValue: LiveDay(session: session, directory: OutboxFile.defaultDirectory()))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .environmentObject(location)
                .environmentObject(live)
                .onAppear { ResignReminder.schedule() }
                .onChange(of: scenePhase) { phase in
                    if phase == .active {
                        location.drain()
                        live.start()
                    } else if phase == .background {
                        live.stop()
                    }
                }
        }
    }
}

struct RootView: View {
    @EnvironmentObject var session: AppSession

    var body: some View {
        if let device = session.auth.session, let url = HostPolicy.httpsURL(device.origin) {
            LiveRootView(device: device, portalURL: url)
        } else {
            SignInView()
        }
    }
}
