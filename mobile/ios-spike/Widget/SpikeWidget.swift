import SwiftUI
import WidgetKit

struct Entry: TimelineEntry { let date: Date; let lines: [String] }

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> Entry { Entry(date: Date(), lines: ["spike"]) }
    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) { completion(make()) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        completion(Timeline(entries: [make()], policy: .after(Date().addingTimeInterval(900))))
    }
    private func make() -> Entry { Entry(date: Date(), lines: Probe.run(write: true)) }
}

struct SpikeWidgetView: View {
    let entry: Entry
    var body: some View {
        VStack(alignment: .leading) {
            ForEach(entry.lines.filter { $0.contains("marker") || $0.contains("keychain") || $0.contains("container") }, id: \.self) {
                Text($0).font(.system(size: 8, design: .monospaced))
            }
        }
    }
}

@main
struct SpikeWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "SpikeWidget", provider: Provider()) { SpikeWidgetView(entry: $0) }
            .configurationDisplayName("Spike")
            .description("Signing spike probe.")
            .supportedFamilies([.systemMedium])
    }
}
