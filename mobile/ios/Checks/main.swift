import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// Compiled with the pure files in Sources/ (see ci-build.sh) by CI (`swiftc`); exits non-zero on the first failure.
var failures = 0
func check(_ ok: Bool, _ name: String) {
    if !ok { failures += 1; print("FAIL: \(name)") }
}
func u(_ s: String) -> URL { URL(string: s)! }

let portal = u("https://portal.example.com:3000/now")
check(HostPolicy.isPortalOrigin(u("https://portal.example.com:3000/plan?x=1"), portal: portal), "same origin path")
check(HostPolicy.isPortalOrigin(u("HTTPS://PORTAL.EXAMPLE.COM:3000/"), portal: portal), "case-insensitive")
check(HostPolicy.isPortalOrigin(u("about:blank"), portal: portal), "about:blank")
check(!HostPolicy.isPortalOrigin(u("https://portal.example.com:3001/"), portal: portal), "other port")
check(!HostPolicy.isPortalOrigin(u("http://portal.example.com:3000/"), portal: portal), "other scheme")
check(!HostPolicy.isPortalOrigin(u("https://evil.example.com:3000/"), portal: portal), "other host")
check(!HostPolicy.isPortalOrigin(u("https://portal.example.com.evil.com:3000/"), portal: portal), "suffix trick")
check(HostPolicy.isPortalOrigin(u("https://p.example.com/a"), portal: u("https://p.example.com:443/")), "default https port")

check(HostPolicy.mayCarryToken(to: u("https://example.com/")), "https ok")
check(HostPolicy.mayCarryToken(to: u("https://box.internal.example:8443/x")), "https private-network name ok")
for bad in ["http://10.0.0.5:8787/", "http://box.internal.example/", "http://localhost/", "http://homeserver:3000/",
            "http://100.64.0.1/", "http://example.com/", "ftp://localhost/"] {
    check(!HostPolicy.mayCarryToken(to: u(bad)), "token refused for \(bad)")
}

check(HostPolicy.httpsURL(" https://p.example.com/a ")?.host == "p.example.com", "httpsURL trims")
check(HostPolicy.httpsURL("HTTPS://P.EXAMPLE.COM") != nil, "httpsURL scheme case")
for bad in ["http://p.example.com", "http://10.0.0.5:8787", "ftp://p.example.com", "p.example.com", "https://", ""] {
    check(HostPolicy.httpsURL(bad) == nil, "httpsURL refuses \(bad)")
}

check(HostPolicy.origin(of: u("https://P.Example.com/a?b=1#c")) == "https://p.example.com", "origin lowercases, ignores path")
check(HostPolicy.origin(of: u("https://p.example.com:443/")) == HostPolicy.origin(of: u("https://p.example.com")), "explicit 443 equals default")
check(HostPolicy.origin(of: u("https://p.example.com:8443/")) != HostPolicy.origin(of: u("https://p.example.com")), "other port differs")
check(HostPolicy.origin(of: u("https://p.example.com:8443/")) == "https://p.example.com:8443", "origin keeps non-default port")
check(HostPolicy.origin(of: u("https://q.example.com/")) != HostPolicy.origin(of: u("https://p.example.com/")), "other host differs")
check(HostPolicy.origin(of: u("http://p.example.com/")) == nil, "http has no origin")
check(HostPolicy.displayName(ofOrigin: "https://p.example.com:8443") == "p.example.com:8443", "display name")

check(HostPolicy.pingURL(portal: u("https://p.example.com:3000/now?a=1#b"))?.absoluteString == "https://p.example.com:3000/api/location/ping", "ping url")
check(HostPolicy.pingURL(portal: u("https://p.example.com/sub"))?.absoluteString == "https://p.example.com/api/location/ping", "ping url drops path")

// Redirects
check(Policies.redirectTarget(URLRequest(url: u("https://evil.example.com/"))) == nil, "redirect refused")

// Throttle
let t0 = Date(timeIntervalSince1970: 1_000_000)
check(Policies.mayReport(now: t0, lastSent: .distantPast), "first reading sends")
check(!Policies.mayReport(now: t0.addingTimeInterval(29.9), lastSent: t0), "29.9 s skipped")
check(Policies.mayReport(now: t0.addingTimeInterval(30), lastSent: t0), "30 s sends")

// Re-sign reminder
let day: TimeInterval = 86_400
check(Policies.installDate(stored: nil, bundle: nil, now: t0) == t0, "install date falls back to now")
check(Policies.installDate(stored: t0.addingTimeInterval(-3 * day), bundle: t0.addingTimeInterval(-day), now: t0) == t0.addingTimeInterval(-day), "newer bundle date wins")
check(Policies.installDate(stored: t0.addingTimeInterval(-3 * day), bundle: t0.addingTimeInterval(day), now: t0) == t0.addingTimeInterval(-3 * day), "future bundle date ignored")
check(Policies.installDate(stored: nil, bundle: t0.addingTimeInterval(-day), now: t0) == t0.addingTimeInterval(-day), "bundle date alone")
check(Policies.firstLaunchToRecord(bundle: nil, now: t0) == t0, "first launch records now")
check(Policies.firstLaunchToRecord(bundle: t0.addingTimeInterval(day), now: t0) == t0, "first launch ignores future bundle")
check(Policies.reminderDelay(installDate: t0, now: t0) == 6 * day, "fresh install fires in 6 days")
check(Policies.reminderDelay(installDate: t0.addingTimeInterval(-5 * day), now: t0) == day, "day 5 fires in 1 day")
check(Policies.reminderDelay(installDate: t0.addingTimeInterval(-6 * day + 10), now: t0) == 60, "under a minute clamps to 60 s")
check(Policies.reminderDelay(installDate: t0.addingTimeInterval(-6 * day), now: t0) == nil, "exactly day 6 does not reschedule")
check(Policies.reminderDelay(installDate: t0.addingTimeInterval(-6.5 * day), now: t0) == nil, "after day 6 does not reschedule")
check(Policies.reminderDelay(installDate: t0.addingTimeInterval(-30 * day), now: t0) == nil, "long expired does not reschedule")


// MARK: Pairing payload (the QR)
func payload(_ json: String) -> Result<PairingPayload, PairingPayloadError> { PairingPayloadParser.parse(json) }
func payloadError(_ json: String) -> PairingPayloadError? {
    if case .failure(let error) = payload(json) { return error }
    return nil
}
let goodQR = "{\"v\":1,\"origin\":\"https://Portal.Example.com\",\"secret\":\"pri_pair_abc123\"}"
if case .success(let parsed) = payload(goodQR) {
    check(parsed.origin == "https://portal.example.com", "payload origin normalised")
    check(parsed.secret == "pri_pair_abc123", "payload secret")
    check(parsed.host == "portal.example.com", "payload host")
} else {
    check(false, "good payload parses")
}
if case .success(let parsed) = payload("{\"v\":1,\"origin\":\"https://p.example.com:8443\",\"secret\":\"s\"}") {
    check(parsed.origin == "https://p.example.com:8443" && parsed.host == "p.example.com:8443", "payload keeps a non-default port")
} else {
    check(false, "payload with a port parses")
}
check(payloadError("{\"v\":1,\"origin\":\"https://p.example.com\",\"secret\":\"s\",\"extra\":true}") == nil, "unknown extra field tolerated")
check(payloadError("{\"v\":1,\"origin\":\"http://p.example.com\",\"secret\":\"s\"}") == .notHTTPS, "payload refuses http")
check(payloadError("{\"v\":1,\"origin\":\"ftp://p.example.com\",\"secret\":\"s\"}") == .notHTTPS, "payload refuses other schemes")
check(payloadError("{\"v\":1,\"origin\":\"https://localhost\",\"secret\":\"s\"}") == .unusableHost, "payload refuses localhost")
check(payloadError("{\"v\":1,\"origin\":\"https://app.localhost\",\"secret\":\"s\"}") == .unusableHost, "payload refuses .localhost")
check(payloadError("{\"v\":1,\"origin\":\"https://127.0.0.1\",\"secret\":\"s\"}") == .unusableHost, "payload refuses an IPv4 address")
check(payloadError("{\"v\":1,\"origin\":\"https://192.168.1.20:8443\",\"secret\":\"s\"}") == .unusableHost, "payload refuses a LAN address")
check(payloadError("{\"v\":1,\"origin\":\"https://[::1]\",\"secret\":\"s\"}") == .unusableHost, "payload refuses an IPv6 address")
check(payloadError("{\"v\":1,\"origin\":\"https://homeserver\",\"secret\":\"s\"}") == .unusableHost, "payload refuses a one-word host")
check(payloadError("{\"v\":2,\"origin\":\"https://p.example.com\",\"secret\":\"s\"}") == .unsupportedVersion, "payload refuses another version")
check(payloadError("{\"v\":0,\"origin\":\"https://p.example.com\",\"secret\":\"s\"}") == .unsupportedVersion, "payload refuses version 0")
check(payloadError("{\"origin\":\"https://p.example.com\",\"secret\":\"s\"}") == .missingField("v"), "payload needs v")
check(payloadError("{\"v\":1,\"secret\":\"s\"}") == .missingField("origin"), "payload needs origin")
check(payloadError("{\"v\":1,\"origin\":\"\",\"secret\":\"s\"}") == .missingField("origin"), "payload refuses an empty origin")
check(payloadError("{\"v\":1,\"origin\":\"https://p.example.com\"}") == .missingField("secret"), "payload needs secret")
check(payloadError("{\"v\":1,\"origin\":\"https://p.example.com\",\"secret\":\"\"}") == .missingField("secret"), "payload refuses an empty secret")
check(payloadError("{\"v\":1,\"origin\":\"https://p.example.com\",\"secret\":\"two words\"}") == .badSecret, "payload refuses a secret with spaces")
check(payloadError("{\"v\":1,\"origin\":\"https://p.example.com\",\"secret\":\"\(String(repeating: "x", count: 201))\"}") == .badSecret, "payload refuses a long secret")
check(payloadError("{\"v\":1,\"origin\":\"https://p.example.com/now\",\"secret\":\"s\"}") == .notAnOrigin, "payload refuses an origin with a path")
check(payloadError("{\"v\":1,\"origin\":\"https://u:p@p.example.com\",\"secret\":\"s\"}") == .notAnOrigin, "payload refuses credentials in the origin")
check(payloadError("{\"v\":1,\"origin\":\"https://p.example.com?x=1\",\"secret\":\"s\"}") == .notAnOrigin, "payload refuses a query")
check(payloadError("{\"v\":\"1\",\"origin\":\"https://p.example.com\",\"secret\":\"s\"}") == .notAPairingCode, "payload refuses a string version")
check(payloadError("not json") == .notAPairingCode, "payload refuses text")
check(payloadError("https://p.example.com/") == .notAPairingCode, "payload refuses a bare url")
check(payloadError("") == .notAPairingCode, "payload refuses empty text")
check(payloadError("[1,2]") == .notAPairingCode, "payload refuses an array")

if case .success(let origin) = PairingPayloadParser.validateOrigin(" https://P.example.com/ ") {
    check(origin == "https://p.example.com", "typed origin normalised")
} else {
    check(false, "typed origin parses")
}
check(PairingPayloadParser.validateOrigin("http://p.example.com") == .failure(.notHTTPS), "typed origin refuses http")
check(PairingPayloadParser.validateOrigin("p.example.com") == .failure(.notAnOrigin), "typed origin needs a scheme")

check(DeviceName.clean("  My phone ") == "My phone", "name trimmed")
check(DeviceName.clean("   ") == DeviceName.fallback, "empty name falls back")
check(DeviceName.clean(String(repeating: "a", count: 90)).utf16.count == 60, "long name cut to 60")
check(DeviceName.clean(String(repeating: "\u{1F600}", count: 40)).utf16.count <= 60, "emoji name cut within 60 UTF-16 units")

check(InstallId.make(from: [0, 15, 16, 255]) == "000f10ff", "install id hex")
check(InstallId.isValid(InstallId.generate()), "generated install id is valid")
check(InstallId.generate() != InstallId.generate(), "install ids differ")
check(InstallId.generate().count == 32, "install id is 32 characters")
for bad in ["", "short", "UPPERCASE123", "-leading-dash1", "has space 123", String(repeating: "a", count: 65)] {
    check(!InstallId.isValid(bad), "install id refuses \(bad)")
}
check(InstallId.isValid("abcd1234") && InstallId.isValid("a_b-c-d-1234"), "install id accepts the portal's shape")

// MARK: Requests
let issuedOrigin = "https://p.example.com"
func body(_ request: URLRequest?) -> [String: Any] {
    guard let data = request?.httpBody, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
    return object
}
let redeemRequest = ApiRequests.redeem(origin: issuedOrigin, secret: "sec", name: "  My phone ", installId: "abcd1234")
check(redeemRequest?.url?.absoluteString == "https://p.example.com/api/owner/devices/redeem", "redeem url")
check(redeemRequest?.httpMethod == "POST", "redeem is a POST")
check(redeemRequest?.value(forHTTPHeaderField: "X-OpenRhen-Owner") == nil, "redeem sends no token")
check(body(redeemRequest)["pairingSecret"] as? String == "sec", "redeem sends the secret")
check(body(redeemRequest)["name"] as? String == "My phone", "redeem sends the cleaned name")
check(body(redeemRequest)["installId"] as? String == "abcd1234", "redeem sends the install id")
check(body(redeemRequest)["platform"] as? String == "ios", "redeem sends the platform")
check(ApiRequests.redeem(origin: "http://p.example.com", secret: "s", name: "n", installId: "abcd1234") == nil, "no request over http")
check(ApiRequests.redeem(origin: "https://p.example.com/path", secret: "s", name: "n", installId: "abcd1234") == nil, "origin must be an origin")
let codeRequest = ApiRequests.codeStart(origin: issuedOrigin, name: "", installId: "abcd1234")
check(codeRequest?.url?.path == "/api/owner/devices/code", "code url")
check(body(codeRequest)["name"] as? String == DeviceName.fallback, "code request name defaults")
let pollRequest = ApiRequests.codePoll(origin: issuedOrigin, deviceCode: "dc")
check(pollRequest?.url?.path == "/api/owner/devices/code/token" && body(pollRequest)["deviceCode"] as? String == "dc", "poll request")
let webRequest = ApiRequests.webSession(origin: "https://p.example.com:8443", token: "tok")
check(webRequest?.url?.absoluteString == "https://p.example.com:8443/api/owner/web-session", "web-session url keeps the port")
check(webRequest?.value(forHTTPHeaderField: "X-OpenRhen-Owner") == "tok", "web-session sends the owner header")
check(webRequest?.value(forHTTPHeaderField: "Authorization") == nil, "no bearer header")
let pingTime = Date(timeIntervalSince1970: 1_700_000_000)
let pingRequest = ApiRequests.locationPing(origin: issuedOrigin, token: "tok", installId: "abcd1234",
                                           ping: QueuedPing(latitude: 51.5, longitude: -0.12, accuracyMeters: 12, observedAt: pingTime))
check(pingRequest?.url?.absoluteString == "https://p.example.com/api/location/ping", "ping url")
check(pingRequest?.value(forHTTPHeaderField: "X-OpenRhen-Owner") == "tok", "ping sends the owner header")
check(body(pingRequest)["device"] as? String == "abcd1234", "ping device is the install id string")
check(body(pingRequest)["latitude"] as? Double == 51.5 && body(pingRequest)["accuracyMeters"] as? Double == 12, "ping reading")
check((body(pingRequest)["observedAt"] as? String).flatMap(ApiDates.parse) == pingTime, "ping time round-trips")
check(Set(body(pingRequest).keys) == ["latitude", "longitude", "accuracyMeters", "observedAt", "device"], "ping sends only the agreed fields")
check(ApiDates.parse("2026-11-10T08:00:00Z") != nil && ApiDates.parse("2026-11-10T08:00:00.123+01:00") != nil, "dates with and without fractions")

// MARK: Responses
func answer(_ status: Int, _ json: String = "{}", retryAfter: Int? = nil) -> HTTPAnswer {
    HTTPAnswer(status: status, body: Data(json.utf8), retryAfter: retryAfter)
}
if case .success(let issued) = ApiResponses.issued(answer(201, "{\"token\":\"pri_own_x\",\"credential\":{\"id\":\"c1\",\"label\":\"My phone\",\"kind\":\"token\"}}")) {
    check(issued.token == "pri_own_x" && issued.credentialId == "c1" && issued.label == "My phone", "issued credential decoded")
} else {
    check(false, "issued credential decodes")
}
check(ApiResponses.issued(answer(201, "{\"credential\":{}}")) == .failure(.badResponse), "issued without a token is a bad response")
check(ApiResponses.issued(answer(201, "oops")) == .failure(.badResponse), "issued with junk is a bad response")
check(ApiResponses.issued(answer(400, "{\"error\":\"That pairing is not valid.\"}")) == .failure(.rejected(message: "That pairing is not valid.")), "redeem refusal shows the server's words")
check(ApiResponses.issued(answer(400, "")) == .failure(.rejected(message: "The server refused the request (status 400).")), "refusal without a body")
check(ApiResponses.issued(answer(429, "{\"error\":\"slow\"}", retryAfter: 30)) == .failure(.rateLimited(retryAfter: 30)), "429 keeps retry-after")
check(ApiResponses.issued(answer(503)) == .failure(.server(status: 503)), "5xx")
check(ApiResponses.issued(answer(302)) == .failure(.badResponse), "3xx (refused redirect)")
check(ApiResponses.issued(answer(403, "{\"error\":\"This host is not allowed.\"}")) == .failure(.hostNotAllowed), "host not allowed")
check(ApiResponses.issued(answer(403, "{\"error\":\"Cross-site requests are not allowed.\"}")) == .failure(.rejected(message: "Cross-site requests are not allowed.")), "other 403")
check(ApiError.hostNotAllowed.message.contains("PORTAL_ALLOWED_HOSTS"), "host refusal names the setting")

if case .success(let start) = ApiResponses.codeStart(answer(200, "{\"deviceCode\":\"pri_dcode_x\",\"userCode\":\"BCDF-GHJK\",\"expiresIn\":600,\"interval\":5}")) {
    check(start.deviceCode == "pri_dcode_x" && start.userCode == "BCDF-GHJK" && start.expiresIn == 600 && start.interval == 5, "code start decoded")
} else {
    check(false, "code start decodes")
}
check(ApiResponses.codeStart(answer(200, "{\"userCode\":\"BCDF-GHJK\"}")) == .failure(.badResponse), "code start needs a device code")
check(UserCode.display("bcdfghjk") == "BCDF-GHJK" && UserCode.display("BCDF-GHJK") == "BCDF-GHJK", "user code shown as two groups")
check(UserCode.display("odd1") == "odd1", "odd code shown as received")

let cookieBody = "{\"credential\":{},\"session\":{\"cookie\":\"openrhen_owner\",\"value\":\"pri_ses_x\",\"expiresAt\":\"2026-12-10T08:00:00.000Z\",\"maxAgeSeconds\":2592000}}"
if case .success(let cookie) = ApiResponses.webSession(answer(201, cookieBody)) {
    check(cookie.name == "openrhen_owner" && cookie.value == "pri_ses_x" && cookie.maxAgeSeconds == 2_592_000 && cookie.expiresAt != nil, "web session decoded")
} else {
    check(false, "web session decodes")
}
check(ApiResponses.webSession(answer(401, "{\"error\":\"The owner credential was revoked.\"}")) == .failure(.revoked), "web session 401 is revoked")
check(ApiResponses.webSession(answer(201, "{\"session\":{}}")) == .failure(.badResponse), "web session without a cookie")

// MARK: Revoked handling: any 401 on a signed call
check(ApiResponses.failure(for: answer(401), signed: true) == .revoked, "signed 401 is revoked")
check(ApiResponses.failure(for: answer(401), signed: false) == .rejected(message: "The server refused the request (status 401)."), "unsigned 401 is only a refusal")
check(ApiResponses.failure(for: answer(200), signed: true) == nil, "200 is fine")
check(ApiError.revoked.message == "This phone was removed from the portal", "revoked wording")

// MARK: Ping dispositions
check(PingDisposition.forStatus(200) == .sent, "200 sent")
check(PingDisposition.forStatus(401) == .revoked, "401 revoked")
check(PingDisposition.forStatus(nil) == .retryLater, "no answer retries")
check(PingDisposition.forStatus(503) == .retryLater, "5xx retries")
check(PingDisposition.forStatus(429) == .retryLater, "429 retries")
check(PingDisposition.forStatus(408) == .retryLater, "408 retries")
check(PingDisposition.forStatus(400) == .discard, "400 (stale or malformed) is dropped")
check(PingDisposition.forStatus(403) == .discard, "403 is dropped")
check(PingDisposition.forStatus(302) == .discard, "3xx is dropped")

// MARK: Device code poll state machine
let c0 = Date(timeIntervalSince1970: 2_000_000)
var poller = DeviceCodePoller(interval: 5, expiresIn: 600, now: c0)
check(poller.record(.pending, now: c0.addingTimeInterval(5)) == .wait(5), "pending waits the interval")
check(poller.record(.slowDown, now: c0.addingTimeInterval(10)) == .wait(10), "slow_down widens by 5")
check(poller.record(.slowDown, now: c0.addingTimeInterval(20)) == .wait(15), "slow_down widens again")
check(poller.record(.pending, now: c0.addingTimeInterval(35)) == .wait(15), "the wider interval sticks")
check(poller.record(.approved, now: c0.addingTimeInterval(50)) == .approved, "approved")
var capped = DeviceCodePoller(interval: 58, expiresIn: 600, now: c0)
check(capped.record(.slowDown, now: c0.addingTimeInterval(1)) == .wait(60), "interval capped at 60")
check(capped.record(.slowDown, now: c0.addingTimeInterval(2)) == .wait(60), "stays capped")
var expiring = DeviceCodePoller(interval: 5, expiresIn: 600, now: c0)
check(expiring.record(.expired, now: c0.addingTimeInterval(30)) == .failed(.expired), "expired_token ends it")
var denying = DeviceCodePoller(interval: 5, expiresIn: 600, now: c0)
check(denying.record(.denied, now: c0.addingTimeInterval(30)) == .failed(.denied), "access_denied ends it")
var late = DeviceCodePoller(interval: 5, expiresIn: 600, now: c0)
check(late.record(.pending, now: c0.addingTimeInterval(600)) == .failed(.expired), "local deadline ends it")
check(late.record(.approved, now: c0.addingTimeInterval(601)) == .approved, "an approval at the deadline still wins")
var flaky = DeviceCodePoller(interval: 5, expiresIn: 600, now: c0)
for n in 1...4 { check(flaky.record(.networkError, now: c0.addingTimeInterval(Double(n))) == .wait(5), "network error \(n) retries") }
check(flaky.record(.networkError, now: c0.addingTimeInterval(5)) == .failed(.unreachable), "fifth network error gives up")
var recovering = DeviceCodePoller(interval: 5, expiresIn: 600, now: c0)
for n in 1...4 { _ = recovering.record(.networkError, now: c0.addingTimeInterval(Double(n))) }
_ = recovering.record(.pending, now: c0.addingTimeInterval(6))
check(recovering.record(.networkError, now: c0.addingTimeInterval(7)) == .wait(5), "a good poll resets the error count")
var limited = DeviceCodePoller(interval: 5, expiresIn: 600, now: c0)
check(limited.record(.rateLimited(retryAfter: 20), now: c0.addingTimeInterval(1)) == .wait(20), "429 honours retry-after")
check(limited.record(.rateLimited(retryAfter: nil), now: c0.addingTimeInterval(2)) == .wait(5), "429 without retry-after waits the interval")
var odd = DeviceCodePoller(interval: 5, expiresIn: 600, now: c0)
check(odd.record(.unknown("invalid_request"), now: c0.addingTimeInterval(1)) == .failed(.unexpected("invalid_request")), "unknown error ends it")
check(DeviceCodePoller(interval: 0, expiresIn: 600, now: c0).interval == 5, "zero interval uses the default")
check(DeviceCodePoller(interval: 2, expiresIn: 600, now: c0).interval == 2, "a shorter server interval is honoured")

check(ApiResponses.pollReply(answer(400, "{\"error\":\"authorization_pending\"}")) == .pending, "reply pending")
check(ApiResponses.pollReply(answer(400, "{\"error\":\"slow_down\"}")) == .slowDown, "reply slow_down")
check(ApiResponses.pollReply(answer(400, "{\"error\":\"expired_token\"}")) == .expired, "reply expired_token")
check(ApiResponses.pollReply(answer(400, "{\"error\":\"access_denied\"}")) == .denied, "reply access_denied")
check(ApiResponses.pollReply(answer(400, "{\"error\":\"invalid_request\"}")) == .unknown("invalid_request"), "reply other error")
check(ApiResponses.pollReply(answer(400, "")) == .unknown("status 400"), "reply with no error name")
check(ApiResponses.pollReply(answer(200, "{\"token\":\"t\"}")) == .approved, "reply approved")
check(ApiResponses.pollReply(answer(429, "{}", retryAfter: 12)) == .rateLimited(retryAfter: 12), "reply rate limited")
check(ApiResponses.pollReply(answer(502)) == .networkError, "reply 5xx is transient")

// MARK: Outbox ordering and expiry
let o0 = Date(timeIntervalSince1970: 3_000_000)
func fix(_ n: Double, at time: Date) -> QueuedPing { QueuedPing(latitude: n, longitude: n, accuracyMeters: 5, observedAt: time) }
var box = PingOutbox()
box.enqueue(fix(1, at: o0), now: o0)
box.enqueue(fix(2, at: o0.addingTimeInterval(30)), now: o0.addingTimeInterval(30))
box.enqueue(fix(3, at: o0.addingTimeInterval(60)), now: o0.addingTimeInterval(60))
check(box.items.map { $0.latitude } == [1, 2, 3], "outbox keeps the order made")
check(box.next(now: o0.addingTimeInterval(61))?.latitude == 1, "oldest first")
check(box.apply(.retryLater) == .retryLater && box.count == 3, "a transient failure keeps everything in place")
check(box.apply(.sent) == .continueDraining && box.items.map { $0.latitude } == [2, 3], "a sent ping leaves the head")
check(box.apply(.discard) == .continueDraining && box.items.map { $0.latitude } == [3], "a refused ping is dropped, not looped")
check(box.next(now: o0.addingTimeInterval(61))?.latitude == 3, "the next one follows")
check(box.next(now: o0.addingTimeInterval(60 + 300))?.latitude == 3, "exactly 5 minutes old is still sent")
check(box.next(now: o0.addingTimeInterval(60 + 301)) == nil && box.isEmpty, "older than 5 minutes is dropped, not sent")
var expiry = PingOutbox()
expiry.enqueue(fix(1, at: o0), now: o0)
expiry.enqueue(fix(2, at: o0.addingTimeInterval(200)), now: o0.addingTimeInterval(200))
check(expiry.next(now: o0.addingTimeInterval(400))?.latitude == 2 && expiry.count == 1, "only the expired ping goes")
var stale = PingOutbox()
stale.enqueue(fix(9, at: o0), now: o0.addingTimeInterval(301))
check(stale.isEmpty, "a fix already too old is never queued")
var full = PingOutbox()
for n in 0..<(PingOutbox.maxCount + 5) { full.enqueue(fix(Double(n), at: o0), now: o0) }
check(full.count == PingOutbox.maxCount && full.items.first?.latitude == 5, "over the cap the oldest go first")
var revoked = PingOutbox()
revoked.enqueue(fix(1, at: o0), now: o0)
revoked.enqueue(fix(2, at: o0), now: o0)
check(revoked.apply(.revoked) == .signedOut && revoked.isEmpty, "a revoked answer empties the queue")
var emptyBox = PingOutbox()
check(emptyBox.apply(.sent) == .continueDraining && emptyBox.next(now: o0) == nil, "applying to an empty queue is harmless")

// File round trip and protection
let outboxDir = FileManager.default.temporaryDirectory.appendingPathComponent("openrhen-outbox-\(InstallId.generate())", isDirectory: true)
let file = OutboxFile(directory: outboxDir)
check(file.load().isEmpty, "missing file is an empty queue")
var saved = PingOutbox()
saved.enqueue(fix(1, at: o0), now: o0)
saved.enqueue(fix(2, at: o0.addingTimeInterval(10)), now: o0.addingTimeInterval(10))
check(file.save(saved), "outbox saves")
check(file.load() == saved, "outbox round-trips in order")
try? Data("not json".utf8).write(to: file.fileURL)
check(file.load().isEmpty, "a corrupt file is an empty queue")
file.delete()
check(!FileManager.default.fileExists(atPath: file.fileURL.path), "outbox file deleted")
try? FileManager.default.removeItem(at: outboxDir)

// MARK: Credential store and signed-in state
let store = InMemoryCredentialStore()
let installA = store.installId()
check(InstallId.isValid(installA) && store.installId() == installA, "install id is stable")
let core = SessionCore(store: store)
var changes = 0
var signedOutCount = 0
core.onChange = { _ in changes += 1 }
core.onSignedOut = { signedOutCount += 1 }
check(core.state.session == nil && core.state.notice == nil, "starts signed out")
check(core.complete(token: "tok1", origin: "https://p.example.com"), "pairing keeps the token")
check(core.state.session == DeviceSession(token: "tok1", origin: "https://p.example.com") && store.loadSession() == core.state.session, "paired state is stored")
core.tokenRejected("old-token")
check(core.state.session?.token == "tok1" && signedOutCount == 0, "a 401 for an older token changes nothing")
core.tokenRejected("tok1")
check(core.state.session == nil && store.loadSession() == nil, "a revoked token signs the phone out and clears the store")
check(core.state.notice == "This phone was removed from the portal", "the revoked notice is shown")
check(signedOutCount == 1, "sign-out cleanup ran once")
core.tokenRejected("tok1")
check(signedOutCount == 1, "a second 401 does nothing")
check(store.installId() == installA, "the install id survives sign-out")
check(core.complete(token: "tok2", origin: "https://p.example.com") && core.state.notice == nil, "pairing again clears the notice")
core.signOut()
check(core.state.session == nil && core.state.notice == nil && signedOutCount == 2, "choosing to sign out leaves no notice")
core.signOut()
check(signedOutCount == 2, "signing out twice does nothing")
store.refuseWrites = true
check(!core.complete(token: "tok3", origin: "https://p.example.com") && core.state.session == nil, "a refused Keychain write leaves the phone signed out")
check(changes > 0, "changes are announced")
check(SessionCore(store: InMemoryCredentialStore(session: DeviceSession(token: "kept", origin: "https://p.example.com"))).state.session?.token == "kept", "a stored session is found on launch")
core.onChange = nil
core.onSignedOut = nil

// MARK: Live the day (slice 2)
func jsonObject(_ text: String) -> Data { Data(text.utf8) }

func liveDayChecks(fixturesPath: String?, schemaPath: String?) {
    // Contract: every fixture decodes with the Swift types.
    guard let fixturesPath, let fixtureFile = FileManager.default.contents(atPath: fixturesPath) else {
        check(false, "the client view fixtures file is readable (pass its path as the first argument)")
        return
    }
    var decodedViews: [ClientView] = []
    for (index, data) in (ClientViewCodec.fixtures(named: "ClientView", in: fixtureFile) ?? []).enumerated() {
        do {
            let view = try JSONDecoder().decode(ClientView.self, from: data)
            decodedViews.append(view)
            check(view.schemaVersion == ClientView.supportedSchemaVersion, "ClientView fixture \(index) has the supported version")
        } catch {
            check(false, "ClientView fixture \(index) decodes: \(error)")
        }
    }
    check(decodedViews.count >= 2, "at least two ClientView fixtures were decoded")
    var shownCount = 0
    for (index, data) in (ClientViewCodec.fixtures(named: "CheckInShown", in: fixtureFile) ?? []).enumerated() {
        do { _ = try JSONDecoder().decode(CheckInShown.self, from: data); shownCount += 1 } catch { check(false, "CheckInShown fixture \(index) decodes: \(error)") }
    }
    check(shownCount >= 2, "at least two CheckInShown fixtures were decoded")
    if let schemaPath, let schemaFile = FileManager.default.contents(atPath: schemaPath),
       let schema = try? JSONSerialization.jsonObject(with: schemaFile) as? [String: Any], let defs = schema["$defs"] as? [String: Any] {
        for name in defs.keys.sorted() {
            check(["ClientView", "CheckInShown"].contains(name), "the schema type \(name) has a Swift decoder and fixtures checked here")
        }
        let fixtureTypes = (try? JSONSerialization.jsonObject(with: fixtureFile) as? [String: Any])?.keys.sorted() ?? []
        check(fixtureTypes == defs.keys.sorted(), "fixtures and schema name the same types")
    } else {
        check(false, "the client view schema file is readable (pass its path as the second argument)")
    }

    if let full = decodedViews.first, let bare = decodedViews.dropFirst().first {
        check(full.now?.directive?.title == "Write section 2" && full.now?.directive?.recommendedMinutes == 45, "directive decoded")
        check(full.day?.count == 1 && full.day?[0].confidence == "firm" && full.day?[0].targetId == "action-1", "day decoded")
        check(full.pending?.checkIn?.status == "pending" && full.pending?.checkIn?.version == 1 && full.pending?.checkIn?.promptedAt == nil, "check-in decoded")
        check(full.pending?.session?.minutesLeft == 40 && full.pending?.session?.isActionSession == true, "session decoded")
        check(full.pending?.leaveBy?.phase == "remind" && full.pending?.placeSuggestion?.locationName == "Studio", "leave-by and place decoded")
        check(bare.now == nil && bare.day == nil && bare.validUntil == nil && bare.planCurrent == false && bare.pending?.checkIn == nil, "a pending-only view decodes")
        // The contract is strict about required fields and lenient about extras.
        let good = (ClientViewCodec.fixtures(named: "ClientView", in: fixtureFile) ?? [])[0]
        var tampered = (try? JSONSerialization.jsonObject(with: good) as? [String: Any]) ?? [:]
        tampered["somethingNew"] = ["a": 1]
        check((try? JSONSerialization.data(withJSONObject: tampered)).flatMap { ClientViewCodec.decodeView($0) } != nil, "an unknown field is ignored")
        var wrongVersion = tampered
        wrongVersion["schemaVersion"] = 2
        check((try? JSONSerialization.data(withJSONObject: wrongVersion)).flatMap { ClientViewCodec.decodeView($0) } == nil, "another schema version is refused")
        var noTimezone = tampered
        noTimezone.removeValue(forKey: "timezone")
        check((try? JSONSerialization.data(withJSONObject: noTimezone)).flatMap { ClientViewCodec.decodeView($0) } == nil, "a missing required field is refused")
        var noCheckInId = tampered
        if var pending = noCheckInId["pending"] as? [String: Any], var checkIn = pending["checkIn"] as? [String: Any] {
            checkIn.removeValue(forKey: "id"); pending["checkIn"] = checkIn; noCheckInId["pending"] = pending
        }
        check((try? JSONSerialization.data(withJSONObject: noCheckInId)).flatMap { ClientViewCodec.decodeView($0) } == nil, "a check-in without an id is refused")
    }

    let utc = TimeZone(identifier: "UTC")!
    let sydney = TimeZone(identifier: "Australia/Sydney")!
    let t = ApiDates.parse("2026-11-10T09:10:00+11:00")!
    check(TimeText.clock(t, in: sydney) == "09:10" && TimeText.clock(t, in: utc) == "22:10", "clock text follows the zone")
    check(TimeText.minutes(45) == "45 min" && TimeText.minutes(60) == "1 h" && TimeText.minutes(75) == "1 h 15 min", "duration text")

    // Cache freshness
    if let view = decodedViews.first {
        let fetched = ApiDates.parse("2026-11-10T09:05:00+11:00")!
        let cached = CachedView(view: view, etag: "\"x\"", fetchedAt: fetched)
        let fresh = ViewFreshness.assess(cached, now: fetched.addingTimeInterval(60), lastRefreshFailed: false)
        check(!fresh.isStale && fresh.reason == nil && fresh.asOfText == "as of 09:05", "a recent view is current")
        let old = ViewFreshness.assess(cached, now: fetched.addingTimeInterval(16 * 60), lastRefreshFailed: false)
        check(old.isStale, "a view over 15 minutes old is stale")
        let past = ViewFreshness.assess(cached, now: ApiDates.parse("2026-11-10T09:31:00+11:00")!, lastRefreshFailed: false)
        check(past.isStale && past.reason != nil, "a view past validUntil is stale")
        let offline = ViewFreshness.assess(cached, now: fetched.addingTimeInterval(60), lastRefreshFailed: true)
        check(!offline.isStale && offline.reason?.contains("Can't reach your server") == true, "a failed refresh is said in words")
        let file = PrivateJSONFile<CachedView>(directory: URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("openrhen-cache-\(UUID().uuidString)"), name: "view.json")
        check(file.save(cached) && file.load() == cached, "the cache survives a restart")
        file.delete()
        check(file.load() == nil, "a deleted cache reads as nothing")

        // Now and Day sentences
        let model = ViewPresentation.now(view, at: ApiDates.parse("2026-11-10T09:10:00+11:00")!, fetchedAt: fetched, phoneZone: sydney)
        check(model.headline == "Write section 2", "the running session is the headline")
        check(model.timeLine == "35 min left", "a running session counts down to its planned end (got \(model.timeLine ?? "nil"))")
        check(model.why == "Session running", "session why")
        check(model.leaveByLine == "Leave by 10:30 for Dentist at 11:00 (allowing 30 min)", "leave-by line (got \(model.leaveByLine ?? "nil"))")
        check(model.placeLine == "You may be at Studio (seen 09:00).", "place card line")
        check(model.zoneNote == nil, "no zone note in the plan's own zone")
        check(ViewPresentation.now(view, at: t, fetchedAt: fetched, phoneZone: utc).zoneNote?.contains("Australia/Sydney") == true, "a travelling phone is told the zone")
        let rows = ViewPresentation.day(view, at: ApiDates.parse("2026-11-10T09:10:00+11:00")!)
        check(rows.count == 1 && rows[0].range == "09:00-09:45" && rows[0].isNow && rows[0].changedBy == nil, "day row")
        let dayJSON = "{\"schemaVersion\":1,\"timezone\":\"UTC\",\"planCurrent\":true,\"validUntil\":null,\"day\":[{\"startsAt\":\"2026-11-10T10:00:00Z\",\"endsAt\":\"2026-11-10T10:30:00Z\",\"kind\":\"action\",\"title\":\"Call\",\"targetId\":null,\"minutes\":30,\"confidence\":\"projected\",\"changedBy\":\"Mark\"}]}"
        if let dayView = ClientViewCodec.decodeView(jsonObject(dayJSON)) {
            let row = ViewPresentation.day(dayView, at: t)[0]
            check(row.changedBy == "Changed by Mark" && row.isProjected && row.detail.contains("projection"), "changed-by and projection shown when the payload has them")
        } else {
            check(false, "a day-only view decodes")
        }
        let paused = ClientSession(id: "s", status: "paused", version: nil, title: "T", targetType: nil, targetId: nil, startedAt: "2026-11-10T09:00:00Z", plannedEndAt: "2026-11-10T09:45:00Z", plannedMinutes: 45, elapsedMinutes: 5, minutesLeft: 40)
        check(ViewPresentation.timeLeft(paused, now: t, fetchedAt: fetched) == "40 min left (paused)", "a paused session is frozen")
    }

    // Requests
    let origin = "https://p.example.com"
    let viewRequest = ClientRequests.view(origin: origin, token: "tok", etag: "\"abc\"")
    check(viewRequest?.url?.absoluteString == "https://p.example.com/api/client/view?parts=now,day,pending", "view url")
    check(viewRequest?.value(forHTTPHeaderField: "If-None-Match") == "\"abc\"" && viewRequest?.value(forHTTPHeaderField: "X-OpenRhen-Owner") == "tok", "view revalidates by tag with the owner token")
    check(ClientRequests.view(origin: origin, token: "tok", etag: nil)?.value(forHTTPHeaderField: "If-None-Match") == nil, "no tag, no header")
    check(ClientRequests.view(origin: "http://p.example.com", token: "tok", etag: nil) == nil, "the token never goes over http")
    check(ClientRequests.events(origin: origin, token: "tok")?.value(forHTTPHeaderField: "Accept") == "text/event-stream", "event stream request")
    check(ClientRequests.shown(origin: origin, token: "tok", checkInId: "6f0c2c1e-3f5b-4f3a-9b0e-2a6d5f0d9a11")?.url?.path == "/api/check-ins/6f0c2c1e-3f5b-4f3a-9b0e-2a6d5f0d9a11/shown", "shown url")
    check(ClientRequests.shown(origin: origin, token: "tok", checkInId: "../x") == nil, "a check-in id with odd characters is not sent")

    // Fetch results
    if let view = decodedViews.first {
        let now0 = Date(timeIntervalSince1970: 2_000_000)
        let previous = CachedView(view: view, etag: "\"old\"", fetchedAt: now0.addingTimeInterval(-600))
        let fixtureBody = (ClientViewCodec.fixtures(named: "ClientView", in: fixtureFile) ?? [])[0]
        if case .updated(let cached) = ViewFetch.interpret(HTTPAnswer(status: 200, body: fixtureBody, retryAfter: nil, etag: "\"new\""), previous: previous, now: now0) {
            check(cached.etag == "\"new\"" && cached.fetchedAt == now0 && cached.view == view, "a 200 replaces the view and its tag")
        } else { check(false, "a 200 updates") }
        if case .unchanged(let cached) = ViewFetch.interpret(HTTPAnswer(status: 304, body: Data(), retryAfter: nil), previous: previous, now: now0) {
            check(cached.etag == "\"old\"" && cached.fetchedAt == now0 && cached.view == view, "a 304 keeps the view and renews its time")
        } else { check(false, "a 304 is unchanged") }
        check(ViewFetch.interpret(nil, previous: previous, now: now0) == .unreachable, "no answer is unreachable")
        let newerBody = Data(#"{"schemaVersion":2,"somethingElse":true}"#.utf8)
        check(ViewFetch.interpret(HTTPAnswer(status: 200, body: newerBody, retryAfter: nil), previous: previous, now: now0) == .failed(ClientViewCodec.newerServerMessage), "another schema version says to update the app, not a generic bad reply")
        check(ViewFetch.interpret(HTTPAnswer(status: 200, body: Data("{}".utf8), retryAfter: nil), previous: previous, now: now0) == .failed(ApiError.badResponse.message), "a body with no version stays a bad reply")
        check(ViewFetch.interpret(HTTPAnswer(status: 401, body: Data(), retryAfter: nil), previous: previous, now: now0) == .revoked, "401 is revoked")
        if case .failed = ViewFetch.interpret(HTTPAnswer(status: 200, body: jsonObject("{\"nope\":1}"), retryAfter: nil), previous: previous, now: now0) {} else { check(false, "an unreadable body fails") }
        if case .failed(let words) = ViewFetch.interpret(HTTPAnswer(status: 500, body: Data(), retryAfter: nil), previous: previous, now: now0) {
            check(words.contains("status 500"), "a 500 is said in words")
        } else { check(false, "a 500 fails") }
    }

    // Event stream
    var splitter = LineSplitter()
    var parser = EventStreamParser()
    var events: [EventStreamParser.Event] = []
    let wire = "retry: 3000\n\nevent: hello\ndata: {\"lastSuccessfulAt\":null}\n\n: ping\n\nevent: changed\r\ndata: {\"kind\":\"plan\"}\r\n\r\n"
    for byte in Array(wire.utf8) {
        if let line = splitter.feed(byte), let event = parser.feed(line: line) { events.append(event) }
    }
    check(events.map { $0.name } == ["hello", "changed"], "the stream's events are read, comments skipped (got \(events.map { $0.name }))")
    check(events.last?.data == "{\"kind\":\"plan\"}", "event data")
    check(RefreshPolicy.reconnectDelay(attempt: 1) == 2 && RefreshPolicy.reconnectDelay(attempt: 3) == 8 && RefreshPolicy.reconnectDelay(attempt: 20) == 60, "reconnect backoff is capped")

    // Commands
    let made = ApiDates.parse("2026-11-10T09:10:00+11:00")!
    let checkInId = "6f0c2c1e-3f5b-4f3a-9b0e-2a6d5f0d9a11"
    check(CheckInChoice.yes.status == "on_track" && CheckInChoice.no.status == "deviated" && CheckInChoice.notSure.status == "unknown", "answers map to the owner's own statuses")
    check(CommandBuilders.cleanWords("   ").words == nil && CommandBuilders.cleanWords(" slower than planned ").words == "slower than planned", "words are trimmed, empty is nothing")
    check(CommandBuilders.cleanWords(String(repeating: "a", count: 8001)).tooLong && !CommandBuilders.cleanWords(String(repeating: "a", count: 8000)).tooLong, "words over 8000 characters are refused, not cut")
    check(CommandBuilders.cleanWords(String(repeating: "😀", count: 4001)).tooLong && !CommandBuilders.cleanWords(String(repeating: "😀", count: 4000)).tooLong, "the cap counts UTF-16 units like the server, so an emoji is two")
    let answerYes = CommandBuilders.answerCheckIn(checkInId: checkInId, title: "Write", choice: .no, words: "Walking the dog", expectedVersion: nil, at: made, id: "c1")
    let answerBody = CommandRequests.body(answerYes, timeZone: sydney)
    check(answerBody["type"] as? String == "answer_check_in" && answerBody["status"] as? String == "deviated" && answerBody["deviationNote"] as? String == "Walking the dog", "check-in body")
    check(answerBody["answerSource"] as? String == "app" && answerBody["checkInId"] as? String == checkInId, "check-in source and id")
    check(answerBody["expectedVersion"] is NSNull, "an offline check-in answer sends expectedVersion null")
    check(answerBody["occurredAt"] as? String == "2026-11-10T09:10:00.000+11:00", "occurredAt is ISO 8601 with the phone's offset (got \(answerBody["occurredAt"] as? String ?? "nil"))")
    check(answerBody["deviationCategory"] == nil, "no category is ever sent")
    let answerRequest = CommandRequests.request(answerYes, origin: origin, token: "tok", timeZone: sydney)
    check(answerRequest?.url?.path == "/api/commands/check-in" && answerRequest?.httpMethod == "POST" && answerRequest?.value(forHTTPHeaderField: "X-OpenRhen-Owner") == "tok", "check-in request")
    let sessionStart = CommandBuilders.startSession(actionId: "a1", title: "Write", minutes: 45.4, at: made, id: "c2")
    check(CommandRequests.body(sessionStart)["plannedMinutes"] as? Int == 45 && CommandRequests.body(sessionStart)["actionId"] as? String == "a1", "start body")
    check(CommandBuilders.startSession(actionId: "a1", title: "T", minutes: 5000, at: made).fields["plannedMinutes"] == .int(1440), "planned minutes are capped")
    let pauseKnown = CommandBuilders.sessionCommand(.pause, target: .known(sessionId: "s1", isActionSession: true), title: "Write", seenStatus: "running", at: made, id: "c3")
    check(pauseKnown.type == "pause" && pauseKnown.kind == .session && CommandRequests.request(pauseKnown, origin: origin, token: "t")?.url?.path == "/api/commands/session", "pause is a session command")
    let pauseActivity = CommandBuilders.sessionCommand(.pause, target: .known(sessionId: "s1", isActionSession: false), title: "Nap", seenStatus: "running", at: made, id: "c4")
    check(pauseActivity.type == "pause_activity" && CommandRequests.request(pauseActivity, origin: origin, token: "t")?.url?.path == "/api/commands/activity", "an activity session pauses through the activity route")
    let stop = CommandBuilders.sessionCommand(.stopWithRemaining(minutes: 20, words: "about 20 left"), target: .known(sessionId: "s1", isActionSession: true), title: "W", seenStatus: "running", at: made, id: "c5")
    check(stop.fields["outcome"] == .string("progress") && stop.fields["remainingMinutes"] == .int(20) && stop.fields["note"] == .string("about 20 left"), "stop for now sends his words and the minutes he said")
    let unsure = CommandBuilders.sessionCommand(.stopUnsure(words: "dunno"), target: .known(sessionId: "s1", isActionSession: true), title: "W", seenStatus: "running", at: made, id: "c6")
    check(unsure.fields["outcome"] == .string("unsure") && unsure.fields["remainingMinutes"] == nil, "words without minutes are sent as unsure, no minutes")
    let done = CommandBuilders.sessionCommand(.done, target: .known(sessionId: "s1", isActionSession: true), title: "W", seenStatus: "running", at: made, id: "c7")
    check(done.type == "finish" && done.fields["outcome"] == .string("completed") && done.fields["note"] == nil, "Done is finish completed")
    check(CommandRequests.request(answerYes, origin: "http://p.example.com", token: "tok") == nil, "no command over http")
    let roundTrip = try? JSONDecoder().decode(OutboxCommand.self, from: JSONEncoder().encode(answerYes))
    check(roundTrip == answerYes, "a queued command survives encoding")

    // Reading replies
    let reply = CommandResults.interpret(answer(200, "{\"state\":{\"activeSession\":{\"id\":\"s9\",\"version\":4,\"status\":\"running\",\"actionId\":\"a1\"}},\"occurredAt\":{\"claimedAt\":\"x\",\"applied\":false,\"appliedAt\":\"y\",\"reason\":\"overlap\",\"message\":\"Recorded at 4:10 pm, when the server received it, because it overlapped.\"}}"))
    if case .applied(let parsed) = reply {
        check(parsed.sessionId == "s9" && parsed.sessionVersion == 4 && parsed.report?.applied == false && parsed.report?.message.hasPrefix("Recorded at 4:10 pm") == true, "reply decoded")
    } else { check(false, "a 200 is applied") }
    check(CommandResults.interpret(nil) == .retry(afterSeconds: nil), "no answer retries")
    check(CommandResults.interpret(answer(503, "{\"committed\":true,\"retryable\":true}", retryAfter: 2)) == .retry(afterSeconds: 2), "a 503 retries with the same id")
    check(CommandResults.interpret(answer(401)) == .revoked, "401 revokes")
    if case .held(let message) = CommandResults.interpret(answer(409, "{\"error\":\"Session changed.\",\"currentVersion\":5}")) {
        check(message == "Session changed.", "a 409 is held with the server's words")
    } else { check(false, "a 409 is held") }
    if case .held = CommandResults.interpret(answer(400, "{\"error\":\"nope\"}")) {} else { check(false, "a 400 is held") }
    check(CommandResults.interpret(answer(429, "{}", retryAfter: 9)) == .retry(afterSeconds: 9), "429 retries after the wait")

    // Outbox
    func cmd(_ id: String, _ key: String, at offset: TimeInterval = 0, type: String = "pause", kind: CommandKind = .session, sessionId: String? = nil, version: Int? = nil) -> OutboxCommand {
        OutboxCommand(commandId: id, madeAt: made.addingTimeInterval(offset), kind: kind, type: type, label: "Cmd \(id)", entityKey: key,
                      sessionId: sessionId, fields: [:], expectedVersion: version, seenStatus: nil, attempts: 0, nextAttemptAt: nil, hold: nil)
    }
    let clock0 = Date(timeIntervalSince1970: 3_000_000)
    var box = CommandOutbox()
    box.enqueue(cmd("a", "session:s1", sessionId: "s1"))
    box.enqueue(cmd("b", "check-in:c1", type: "answer_check_in", kind: .checkIn))
    box.enqueue(cmd("c", "session:s1", sessionId: "s1", version: 3))
    check(box.next(now: clock0) == .send(box.items[0]), "commands go in the order they were made")
    _ = box.apply(.applied(CommandReply(report: nil, sessionId: "s1", sessionVersion: 7, sessionStatus: "paused")), to: "a", now: clock0)
    check(box.items.map { $0.commandId } == ["b", "c"] && box.items[1].expectedVersion == 7, "the next command on the entity takes the version the reply returned")
    check(box.outcomes.last?.kind == .applied, "an applied command is recorded")
    // A network failure stops everything, in order, with backoff
    check(box.apply(.retry(afterSeconds: nil), to: "b", now: clock0) == .stop, "a network failure stops the drain")
    if case .wait(let until) = box.next(now: clock0) { check(until == clock0.addingTimeInterval(5), "first retry waits 5 seconds") } else { check(false, "the head backs off and nothing jumps ahead") }
    check(box.next(now: clock0.addingTimeInterval(6)) != .nothing, "after the wait it is sent again")
    check(CommandOutbox.backoff(attempts: 1) == 5 && CommandOutbox.backoff(attempts: 3) == 20 && CommandOutbox.backoff(attempts: 30) == 300, "backoff doubles to a cap")
    _ = box.apply(.retry(afterSeconds: 60), to: "b", now: clock0)
    if case .wait(let until) = box.next(now: clock0) { check(until == clock0.addingTimeInterval(60), "Retry-After is honoured") } else { check(false, "wait") }
    // A refusal holds its entity's later commands; other entities keep going
    var held = CommandOutbox()
    held.enqueue(cmd("h1", "session:s1", sessionId: "s1"))
    held.enqueue(cmd("h2", "session:s1", sessionId: "s1", version: 2))
    held.enqueue(cmd("h3", "check-in:c9", type: "answer_check_in", kind: .checkIn))
    check(held.apply(.held(message: "Session changed."), to: "h1", now: clock0) == .continueDraining, "a refusal does not stop other entities")
    check(held.next(now: clock0) == .send(held.items[2]), "the later command on the same entity waits; another entity goes")
    check(held.isHeld(entityKey: "session:s1") && held.heldItems.count == 1 && held.outcomes.last?.kind == .held, "the refusal is held and recorded")
    held.retryHeld(commandId: "h1")
    check(held.heldItems.isEmpty && held.items[0].expectedVersion == nil, "Try again clears the hold and looks the version up afresh")
    var answerHeld = CommandOutbox()
    answerHeld.enqueue(CommandBuilders.answerCheckIn(checkInId: "c1", title: "T", choice: .yes, words: nil, expectedVersion: 4, at: made, id: "a-held"))
    _ = answerHeld.apply(.held(message: "Changed."), to: "a-held", now: clock0)
    answerHeld.retryHeld(commandId: "a-held")
    check(answerHeld.items[0].expectedVersion == nil && answerHeld.heldItems.isEmpty, "Try again on a check-in answer clears its stale version too")
    _ = held.apply(.held(message: "again"), to: "h1", now: clock0)
    held.drop(commandId: "h1", now: clock0)
    check(held.items.map { $0.commandId } == ["h3"] && held.outcomes.filter { $0.kind == .dropped }.count == 2, "Drop removes the command and the ones that depended on it, and says so")
    // A queued start: later commands wait for the session id
    var chain = CommandOutbox()
    chain.enqueue(CommandBuilders.startSession(actionId: "a1", title: "Write", minutes: 30, at: made, id: "s-start"))
    chain.enqueue(CommandBuilders.sessionCommand(.pause, target: .pendingStart(actionId: "a1"), title: "Write", seenStatus: "running", at: made.addingTimeInterval(60), id: "s-pause"))
    chain.enqueue(CommandBuilders.sessionCommand(.resume, target: .pendingStart(actionId: "a1"), title: "Write", seenStatus: "paused", at: made.addingTimeInterval(120), id: "s-resume"))
    check(chain.items.allSatisfy { $0.entityKey == "action:a1" } && chain.items[1].sessionId == nil, "commands after a queued start are keyed by its action")
    _ = chain.apply(.applied(CommandReply(report: nil, sessionId: "S1", sessionVersion: 2, sessionStatus: "running")), to: "s-start", now: clock0)
    check(chain.items.map { $0.entityKey } == ["session:S1", "session:S1"] && chain.items[0].sessionId == "S1" && chain.items[0].expectedVersion == 2 && chain.items[1].expectedVersion == nil, "the start's reply names the session; only the first later command takes its version")
    _ = chain.apply(.applied(CommandReply(report: nil, sessionId: "S1", sessionVersion: 3, sessionStatus: "paused")), to: "s-pause", now: clock0)
    check(chain.items[0].expectedVersion == 3, "each reply feeds the next command, so the app never conflicts with itself")
    _ = chain.apply(.applied(CommandReply(report: nil, sessionId: nil, sessionVersion: nil, sessionStatus: nil)), to: "s-resume", now: clock0)
    check(chain.isEmpty, "the chain drains")
    // Replies in words
    var words = CommandOutbox()
    words.enqueue(answerYes)
    _ = words.apply(.applied(CommandReply(report: OccurredAtReport(claimedAt: "a", applied: false, appliedAt: "b", reason: "overlap", message: "Recorded at 4:10 pm, when the server received it, because it overlapped.", delivered: nil), sessionId: nil, sessionVersion: nil, sessionStatus: nil)), to: "c1", now: clock0)
    check(words.outcomes.last?.kind == .atReceipt && words.outcomes.last?.message.contains("when the server received it") == true, "the 'applied at receipt time because' sentence is shown")
    words.enqueue(CommandBuilders.answerCheckIn(checkInId: checkInId, title: "Write", choice: .yes, words: "late", expectedVersion: nil, at: made, id: "c8"))
    _ = words.apply(.applied(CommandReply(report: OccurredAtReport(claimedAt: "a", applied: false, appliedAt: "b", reason: "the check-in closed", message: "Not delivered: the check-in closed.", delivered: false), sessionId: nil, sessionVersion: nil, sessionStatus: nil)), to: "c8", now: clock0)
    check(words.outcomes.last?.kind == .notDelivered && words.outcomes.last?.message.hasPrefix("Not delivered: the check-in closed while you were offline.") == true, "a closed check-in reply is shown honestly")
    // A revoked token ends the queue
    var revoked = CommandOutbox()
    revoked.enqueue(cmd("r1", "session:s1", sessionId: "s1"))
    check(revoked.apply(.revoked, to: "r1", now: clock0) == .signedOut && revoked.isEmpty && revoked.outcomes.isEmpty, "a 401 empties the queue")
    // Persistence
    let boxFile = PrivateJSONFile<CommandOutbox>(directory: URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("openrhen-box-\(UUID().uuidString)"), name: "commands.json")
    check(boxFile.save(chain) && boxFile.load() == chain, "the queue survives a restart")
    held.enqueue(cmd("z", "session:s2"))
    check(boxFile.save(held) && boxFile.load() == held, "a held queue survives a restart with its outcomes")
    boxFile.delete()
    check(held.hasQueuedAnswer(forCheckIn: "c9") && !held.hasQueuedAnswer(forCheckIn: "zzz") && held.oldestMadeAt != nil, "queued answers are found")

    // Version lookup (from the client view)
    func versionView(session: String?, directive: String?) -> ClientView? {
        let sessionJSON = session ?? "null"
        let nowJSON = directive.map { "{\"directive\":\($0),\"anchors\":{\"open\":[],\"engaged\":[]},\"needs\":[]}" } ?? "null"
        let text = "{\"schemaVersion\":1,\"timezone\":\"UTC\",\"planCurrent\":true,\"validUntil\":null,\"now\":\(nowJSON),\"pending\":{\"checkIn\":null,\"session\":\(sessionJSON),\"leaveBy\":null,\"placeSuggestion\":null}}"
        return ClientViewCodec.decodeView(jsonObject(text))
    }
    func sessionJSON(_ status: String, version: Int?) -> String {
        let v = version.map { "\"version\":\($0)," } ?? ""
        return "{\"id\":\"S1\",\"status\":\"\(status)\",\(v)\"title\":\"Write\",\"targetType\":null,\"targetId\":null,\"startedAt\":\"2026-11-10T09:00:00Z\",\"plannedEndAt\":\"2026-11-10T09:45:00Z\",\"plannedMinutes\":45,\"elapsedMinutes\":5,\"minutesLeft\":40}"
    }
    func directiveJSON(kind: String, target: String, version: Int?) -> String {
        let v = version.map { ",\"expectedVersion\":\($0)" } ?? ""
        return "{\"kind\":\"\(kind)\",\"title\":\"Write\",\"recommendedMinutes\":45,\"targetId\":\"\(target)\"\(v)}"
    }
    func sessionCmd(_ id: String, _ type: String, entity: String = "session:S1", sessionId: String? = "S1", seen: String = "running") -> OutboxCommand {
        OutboxCommand(commandId: id, madeAt: made, kind: .session, type: type, label: "Pause", entityKey: entity, sessionId: sessionId, fields: [:], expectedVersion: nil, seenStatus: seen, attempts: 0, nextAttemptAt: nil, hold: nil)
    }
    if let running = versionView(session: sessionJSON("running", version: 5), directive: nil),
       let idle = versionView(session: nil, directive: directiveJSON(kind: "action", target: "a1", version: 8)),
       let noVersion = versionView(session: sessionJSON("running", version: nil), directive: nil) {
        check(running.pending?.session?.version == 5 && idle.now?.directive?.expectedVersion == 8, "the view's session version and directive expectedVersion decode")
        check(sessionCmd("p0", "pause").needsVersionLookup, "a session command without a version needs a lookup")
        check(VersionResolution.resolve(sessionCmd("p1", "pause"), view: running) == .send(expectedVersion: 5, sessionId: "S1"), "a pause takes the session's version when it is as the person left it")
        if case .conflict(let sentence) = VersionResolution.resolve(sessionCmd("p2", "resume", seen: "paused"), view: running) {
            check(sentence.contains("now running") && sentence.contains("paused"), "a changed session is explained, not overwritten")
        } else { check(false, "a changed session is a conflict") }
        if case .conflict = VersionResolution.resolve(sessionCmd("p3", "pause", entity: "session:OTHER", sessionId: "OTHER"), view: running) {} else { check(false, "another session is not touched") }
        check(VersionResolution.resolve(sessionCmd("p4", "pause", entity: "action:a1", sessionId: nil), view: running) == .send(expectedVersion: 5, sessionId: "S1"), "a command waiting on its start finds the session")
        if case .conflict = VersionResolution.resolve(sessionCmd("p5", "pause"), view: idle) {} else { check(false, "no open session is a conflict") }
        if case .conflict = VersionResolution.resolve(sessionCmd("p6", "pause"), view: noVersion) {} else { check(false, "a session without a version is a conflict, not a guess") }
        if case .conflict = VersionResolution.resolve(CommandBuilders.startSession(actionId: "a1", title: "T", minutes: 10, at: made), view: running) {} else { check(false, "a start while a session is open is a conflict") }
        check(VersionResolution.resolve(CommandBuilders.startSession(actionId: "a1", title: "T", minutes: 10, at: made), view: idle) == .send(expectedVersion: 8, sessionId: nil), "a start names the directive's expectedVersion")
        if case .conflict = VersionResolution.resolve(CommandBuilders.startSession(actionId: "gone", title: "T", minutes: 10, at: made), view: idle) {} else { check(false, "a start on a task that is no longer the directive is a conflict") }
        if let travel = versionView(session: nil, directive: directiveJSON(kind: "travel", target: "a1", version: 8)) {
            if case .conflict = VersionResolution.resolve(CommandBuilders.startSession(actionId: "a1", title: "T", minutes: 10, at: made), view: travel) {} else { check(false, "a start needs an action directive") }
        } else { check(false, "a travel directive view decodes") }
        if let bare = versionView(session: nil, directive: directiveJSON(kind: "action", target: "a1", version: nil)) {
            if case .conflict = VersionResolution.resolve(CommandBuilders.startSession(actionId: "a1", title: "T", minutes: 10, at: made), view: bare) {} else { check(false, "a start without an expectedVersion is a conflict, not a guess") }
        } else { check(false, "a directive without a version decodes") }
    } else { check(false, "the version views decode") }

    // Session controls
    if let view = decodedViews.first {
        var noSession = view
        noSession = ClientView(schemaVersion: 1, timezone: view.timezone, planCurrent: true, validUntil: nil, now: view.now, day: view.day,
                               pending: ClientPending(checkIn: nil, session: nil, leaveBy: nil, placeSuggestion: nil))
        let empty = CommandOutbox()
        check(SessionControls.make(view: view, outbox: empty).actions == [.pause, .done, .stopForNow], "a running session offers pause, done and stop for now")
        check(SessionControls.make(view: noSession, outbox: empty).actions == [.start(actionId: "action-1", title: "Write section 2", minutes: 45)], "no session offers to start the directive")
        var queued = CommandOutbox()
        queued.enqueue(CommandBuilders.sessionCommand(.pause, target: .known(sessionId: "session-1", isActionSession: true), title: "W", seenStatus: "running", at: made, id: "q1"))
        let afterPause = SessionControls.make(view: view, outbox: queued)
        check(afterPause.status == "paused" && afterPause.actions == [.resume, .done, .stopForNow] && afterPause.pendingNote != nil, "a queued pause shows as paused, not sent yet")
        var startQueued = CommandOutbox()
        startQueued.enqueue(CommandBuilders.startSession(actionId: "action-1", title: "Write section 2", minutes: 45, at: made, id: "q2"))
        let afterStart = SessionControls.make(view: noSession, outbox: startQueued)
        check(afterStart.status == "running" && afterStart.actions == [.pause, .done, .stopForNow] && afterStart.target == .pendingStart(actionId: "action-1"), "a queued start shows as running and can be paused offline")
        _ = startQueued.apply(.held(message: "Another session is open."), to: "q2", now: clock0)
        let blocked = SessionControls.make(view: noSession, outbox: startQueued)
        check(blocked.actions.isEmpty && blocked.blockedNote == "Another session is open.", "a refused command blocks the controls and says why")
        var finished = CommandOutbox()
        finished.enqueue(CommandBuilders.sessionCommand(.done, target: .known(sessionId: "session-1", isActionSession: true), title: "W", seenStatus: "running", at: made, id: "q3"))
        check(SessionControls.make(view: view, outbox: finished).status == nil, "a queued Done ends the session on screen")
    }

    // Sources words
    let sNow = Date(timeIntervalSince1970: 5_000_000)
    check(SourcesWords.lastHeard(nil, now: sNow, zone: utc) == "Not heard from your server yet.", "never heard")
    check(SourcesWords.lastHeard(sNow.addingTimeInterval(-30), now: sNow, zone: utc) == "Last heard just now.", "heard just now")
    check(SourcesWords.lastHeard(ApiDates.parse("2026-11-10T09:05:00+11:00"), now: ApiDates.parse("2026-11-10T09:30:00+11:00")!, zone: sydney) == "Last heard at 09:05.", "heard at a time")
    check(SourcesWords.liveMode(.polling).contains("minute") && SourcesWords.liveMode(.stream).hasPrefix("Live"), "live mode words")
    var queueBox = CommandOutbox()
    check(SourcesWords.queue(queueBox, now: sNow) == SourcesWords.QueueSummary(headline: "Nothing is waiting to be sent.", warning: nil), "empty queue")
    queueBox.enqueue(cmd("w1", "session:s1", at: sNow.timeIntervalSince(made) - 2 * 86_400, sessionId: "s1"))
    check(SourcesWords.queue(queueBox, now: sNow).warning?.contains("over a day") == true, "a day-old command warns")
    var weekBox = CommandOutbox()
    weekBox.enqueue(cmd("w2", "session:s1", at: sNow.timeIntervalSince(made) - 8 * 86_400, sessionId: "s1"))
    check(SourcesWords.queue(weekBox, now: sNow).warning?.contains("week") == true, "a week-old command warns harder")

    // Words about what is left
    check(RemainingParser.minutes(from: "about 20 minutes") == 20 && RemainingParser.minutes(from: "20 min") == 20, "minutes read from words")
    check(RemainingParser.minutes(from: "2 hours and 15 minutes") == 135 && RemainingParser.minutes(from: "1.5 hours") == 90 && RemainingParser.minutes(from: "1h") == 60, "hours read from words")
    check(RemainingParser.minutes(from: "half an hour") == 30 && RemainingParser.minutes(from: "an hour and a half") == 90 && RemainingParser.minutes(from: "a quarter of an hour") == 15, "spoken amounts")
    check(RemainingParser.minutes(from: "nothing left") == 0, "nothing left is zero")
    check(RemainingParser.minutes(from: "  All done ") == 0 && RemainingParser.minutes(from: "finished") == 0, "the whole text saying nothing is left is zero")
    check(RemainingParser.minutes(from: "finished the intro, 40 minutes left") == 40, "a number beats a word that only starts the text")
    check(RemainingParser.minutes(from: "I did nothing, 2 hours left") == 120, "a number beats a word that only ends in the text")
    check(RemainingParser.minutes(from: "I did nothing") == nil && RemainingParser.minutes(from: "finished the intro") == nil, "nothing/finished inside other words is not an answer")
    check(RemainingParser.minutes(from: "20") == nil && RemainingParser.minutes(from: "20", bareNumberIsMinutes: true) == 20, "a bare number is minutes only when minutes were asked for")
    check(RemainingParser.minutes(from: "quite a lot") == nil && RemainingParser.minutes(from: "") == nil, "no number, no answer")
    var flow = StopForNowFlow()
    check(flow.submit("a fair bit") == .askAgain && flow.phase == .askingAgain, "unreadable words are asked about once more")
    check(flow.submit("still not sure") == .send(.unsure(words: "a fair bit - still not sure")), "still unreadable: his words go as they are, with no minutes")
    var flow2 = StopForNowFlow()
    check(flow2.submit("about 25 minutes") == .send(.minutes(25, words: "about 25 minutes")), "readable words go straight through")
    var flow3 = StopForNowFlow()
    _ = flow3.submit("some")
    check(flow3.submit("30") == .send(.minutes(30, words: "some - 30")), "the second ask takes a bare number")
    var flow4 = StopForNowFlow()
    _ = flow4.submit("later")
    check(flow4.sendWordsOnly() == .send(.unsure(words: "later")), "he can send his words as they are")
}
liveDayChecks(fixturesPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : nil,
              schemaPath: CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : nil)

// MARK: Sign out revokes the phone's own credential first
let credId = "0b7e5f0e-1d2c-4c53-9f0a-2f6d3c1a9b11"
if let revokeRequest = ApiRequests.revokeOwnCredential(origin: "https://p.example.com", token: "tokR", credentialId: credId) {
    check(revokeRequest.httpMethod == "DELETE" && revokeRequest.url?.absoluteString == "https://p.example.com/api/owner/credentials/\(credId)", "revoke is a DELETE on the credential")
    check(revokeRequest.value(forHTTPHeaderField: ApiRequests.ownerHeader) == "tokR" && revokeRequest.httpBody == nil, "revoke carries the owner token and no body")
} else { check(false, "the revoke request builds") }
check(ApiRequests.revokeOwnCredential(origin: "https://p.example.com", token: "t", credentialId: "../x") == nil && ApiRequests.revokeOwnCredential(origin: "https://p.example.com", token: "t", credentialId: "") == nil, "a credential id that is not plain is never sent")
check(ApiRequests.revokeOwnCredential(origin: "http://p.example.com", token: "t", credentialId: credId) == nil, "revoke is https only")
check(SignOutRevoke.interpret(answer(200)) == .revoked && SignOutRevoke.interpret(answer(401)) == .revoked && SignOutRevoke.interpret(answer(404)) == .revoked, "revoked, or already gone, is a clean sign-out")
check(SignOutRevoke.interpret(nil) == .offline && SignOutRevoke.interpret(answer(500)) == .refused && SignOutRevoke.interpret(answer(403)) == .refused, "no answer is offline; a refusal is refused")
check(SignOutRevoke.revoked.notice == nil, "a confirmed revoke needs no notice")
check(SignOutRevoke.offline.notice?.contains("could not be reached") == true && SignOutRevoke.offline.notice?.contains("Devices") == true, "an offline sign-out says the phone is still listed")
check(SignOutRevoke.refused.notice != nil && SignOutRevoke.notAttempted.notice != nil, "every unconfirmed sign-out says so")
let revokeStore = InMemoryCredentialStore()
let revokeCore = SessionCore(store: revokeStore)
check(revokeCore.complete(token: "tokR", origin: "https://p.example.com", credentialId: credId) && revokeStore.loadSession()?.credentialId == credId, "the credential id is kept at sign-in")
if let saved = try? JSONEncoder().encode(DeviceSession(token: "a", origin: "https://p.example.com")),
   let old = try? JSONDecoder().decode(DeviceSession.self, from: Data("{\"token\":\"a\",\"origin\":\"https://p.example.com\"}".utf8)) {
    check(old.credentialId == nil && !saved.isEmpty, "a session stored before the id was kept still loads")
} else { check(false, "an older stored session decodes") }
revokeCore.signOut(notice: SignOutRevoke.offline.notice)
check(revokeCore.state.session == nil && revokeStore.loadSession() == nil && revokeCore.state.notice == SignOutRevoke.offline.notice, "an offline sign-out still signs out locally and shows why")


// MARK: Phone as sensor (slice 5): Health to physiology rows, the sensor queue, wakes and words
func sensorChecks() {
    let base = Date(timeIntervalSince1970: 1_793_998_800) // 2026-11-06T21:00:00Z, an hour boundary
    let zone10: (Date) -> Int = { _ in 600 }
    func rows(_ list: [PlannedRow], _ kind: String) -> [PlannedRow] { list.filter { $0.kind == kind } }
    func intList(_ value: SensorValue?) -> [Int] {
        guard case .array(let items)? = value else { return [] }
        return items.compactMap { item -> Int? in if case .int(let number) = item { return number }; return nil }
    }

    // The alive signal's key is the one the server demands: hb:<device>:<UTC hour>:ok
    check(SensorHeartbeat.id(device: "abc", at: base.addingTimeInterval(125)) == "hb:abc:2026-11-06T21:ok", "heartbeat key names the device and the UTC hour")
    check(SensorHeartbeat.event(device: "abc", now: base).source == "phone" && SensorHeartbeat.event(device: "abc", now: base).kind == "heartbeat", "heartbeat is source phone, kind heartbeat")
    check(SensorDevice.label(fromInstallId: "abc-DEF_1.2:3") == "abc-DEF_1.2:3" && SensorDevice.label(fromInstallId: "ab c|d") == "abcd", "the device label keeps only the characters the server allows")
    check(SensorDevice.label(fromInstallId: "") == nil && SensorDevice.label(fromInstallId: String(repeating: "a", count: 70))?.count == 64, "an empty label is nothing; a long one is cut to 64")

    // Local date of waking
    let wake = Date(timeIntervalSince1970: 1_794_002_400 + 3600 * 1) // 2026-11-06T23:00Z + 1h = 2026-11-07T00:00Z
    check(HealthRows.localDate(wake, offsetMin: 600) == "2026-11-07" && HealthRows.localDate(wake, offsetMin: -300) == "2026-11-06", "local date follows the offset")

    // Steps: ended hours only, none empty, rounded
    let now3 = base.addingTimeInterval(3 * 3600)
    let stepRows = HealthRows.steps([
        HourlyValue(hourStart: base, value: 99.6),
        HourlyValue(hourStart: base.addingTimeInterval(3600), value: 0),
        HourlyValue(hourStart: base.addingTimeInterval(2 * 3600), value: 500),
    ], now: now3, offset: zone10)
    check(stepRows.count == 1 && stepRows[0].period == "2026-11-06T21:00:00.000Z" && stepRows[0].attrs["steps"] == .int(100), "steps: the ended hour is a row, rounded; an empty hour and an unsettled one are not")
    check(stepRows.first?.tzOffsetMin == 600 && stepRows.first?.end == nil, "steps carry the offset and no end")

    // Heart rate: irregular readings, one a second, out-of-range ones dropped, whole numbers
    let hrRows = HealthRows.heartRate([
        Reading(at: base.addingTimeInterval(10), value: 60.4), Reading(at: base.addingTimeInterval(20), value: 70.2),
        Reading(at: base.addingTimeInterval(20.7), value: 99), Reading(at: base.addingTimeInterval(30), value: 80),
        Reading(at: base.addingTimeInterval(40), value: 300), Reading(at: base.addingTimeInterval(50), value: 10),
        Reading(at: base.addingTimeInterval(2 * 3600 + 5), value: 70),
    ], now: now3, offset: zone10)
    if let row = hrRows.first {
        check(hrRows.count == 1, "heart rate: only the settled hour is a row")
        check(intList(row.attrs["t"]) == [10, 20, 30] && intList(row.attrs["values"]) == [60, 70, 80], "heart rate: sorted distinct seconds; 300 and 10 bpm are dropped, not sent")
        check(row.attrs["step_s"] == .null && row.attrs["n"] == .int(3) && row.attrs["min"] == .int(60) && row.attrs["max"] == .int(80) && row.attrs["avg"] == .double(70), "heart rate: irregular, n/min/max/avg")
        check(row.attrs["coverage_s"] == .int(45) && row.attrs["unit"] == .string("bpm") && row.period == "2026-11-06T21:00:00.000Z", "heart rate: coverage is 15 s per slot with a reading; unit bpm")
    } else { check(false, "heart rate row built") }
    var dense: [Reading] = []
    for index in 0..<500 { dense.append(Reading(at: base.addingTimeInterval(Double(index) * 7), value: Double(50 + index % 40))) }
    if let thin = HealthRows.heartRate(dense, now: now3, offset: zone10).first {
        let offsets = intList(thin.attrs["t"])
        check(offsets.count <= 240 && offsets == offsets.sorted() && Set(offsets).count == offsets.count && intList(thin.attrs["values"]).count == offsets.count, "heart rate: more than 240 readings are thinned to at most 240, sorted and distinct")
        check(thin.attrs["n"] == .int(offsets.count), "heart rate: n counts the readings kept")
    } else { check(false, "dense heart rate row built") }
    check(HealthRows.heartRate([Reading(at: base.addingTimeInterval(5), value: 70)], now: base.addingTimeInterval(1800), offset: zone10).isEmpty, "an hour that has not settled is not built")
    check(HealthRows.heartRate([Reading(at: base.addingTimeInterval(5), value: 5)], now: now3, offset: zone10).isEmpty, "an hour with only out-of-range readings is not built")

    // Variability: SDNN in ms with one decimal
    if let hrv = HealthRows.heartRateVariability([Reading(at: base.addingTimeInterval(60), value: 42.345)], now: now3, offset: zone10).first {
        check(hrv.kind == "hrv" && hrv.attrs["method"] == .string("sdnn") && hrv.attrs["unit"] == .string("ms") && hrv.attrs["values"] == .array([.double(42.3)]), "hrv: method sdnn, unit ms, one decimal")
    } else { check(false, "hrv row built") }

    // Sleep: overlaps flattened (specific stage wins), a nap is not a night, the date is the local date of waking
    let hour: TimeInterval = 3600
    let night: [SleepPiece] = [
        SleepPiece(start: base, end: base.addingTimeInterval(8 * hour), stage: .inBed, raw: "inBed"),
        SleepPiece(start: base, end: base.addingTimeInterval(8 * hour), stage: .asleep, raw: "asleepUnspecified"),
        SleepPiece(start: base.addingTimeInterval(600), end: base.addingTimeInterval(3 * hour), stage: .light, raw: "asleepCore"),
        SleepPiece(start: base.addingTimeInterval(3 * hour), end: base.addingTimeInterval(4 * hour), stage: .deep, raw: "asleepDeep"),
        SleepPiece(start: base.addingTimeInterval(4 * hour), end: base.addingTimeInterval(4 * hour + 300), stage: .awake, raw: "awake"),
        SleepPiece(start: base.addingTimeInterval(4 * hour + 300), end: base.addingTimeInterval(7 * hour), stage: .rem, raw: "asleepREM"),
    ]
    let flat = HealthRows.flatten(night)
    check(flat.map { $0.stage } == [.asleep, .light, .deep, .awake, .rem, .asleep], "sleep: where pieces overlap the more specific stage wins")
    check(flat.first?.start == base && flat.last?.end == base.addingTimeInterval(8 * hour), "sleep: segments cover the night without overlap")
    let nap = [SleepPiece(start: base.addingTimeInterval(20 * hour), end: base.addingTimeInterval(21 * hour), stage: .asleep, raw: nil)]
    let sleepRows = HealthRows.sleep(night + nap, now: base.addingTimeInterval(30 * hour), offset: zone10)
    if let row = sleepRows.first {
        check(sleepRows.count == 1, "sleep: a one-hour nap is not a night")
        check(row.period == "2026-11-07" && row.attrs["local_date"] == .string("2026-11-07") && row.start == base && row.end == base.addingTimeInterval(8 * hour), "sleep: keyed by the local date of waking; starts and ends with the night")
        if case .array(let segments)? = row.attrs["segments"], case .object(let last)? = segments.last {
            check(segments.count == 6 && last["end_s"] == .int(8 * 3600) && last["stage"] == .string("asleep"), "sleep: six segments, offsets from the start of the night")
        } else { check(false, "sleep segments present") }
    } else { check(false, "sleep row built") }
    check(HealthRows.sleep(night, now: base.addingTimeInterval(8 * hour + 600), offset: zone10).isEmpty, "sleep: a night that ended minutes ago is not built yet")
    check(HealthRows.sleep(nap, now: base.addingTimeInterval(40 * hour), offset: zone10).isEmpty, "sleep: only a nap is no row")
    var fragments: [SleepPiece] = []
    for index in 0..<400 { fragments.append(SleepPiece(start: base.addingTimeInterval(Double(index) * 120), end: base.addingTimeInterval(Double(index) * 120 + 60), stage: index % 2 == 0 ? .light : .awake, raw: nil)) }
    if let many = HealthRows.sleep(fragments, now: base.addingTimeInterval(40 * hour), offset: zone10).first, case .array(let segments)? = many.attrs["segments"] {
        check(segments.count <= HealthRows.maxSegments, "sleep: at most 200 segments, the shortest dropped first")
    } else { check(false, "fragmented sleep still builds a row") }

    // Sync window
    let last = base.addingTimeInterval(10 * 86_400 + 1234)
    let window = HealthSyncPlan.window(lastGoodRead: last, now: last.addingTimeInterval(600))
    check(window.from == HealthRows.hourStart(last.addingTimeInterval(-HealthSyncPlan.rereadWindow)) && window.sleepFrom == window.from.addingTimeInterval(-HealthSyncPlan.sleepExtra), "window: re-reads two days before the last good read, sleep a little earlier")
    check(HealthSyncPlan.window(lastGoodRead: nil, now: base).from == HealthRows.hourStart(base.addingTimeInterval(-HealthSyncPlan.firstLookback)), "window: the first read goes back a month")
    check(HealthSyncPlan.window(lastGoodRead: base.addingTimeInterval(-900 * 86_400), now: base).from >= base.addingTimeInterval(-HealthSyncPlan.maxLookback - 3600), "window: never older than the server takes")

    // The plan: versions, no repeats, replacement while queued, the next version while in the air, refusals
    let device = "abc123"
    func stepRow(_ steps: Int) -> PlannedRow {
        PlannedRow(kind: "steps", period: "2026-11-06T21:00:00.000Z", start: base, end: nil, tzOffsetMin: 600, attrs: ["steps": .int(steps)])
    }
    var state = SensorState()
    check(state.plan([stepRow(100)], device: device, now: base) == 1 && state.items.first?.id == "steps|abc123|2026-11-06T21:00:00.000Z|v0", "plan: a new period is version 0 under the canonical key")
    check(state.items.first?.attrs["device"] == .string(device) && state.items.first?.attrs["route"] == .string("phone-app") && state.items.first?.attrs["v"] == .int(0) && state.items.first?.source == "physiology", "plan: every row carries device, route and v")
    check(state.plan([stepRow(100)], device: device, now: base) == 0 && state.count == 1, "plan: the same content is not queued twice")
    check(state.plan([stepRow(150)], device: device, now: base) == 1 && state.count == 1 && state.items.first?.attrs["steps"] == .int(150) && state.items.first?.v == 0, "plan: a queued row not yet sent takes the newer content at the same version")
    guard case .send(let first) = state.nextBatch(now: base) else { check(false, "a batch is picked"); return }
    check(first.count == 1 && state.sending.contains(first[0].id), "the batch is marked as in the air")
    check(state.plan([stepRow(180)], device: device, now: base) == 1 && state.count == 2 && state.items.last?.v == 1, "plan: a change while the first is in the air is the next version")
    check(state.apply(.accepted(rejected: []), sent: first, now: base) == .continueDraining && state.count == 1 && state.ledger["steps|abc123|2026-11-06T21:00:00.000Z"]?.v == 0, "an accepted row leaves the queue and is remembered")
    check(state.plan([stepRow(150)], device: device, now: base) == 0, "plan: content the server already has is not sent again")
    guard case .send(let second) = state.nextBatch(now: base) else { check(false, "second batch picked"); return }
    _ = state.apply(.accepted(rejected: [SensorRejection(index: 0, reason: "attrs.v is wrong")]), sent: second, now: base.addingTimeInterval(5))
    check(state.count == 0 && state.setAside.count == 1 && state.setAside[0].message == "attrs.v is wrong" && state.setAside[0].label == "Steps for 2026-11-06T21:00 UTC", "a refused row is set aside with the server's reason")
    check(state.plan([stepRow(180)], device: device, now: base) == 0, "plan: refused content is not sent again")
    check(state.plan([stepRow(200)], device: device, now: base) == 1 && state.items.first?.v == 1, "plan: changed content after a refusal is the next version")

    // Heartbeat: one an hour
    var beat = SensorState()
    check(beat.planHeartbeat(device: device, now: base) && !beat.planHeartbeat(device: device, now: base.addingTimeInterval(600)) && beat.count == 1, "heartbeat: one queued per UTC hour")
    check(beat.planHeartbeat(device: device, now: base.addingTimeInterval(3700)) && beat.count == 2, "heartbeat: the next hour queues another")

    // Batches: the byte limit, backoff, a refused batch split down to the one at fault, a revoked phone
    var big = SensorState()
    let blob = String(repeating: "a", count: 600_000)
    for index in 0..<3 {
        big.plan([PlannedRow(kind: "steps", period: "p\(index)", start: base, end: nil, tzOffsetMin: nil, attrs: ["blob": .string(blob)])], device: device, now: base)
    }
    if case .send(let batch) = big.nextBatch(now: base) { check(batch.count == 1, "batch: a second 600 KB row would pass 1 MB, so the batch is one row") } else { check(false, "big batch picked") }
    var backoff = SensorState()
    backoff.plan([stepRow(1)], device: device, now: base)
    guard case .send(let sent) = backoff.nextBatch(now: base) else { check(false, "backoff batch"); return }
    check(backoff.apply(.retry(after: nil, note: "offline"), sent: sent, now: base) == .retryLater && backoff.notBefore == base.addingTimeInterval(5) && backoff.count == 1, "retry: the row stays and waits 5 s")
    check(backoff.nextBatch(now: base.addingTimeInterval(2)) == .wait(until: base.addingTimeInterval(5)), "retry: nothing is sent while backing off")
    if case .send(let again) = backoff.nextBatch(now: base.addingTimeInterval(6)) {
        _ = backoff.apply(.retry(after: 60, note: "busy"), sent: again, now: base.addingTimeInterval(6))
        check(backoff.notBefore == base.addingTimeInterval(66), "retry: a server wait longer than the backoff is honoured")
    } else { check(false, "retry batch picked") }
    check(SensorState.backoff(attempts: 1) == 5 && SensorState.backoff(attempts: 2) == 10 && SensorState.backoff(attempts: 30) == 300, "backoff doubles to five minutes")
    var split = SensorState()
    for index in 0..<4 { split.plan([PlannedRow(kind: "steps", period: "q\(index)", start: base, end: nil, tzOffsetMin: nil, attrs: ["steps": .int(index + 1)])], device: device, now: base) }
    guard case .send(let all) = split.nextBatch(now: base) else { check(false, "split batch"); return }
    check(all.count == 4, "batch: four small rows go together")
    _ = split.apply(.refused("too large"), sent: all, now: base)
    if case .send(let half) = split.nextBatch(now: base) { check(half.count == 2 && split.count == 4, "refused batch: tried again with half") } else { check(false, "half batch") }
    split = SensorState()
    split.plan([stepRow(1)], device: device, now: base)
    guard case .send(let lone) = split.nextBatch(now: base) else { check(false, "lone batch"); return }
    _ = split.apply(.refused("not valid JSON"), sent: lone, now: base)
    check(split.count == 0 && split.setAside.first?.message == "not valid JSON", "refused batch of one: set aside with the reason")
    var revoked = SensorState()
    revoked.plan([stepRow(1)], device: device, now: base)
    guard case .send(let doomed) = revoked.nextBatch(now: base) else { check(false, "revoked batch"); return }
    check(revoked.apply(.revoked, sent: doomed, now: base) == .signedOut && revoked.count == 0 && revoked.ledger.isEmpty, "a revoked phone empties the sensor queue")

    // What the server says
    check(SensorReply.interpret(answer(200, "{\"added\":1,\"rejected\":[{\"index\":2,\"reason\":\"bad key\"}]}")) == .accepted(rejected: [SensorRejection(index: 2, reason: "bad key")]), "reply: a 200 lists the rows it refused")
    check(SensorReply.interpret(answer(200, "not json")) == .accepted(rejected: []), "reply: a 200 is accepted even if the body is unreadable")
    check(SensorReply.interpret(answer(401, "{\"error\":\"x\"}")) == .revoked, "reply: 401 is a removed phone")
    check(SensorReply.interpret(answer(403, "{\"error\":\"This host is not allowed.\"}")) != .revoked && { if case .retry = SensorReply.interpret(answer(403, "{\"error\":\"This host is not allowed.\"}")) { return true }; return false }(), "reply: a host the server does not allow is retried, not blamed on the rows")
    check(SensorReply.interpret(answer(429, "{}", retryAfter: 30)) == .retry(after: 30, note: ApiError.rateLimited(retryAfter: 30).message), "reply: a rate limit waits as long as asked")
    check({ if case .retry = SensorReply.interpret(answer(503)) { return true }; return false }(), "reply: a 5xx is retried")
    check(SensorReply.interpret(answer(413, "{\"error\":\"too big\"}")) == .refused("too big"), "reply: a 413 is refused with the server's words")

    // The request
    if let request = ApiRequests.activityEvents(origin: "https://p.example.com", token: "tokS", installId: device, events: [SensorHeartbeat.event(device: device, now: base)]),
       let body = request.httpBody.flatMap({ String(data: $0, encoding: .utf8) }) {
        check(request.url?.absoluteString == "https://p.example.com/api/activity-events" && request.httpMethod == "POST" && request.value(forHTTPHeaderField: ApiRequests.ownerHeader) == "tokS", "request: POST /api/activity-events with the owner token")
        check(body.contains("\"device\":\"abc123\"") && body.contains("\"schema\":1") && body.contains("\"id\":\"hb:abc123:2026-11-06T21:ok\""), "request: the batch names the device and carries the heartbeat key")
    } else { check(false, "the batch request builds") }
    check(ApiRequests.activityEvents(origin: "http://p.example.com", token: "t", installId: device, events: []) == nil, "request: https only")
    check(SensorWire.data(.double(63.67)).flatMap { String(data: $0, encoding: .utf8) } == "63.67", "wire: a decimal is written as itself")

    // The file: the queue survives a restart, an older file still loads
    let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .secondsSince1970
    let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .secondsSince1970
    if let data = try? encoder.encode(state), let back = try? decoder.decode(SensorState.self, from: data) {
        check(back == state, "state: the queue, ledger and set-aside list survive the file")
    } else { check(false, "state encodes and decodes") }
    check((try? decoder.decode(SensorState.self, from: Data("{}".utf8)))?.count == 0, "state: a file with fewer fields still loads")
    var restarted = state
    _ = restarted.nextBatch(now: base)
    restarted.clearInFlight()
    check(restarted.sending.isEmpty, "state: a request lost at restart is no longer in the air")

    // Wakes: only background wakes count; one wake is not counted twice
    var wakes = WakeLog()
    for offset in [0.0, 600, 600.5, 1800] { wakes.record(.location, at: base.addingTimeInterval(offset), background: true) }
    wakes.record(.location, at: base.addingTimeInterval(2000), background: false)
    if let summary = wakes.summary(.location) {
        check(summary.wakes == 3 && summary.medianGap == 900 && summary.longestGap == 1200, "wakes: three background wakes, gaps 10 and 20 minutes")
    } else { check(false, "wake summary") }
    check(wakes.summary(.health) == nil, "wakes: none for a kind that never woke the app")
    let utc = TimeZone(secondsFromGMT: 0) ?? TimeZone.current
    check(SensorWords.wakes(wakes, zone: utc).first?.contains("woke the app in the background 3 times") == true && SensorWords.wakes(WakeLog(), zone: utc).isEmpty, "wake words: measured, and silent before any")

    // Words
    check(SensorWords.span(300) == "5 minutes" && SensorWords.span(3 * 3600) == "3 hours" && SensorWords.span(3 * 86_400) == "3 days", "span words")
    var waiting = SensorState()
    waiting.plan([stepRow(1)], device: device, now: base)
    check(SensorWords.queue(waiting, now: base.addingTimeInterval(60)).warning == nil && SensorWords.queue(waiting, now: base.addingTimeInterval(2 * 86_400)).warning?.contains("over a day") == true && SensorWords.queue(waiting, now: base.addingTimeInterval(8 * 86_400)).warning?.contains("week") == true, "queue words: a warning after a day, a stronger one after a week")
    check(SensorWords.queue(SensorState(), now: base).headline == "No sensor data is waiting to be sent.", "queue words: empty")
    check(SensorWords.serverSide.contains("does not yet tell"), "the screen says the server-side part is not there yet")
}
sensorChecks()

if failures > 0 { print("\(failures) check(s) failed"); exit(1) }
print("All checks passed")
