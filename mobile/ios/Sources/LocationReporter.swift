import Combine
import CoreLocation
import Foundation
import UIKit

/// Sends place changes to `POST /api/location/ping` (docs/operations/location-ping.md). Significant-change monitoring needs only "Always" permission. Whether iOS
/// relaunches the app for it is unverified on a phone (no background modes are set), so this object is
/// created at launch (see OpenRhenApp.init) in case it does.
/// The portal decides what a reading means; this only reports it. Coordinates are never logged.
/// A failed POST is dropped, not retried; the next place change sends a fresh reading.
final class LocationReporter: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published var status = "Off"
    private let manager = CLLocationManager()
    private let settings: AppSettings
    private var subscription: AnyCancellable?
    private var lastSent = Date.distantPast
    /// Redirects are refused, so the bearer token never follows a 3xx to another host.
    private let session = URLSession(configuration: .ephemeral, delegate: RefuseRedirects(), delegateQueue: nil)

    init(settings: AppSettings) {
        self.settings = settings
        super.init()
        manager.delegate = self
        subscription = settings.$reportLocation.removeDuplicates().sink { [weak self] _ in self?.apply() }
    }

    private func apply() {
        guard settings.reportLocation else {
            manager.stopMonitoringSignificantLocationChanges()
            status = "Off"
            return
        }
        switch manager.authorizationStatus {
        case .notDetermined: manager.requestAlwaysAuthorization(); status = "Waiting for permission"
        case .authorizedAlways: manager.startMonitoringSignificantLocationChanges(); status = "Reporting place changes"
        case .authorizedWhenInUse: manager.requestAlwaysAuthorization(); status = "Needs Always permission (Settings > OpenRhen > Location)"
        default: status = "Location permission denied"
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) { apply() }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let fix = locations.last else { return }
        let now = Date()
        guard Policies.mayReport(now: now, lastSent: lastSent) else { return }
        let token = Keychain.get(Keychain.tokenKey)
        // The token goes only to the address it was saved for, so repointing the address cannot redirect it.
        let url: URL
        switch Policies.sendDecision(portal: settings.portalURL, token: token, boundOrigin: Keychain.get(Keychain.originKey)) {
        case .send(let target): url = target
        case .notConfigured:
            report("Set the portal address and token to report")
            return
        case .notHTTPS:
            report("The token only travels over https")
            return
        case .originMismatch(let bound):
            report("Token was saved for \(HostPolicy.displayName(ofOrigin: bound)); save it again for this address")
            return
        }
        guard let token else { return }
        lastSent = now
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = [
            "latitude": fix.coordinate.latitude,
            "longitude": fix.coordinate.longitude,
            "accuracyMeters": max(fix.horizontalAccuracy, 0),
            "observedAt": ISO8601DateFormatter().string(from: fix.timestamp),
        ]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        var task = UIBackgroundTaskIdentifier.invalid
        task = UIApplication.shared.beginBackgroundTask { UIApplication.shared.endBackgroundTask(task) }
        session.dataTask(with: request) { [weak self] _, response, _ in
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            self?.report(code == 200 ? "Last report sent" : "Last report failed (\(code))")
            UIApplication.shared.endBackgroundTask(task)
        }.resume()
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) { report("Location error") }

    private func report(_ text: String) { DispatchQueue.main.async { self.status = text } }
}

private final class RefuseRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(Policies.redirectTarget(request))
    }
}
