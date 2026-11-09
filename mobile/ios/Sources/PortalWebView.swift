import SwiftUI
import WebKit

/// The portal's own screens, locked to the portal origin (main frame and subframes). Camera uploads work through the page's
/// file input, so the photo check-in page needs no native bridge. Anything off the portal opens in
/// Safari; a failed load shows a message with Retry.
struct PortalWebView: View {
    let url: URL
    @StateObject private var model = WebModel()

    var body: some View {
        ZStack {
            WebContainer(url: url, model: model)
            if let message = model.errorMessage {
                VStack(spacing: 12) {
                    Text("Can't reach the portal").font(.headline)
                    Text(message).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Button("Retry") { model.retry() }.buttonStyle(.borderedProminent)
                }
                .padding(24)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(.systemBackground))
            }
        }
    }
}

final class WebModel: ObservableObject {
    @Published var errorMessage: String?
    weak var webView: WKWebView?
    var target: URL?

    func retry() {
        errorMessage = nil
        guard let webView else { return }
        if webView.url != nil { webView.reload() } else if let target { webView.load(URLRequest(url: target)) }
    }
}

private struct WebContainer: UIViewRepresentable {
    let url: URL
    let model: WebModel

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        let view = WKWebView(frame: .zero, configuration: config)
        view.allowsBackForwardNavigationGestures = true
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        model.webView = view
        model.target = url
        context.coordinator.portal = url
        view.load(URLRequest(url: url))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        if context.coordinator.portal != url {
            context.coordinator.portal = url
            model.target = url
            view.load(URLRequest(url: url))
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var portal: URL?
        let model: WebModel
        init(model: WebModel) { self.model = model }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let portal, let target = navigationAction.request.url else { return decisionHandler(.cancel) }
            if HostPolicy.isPortalOrigin(target, portal: portal) { return decisionHandler(.allow) }
            // Subframes are locked to the portal origin too; an off-portal embed is dropped, not sent to Safari.
            if navigationAction.targetFrame?.isMainFrame == false { return decisionHandler(.cancel) }
            if target.scheme == "http" || target.scheme == "https" { UIApplication.shared.open(target) }
            decisionHandler(.cancel)
        }

        // target=_blank: portal links load in this view, external ones go to Safari.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            guard let portal, let target = navigationAction.request.url else { return nil }
            if HostPolicy.isPortalOrigin(target, portal: portal) {
                webView.load(navigationAction.request)
            } else if target.scheme == "http" || target.scheme == "https" {
                UIApplication.shared.open(target)
            }
            return nil
        }

        func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { model.errorMessage = nil }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            show(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { show(error) }

        private func show(_ error: Error) {
            if (error as NSError).code == NSURLErrorCancelled { return }
            model.errorMessage = error.localizedDescription
        }
    }
}
