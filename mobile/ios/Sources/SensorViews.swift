import SwiftUI

/// The sensor part of the Sources screen: what the phone reads and sends, what is waiting, what the server refused, and
/// how often iOS has actually woken the app. Only local facts: the portal has no route yet that says when it last heard
/// from this phone, and the screen says so.
struct SensorSections: View {
    let now: Date
    let zone: TimeZone
    @EnvironmentObject var sensors: SensorCenter

    var body: some View {
        let queue = SensorWords.queue(sensors.state, now: now)
        let wakeLines = SensorWords.wakes(sensors.state.wakes, zone: zone)
        Group {
            Section(header: Text("Health and the phone's alive signal")) {
                Text(sensors.healthStatus)
                if let note = sensors.backgroundNote { Text(note).font(.footnote).foregroundStyle(.secondary) }
                Text("The app also sends an alive signal each time it wakes, at most one an hour, so your server can tell a quiet phone from a stopped app. If your server does not accept it yet, it is listed under Refused.")
                    .font(.footnote)
                Text("Place fixes, motion and phone events are not collected yet: your server has no place to keep them. Place changes still go to the location report above.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            Section(header: Text("Sensor data waiting to send")) {
                Text(queue.headline)
                if let warning = queue.warning { Text(warning).font(.footnote).foregroundStyle(.orange) }
                Text(SensorWords.serverSide).font(.footnote).foregroundStyle(.secondary)
            }
            Section(header: Text("How often iOS wakes the app")) {
                if wakeLines.isEmpty {
                    Text(SensorWords.noWakesYet).font(.footnote)
                } else {
                    ForEach(wakeLines, id: \.self) { line in Text(line).font(.footnote) }
                }
            }
            if !sensors.state.setAside.isEmpty {
                Section(header: Text("Refused by your server")) {
                    Text(SensorWords.setAsideNote).font(.footnote).foregroundStyle(.secondary)
                    ForEach(Array(sensors.state.setAside.enumerated()), id: \.offset) { _, row in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(SensorWords.setAsideLine(row, zone: zone))
                            Text(row.message).font(.footnote).foregroundStyle(.orange)
                        }
                    }
                    Button("Clear this list") { sensors.clearSetAside() }
                }
            }
        }
    }
}
