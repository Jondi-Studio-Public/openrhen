import SwiftUI

@main
struct OpenRhenApp: App {
    @StateObject private var session: AppSession
    @StateObject private var location: LocationReporter
    @Environment(\.scenePhase) private var scenePhase

    // Built here, not in onAppear: significant-change monitoring relaunches the app in the
    // background with no UI, and the reporter must already exist to receive the reading that woke it.
    init() {
        let session = AppSession(api: ApiClient(), store: KeychainCredentialStore())
        _session = StateObject(wrappedValue: session)
        _location = StateObject(wrappedValue: LocationReporter(session: session, file: OutboxFile(directory: OutboxFile.defaultDirectory())))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .environmentObject(location)
                .onAppear { ResignReminder.schedule() }
                .onChange(of: scenePhase) { phase in
                    if phase == .active { location.drain() }
                }
        }
    }
}

struct RootView: View {
    @EnvironmentObject var session: AppSession
    @State private var showingSettings = false

    var body: some View {
        Group {
            if let device = session.auth.session, let url = HostPolicy.httpsURL(device.origin) {
                PortalWebView(url: url, device: device)
                    .id(device.token)
                    .ignoresSafeArea(edges: .bottom)
                    .overlay(alignment: .topTrailing) {
                        Button { showingSettings = true } label: {
                            Image(systemName: "gearshape").padding(10)
                                .background(.ultraThinMaterial, in: Circle())
                        }
                        .padding(8)
                    }
            } else {
                SignInView()
            }
        }
        .sheet(isPresented: $showingSettings) { SettingsView() }
        .onChange(of: session.auth.session?.token) { _ in showingSettings = false }
    }
}
