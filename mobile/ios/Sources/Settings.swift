import SwiftUI

/// What the phone is connected to, the location state, the re-sign note and a way to remove the phone from the
/// app. There is nothing to paste: the sign-in is the token the portal issued when the phone was added.
struct SettingsView: View {
    @EnvironmentObject var session: AppSession
    @EnvironmentObject var location: LocationReporter
    @Environment(\.dismiss) private var dismiss
    @State private var confirmingSignOut = false

    var body: some View {
        NavigationView {
            Form {
                Section(header: Text("Connected to")) {
                    if let device = session.auth.session {
                        Text(HostPolicy.displayName(ofOrigin: device.origin))
                    } else {
                        Text("Not connected")
                    }
                    Text("Removing the phone here also revokes it on the portal. You can revoke it from the portal's Devices page too.").font(.footnote)
                }
                Section(header: Text("Location")) {
                    Text(location.status).font(.footnote).foregroundStyle(.secondary)
                    Text("Place changes are sent to your portal with this phone's sign-in. Turn location off in the system Settings if you do not want that.")
                        .font(.footnote)
                }
                Section(header: Text("Re-signing")) {
                    Text(ResignReminder.summary()).font(.footnote)
                }
                Section {
                    Button("Remove this phone from the app", role: .destructive) { confirmingSignOut = true }
                }
            }
            .navigationTitle("OpenRhen")
            .toolbar { Button("Done") { dismiss() } }
            .confirmationDialog("Remove this phone from the app?", isPresented: $confirmingSignOut, titleVisibility: .visible) {
                Button("Remove", role: .destructive) {
                    Task { @MainActor in
                        await session.signOut()
                        dismiss()
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("The phone first asks the portal to remove it. If it cannot reach the portal, it still signs out here and stays listed on the Devices page until you remove it there.")
            }
        }
    }
}
