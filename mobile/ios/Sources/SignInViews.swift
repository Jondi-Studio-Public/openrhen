import SwiftUI
import UIKit

/// First thing a phone shows until it is paired: scan the code on the portal's Devices page, or use a typed code.
struct SignInView: View {
    @EnvironmentObject var session: AppSession
    @State private var name = ""
    @State private var scanning = false
    @State private var pending: PairingPayload?
    @State private var message: String?
    @State private var busy = false

    var body: some View {
        NavigationView {
            Form {
                if let notice = session.auth.notice {
                    Section {
                        Text(notice).font(.headline)
                        Text("Add it again below, and remove the old entry from the portal's Devices page.").font(.footnote)
                    }
                }
                if let payload = pending {
                    confirmSection(payload)
                } else {
                    addSection
                }
                if let message {
                    Section { Text(message).font(.footnote).foregroundColor(.red) }
                }
                if pending == nil {
                    Section(header: Text("No signed-in screen to hand?")) {
                        NavigationLink("Use a typed code instead") { CodeSignInView(name: name) }
                    }
                }
            }
            .navigationTitle("Add this phone")
            .onAppear { if name.isEmpty { name = UIDevice.current.model } }
        }
        .navigationViewStyle(.stack)
        .fullScreenCover(isPresented: $scanning) {
            ScanCover(onCode: handleScanned, onCancel: { scanning = false })
        }
    }

    private var addSection: some View {
        Section(header: Text("Scan the code from your portal"),
                footer: Text("On a screen where you are already signed in to your portal, open Devices and choose Add a phone. Nothing needs to be typed or pasted here.")) {
            TextField("Name for this phone", text: $name)
            Button("Scan the code") {
                message = nil
                scanning = true
            }
        }
    }

    private func confirmSection(_ payload: PairingPayload) -> some View {
        Section(header: Text("Connect to \(payload.host)?"),
                footer: Text("Only connect if you started this on your own portal just now. Your location and plan will be sent to this server.")) {
            Text(payload.host).font(.title3).bold()
            Button(busy ? "Connecting..." : "Connect") { connect(payload) }.disabled(busy)
            Button("Cancel", role: .cancel) { pending = nil }.disabled(busy)
        }
    }

    private func handleScanned(_ text: String) {
        scanning = false
        switch PairingPayloadParser.parse(text) {
        case .success(let payload):
            message = nil
            pending = payload
        case .failure(let error):
            message = error.message
        }
    }

    private func connect(_ payload: PairingPayload) {
        busy = true
        message = nil
        Task { @MainActor in
            let failure = await session.pair(with: payload, name: name)
            busy = false
            if let failure {
                message = failure
                pending = nil
            }
        }
    }
}

private struct ScanCover: View {
    let onCode: (String) -> Void
    let onCancel: () -> Void
    @State private var problem: String?

    var body: some View {
        ZStack(alignment: .top) {
            QRScannerView(onCode: onCode, onUnavailable: { problem = $0 }).ignoresSafeArea()
            VStack(spacing: 12) {
                HStack {
                    Spacer()
                    Button("Cancel", action: onCancel)
                        .padding(10).background(.ultraThinMaterial, in: Capsule())
                }
                if let problem {
                    Text(problem).font(.footnote).padding(12).background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
                    Button("Open Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                    }
                } else {
                    Text("Point the camera at the code on your portal").font(.footnote)
                        .padding(8).background(.ultraThinMaterial, in: Capsule())
                }
            }
            .padding(16)
        }
    }
}

/// The fallback for a phone with no signed-in screen nearby: type the portal's address, read out the 8-letter
/// code, approve it on any signed-in portal.
struct CodeSignInView: View {
    let name: String
    @EnvironmentObject var session: AppSession
    @State private var address = ""
    @State private var confirmed: String?
    @State private var shownCode: DeviceCodeStart?
    @State private var message: String?
    @State private var working: Task<Void, Never>?

    var body: some View {
        Form {
            if let start = shownCode {
                waitingSection(start)
            } else if let origin = confirmed {
                Section(header: Text("Connect to \(HostPolicy.displayName(ofOrigin: origin))?"),
                        footer: Text("Only connect to your own portal.")) {
                    Button("Get a code") { begin(origin) }
                    Button("Cancel", role: .cancel) { confirmed = nil }
                }
            } else {
                Section(header: Text("Your portal's address"), footer: Text("It must start with https://.")) {
                    TextField("https://portal.example.com", text: $address)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        .onSubmit(check)
                    Button("Continue", action: check).disabled(address.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            if let message {
                Section { Text(message).font(.footnote).foregroundColor(.red) }
            }
        }
        .navigationTitle("Typed code")
        .onDisappear { working?.cancel() }
    }

    private func waitingSection(_ start: DeviceCodeStart) -> some View {
        Section(header: Text("Your code"),
                footer: Text("On a portal where you are signed in, open Devices, choose Enter a code and type this. Approve only a code shown on a phone in your hand.")) {
            Text(start.userCode)
                .font(.system(size: 34, weight: .semibold, design: .monospaced))
                .frame(maxWidth: .infinity)
            HStack {
                ProgressView()
                Text("Waiting for you to approve it").font(.footnote)
            }
            Button("Cancel", role: .cancel) {
                working?.cancel()
                shownCode = nil
                confirmed = nil
            }
        }
    }

    private func check() {
        message = nil
        switch PairingPayloadParser.validateOrigin(address) {
        case .success(let origin): confirmed = origin
        case .failure(let error): message = error.message
        }
    }

    private func begin(_ origin: String) {
        message = nil
        working?.cancel()
        working = Task { @MainActor in
            switch await session.requestCode(origin: origin, name: name) {
            case .failure(let error):
                message = error.message
                confirmed = nil
            case .success(let start):
                shownCode = start
                let outcome = await session.waitForApproval(origin: origin, start: start)
                switch outcome {
                case .signedIn, .cancelled:
                    break
                case .failed(let words):
                    message = words
                    shownCode = nil
                    confirmed = nil
                }
            }
        }
    }
}
