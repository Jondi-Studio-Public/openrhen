import Foundation

// Compiled with Sources/HostPolicy.swift and Sources/Policies.swift by CI (`swiftc`); exits non-zero on the first failure.
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

// Token origin binding
let bound = "https://p.example.com"
check(Policies.addressChange(boundOrigin: nil, newAddress: u("https://q.example.com/")) == .keepToken, "no token keeps")
check(Policies.addressChange(boundOrigin: bound, newAddress: u("https://P.example.com/other/path")) == .keepToken, "same origin keeps token")
check(Policies.addressChange(boundOrigin: bound, newAddress: u("https://p.example.com:443/")) == .keepToken, "explicit 443 keeps token")
check(Policies.addressChange(boundOrigin: bound, newAddress: u("https://q.example.com/")) == .clearToken, "other host clears token")
check(Policies.addressChange(boundOrigin: bound, newAddress: u("https://p.example.com:8443/")) == .clearToken, "other port clears token")
check(Policies.sendDecision(portal: u("https://p.example.com/now"), token: "t", boundOrigin: bound)
      == .send(u("https://p.example.com/api/location/ping")), "send to bound origin")
check(Policies.sendDecision(portal: u("https://q.example.com/"), token: "t", boundOrigin: bound) == .originMismatch(bound: bound), "no send to other origin")
check(Policies.sendDecision(portal: u("http://p.example.com/"), token: "t", boundOrigin: "http://p.example.com") == .notHTTPS, "http refused as not https")
check(Policies.sendDecision(portal: nil, token: "t", boundOrigin: bound) == .notConfigured, "no portal")
check(Policies.sendDecision(portal: u("https://p.example.com/"), token: nil, boundOrigin: bound) == .notConfigured, "no token")
check(Policies.sendDecision(portal: u("https://p.example.com/"), token: "", boundOrigin: bound) == .notConfigured, "empty token")
check(Policies.sendDecision(portal: u("https://p.example.com/"), token: "t", boundOrigin: nil) == .notConfigured, "no bound origin")

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

if failures > 0 { print("\(failures) check(s) failed"); exit(1) }
print("All host policy checks passed")
