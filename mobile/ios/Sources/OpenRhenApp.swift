import SwiftUI

@main
struct OpenRhenApp: App {
    @StateObject private var settings: AppSettings
    @StateObject private var location: LocationReporter

    // Built here, not in onAppear: significant-change monitoring relaunches the app in the
    // background with no UI, and the reporter must already exist to receive the reading that woke it.
    init() {
        let settings = AppSettings()
        _settings = StateObject(wrappedValue: settings)
        _location = StateObject(wrappedValue: LocationReporter(settings: settings))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(settings)
                .environmentObject(location)
                .onAppear { ResignReminder.schedule() }
        }
    }
}

struct RootView: View {
    @EnvironmentObject var settings: AppSettings
    @State private var showingSettings = false

    var body: some View {
        Group {
            if let url = settings.portalURL {
                PortalWebView(url: url)
                    .ignoresSafeArea(edges: .bottom)
                    .overlay(alignment: .topTrailing) {
                        Button { showingSettings = true } label: {
                            Image(systemName: "gearshape").padding(10)
                                .background(.ultraThinMaterial, in: Circle())
                        }
                        .padding(8)
                    }
            } else {
                SettingsView()
            }
        }
        .sheet(isPresented: $showingSettings) { SettingsView() }
    }
}
