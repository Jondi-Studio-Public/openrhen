import Foundation

// Compiled with Sources/HostPolicy.swift by CI (`swiftc`); exits non-zero on the first failure.
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

if failures > 0 { print("\(failures) check(s) failed"); exit(1) }
print("All host policy checks passed")
