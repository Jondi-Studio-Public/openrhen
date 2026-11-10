import Foundation

/// The network side of the contract in `ApiContract.swift`: sends the pure requests, turns the answers into
/// typed results. Redirects are refused, so the owner token never follows a 3xx to another host.
final class ApiClient {
    private let session = URLSession(configuration: .ephemeral)

    /// Sends `request`; `.unreachable` when there is no HTTP answer at all.
    func send(_ request: URLRequest) async -> HTTPAnswer? {
        do {
            let (data, response) = try await session.data(for: request, delegate: RefuseRedirects())
            guard let http = response as? HTTPURLResponse else { return nil }
            return HTTPAnswer(status: http.statusCode, body: data, retryAfter: Int(http.value(forHTTPHeaderField: "Retry-After") ?? ""),
                              etag: http.value(forHTTPHeaderField: "ETag"))
        } catch {
            return nil
        }
    }

    func redeem(origin: String, secret: String, name: String, installId: String) async -> Result<IssuedCredential, ApiError> {
        guard let request = ApiRequests.redeem(origin: origin, secret: secret, name: name, installId: installId) else {
            return .failure(.badResponse)
        }
        guard let answer = await send(request) else { return .failure(.unreachable) }
        return ApiResponses.issued(answer)
    }

    func startDeviceCode(origin: String, name: String, installId: String) async -> Result<DeviceCodeStart, ApiError> {
        guard let request = ApiRequests.codeStart(origin: origin, name: name, installId: installId) else {
            return .failure(.badResponse)
        }
        guard let answer = await send(request) else { return .failure(.unreachable) }
        return ApiResponses.codeStart(answer)
    }

    /// One poll. An approved poll also carries the issued credential.
    func pollDeviceCode(origin: String, deviceCode: String) async -> (reply: DeviceCodeReply, issued: IssuedCredential?) {
        guard let request = ApiRequests.codePoll(origin: origin, deviceCode: deviceCode) else {
            return (.unknown("bad request"), nil)
        }
        guard let answer = await send(request) else { return (.networkError, nil) }
        let reply = ApiResponses.pollReply(answer)
        guard reply == .approved else { return (reply, nil) }
        switch ApiResponses.issued(answer) {
        case .success(let issued): return (.approved, issued)
        case .failure: return (.unknown("unreadable approval"), nil)
        }
    }

    func webSession(origin: String, token: String) async -> Result<WebSessionCookie, ApiError> {
        guard let request = ApiRequests.webSession(origin: origin, token: token) else { return .failure(.badResponse) }
        guard let answer = await send(request) else { return .failure(.unreachable) }
        return ApiResponses.webSession(answer)
    }

    func sendPing(origin: String, token: String, installId: String, ping: QueuedPing) async -> PingDisposition {
        guard let request = ApiRequests.locationPing(origin: origin, token: token, installId: installId, ping: ping) else {
            return .discard
        }
        guard let answer = await send(request) else { return .retryLater }
        return PingDisposition.forStatus(answer.status)
    }

    /// One batch of sensor rows to `POST /api/activity-events`, answered in the terms the sensor queue works in.
    func sendSensorBatch(origin: String, token: String, installId: String, events: [SensorEvent]) async -> SensorReply {
        guard let request = ApiRequests.activityEvents(origin: origin, token: token, installId: installId, events: events) else {
            return .refused("The app could not build this request for your server's address.")
        }
        guard let answer = await send(request) else { return .retry(after: nil, note: ApiError.unreachable.message) }
        return SensorReply.interpret(answer)
    }
}

/// Refuses every redirect (see `Policies.redirectTarget`).
final class RefuseRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(Policies.redirectTarget(request))
    }
}
