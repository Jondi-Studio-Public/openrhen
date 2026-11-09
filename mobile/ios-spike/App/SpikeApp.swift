import SwiftUI
import WidgetKit

@main
struct SpikeApp: App {
    var body: some Scene { WindowGroup { ContentView() } }
}

struct ContentView: View {
    @State private var lines: [String] = []
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text("OpenRhen signing spike").font(.title2).bold()
                Text("1. Tap Write and read. 2. Add the widget to the Home Screen and the lock screen. 3. Share some text to 'Spike' from Safari. 4. Come back here, tap Read only, and photograph the screen.")
                    .font(.footnote)
                HStack {
                    Button("Write and read") { lines = Probe.run(write: true); WidgetCenter.shared.reloadAllTimelines() }
                    Button("Read only") { lines = Probe.run(write: false) }
                }.buttonStyle(.borderedProminent)
                ForEach(lines, id: \.self) { Text($0).font(.system(.footnote, design: .monospaced)) }
            }.padding()
        }
        .onAppear { lines = Probe.run(write: false) }
    }
}
