// SafeKrit iOS: the one WKWebView and its policies.
//
// - Pages on dt.inferconautomation.com stay in the app; other web links open in Safari,
//   and tel:, mailto: and similar go to the system.
// - When a page cannot load because the network is down, the bundled offline page is
//   shown (like frontend/public/offline.html); its button retries the page that failed.
//   Nothing is cached by the app, so plant data is never shown from memory.
// - Cookies and local storage live in the default persistent store, so a login survives
//   relaunches.

import SwiftUI
import UIKit
import WebKit

@MainActor
final class Browser: NSObject, ObservableObject {
    static let shared = Browser()

    @Published private(set) var progress: Double = 0
    @Published private(set) var isLoading = false

    let webView: WKWebView
    private var observations: [NSKeyValueObservation] = []
    /// The page to load again when the offline page's button or pull-to-refresh is used.
    private var failedURL: URL?
    private var hasLoaded = false

    private static let retryMessage = "safekrit"

    private override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.applicationNameForUserAgent = AppConfig.userAgentSuffix
        configuration.allowsInlineMediaPlayback = true
        configuration.defaultWebpagePreferences.preferredContentMode = .mobile

        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()

        configuration.userContentController.add(WeakMessageHandler(self), name: Self.retryMessage)

        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.isOpaque = false
        webView.backgroundColor = UIColor(named: "Ground") ?? .systemGroupedBackground
        webView.scrollView.backgroundColor = webView.backgroundColor
        webView.underPageBackgroundColor = webView.backgroundColor
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif

        let refresh = UIRefreshControl()
        refresh.addTarget(self, action: #selector(pullToRefresh), for: .valueChanged)
        webView.scrollView.refreshControl = refresh

        observations = [
            webView.observe(\.estimatedProgress, options: [.new]) { [weak self] view, _ in
                Task { @MainActor in self?.progress = view.estimatedProgress }
            },
            webView.observe(\.isLoading, options: [.new]) { [weak self] view, _ in
                Task { @MainActor in self?.isLoading = view.isLoading }
            },
        ]
    }

    /// Loads the start page the first time the view appears.
    func loadStartIfNeeded() {
        guard !hasLoaded else { return }
        open(AppConfig.startURL)
    }

    func open(_ url: URL) {
        hasLoaded = true
        failedURL = nil
        webView.load(URLRequest(url: url))
    }

    func retry() {
        if let url = failedURL {
            open(url)
        } else if webView.url == nil {
            open(AppConfig.startURL)
        } else {
            webView.reload()
        }
    }

    @objc private func pullToRefresh() {
        retry()
    }

    private func endRefreshing() {
        webView.scrollView.refreshControl?.endRefreshing()
    }

    private func showOffline(for url: URL?) {
        failedURL = url ?? failedURL ?? AppConfig.startURL
        guard let page = Bundle.main.url(forResource: "offline", withExtension: "html") else { return }
        webView.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
    }

    private static func isNetworkError(_ error: Error) -> Bool {
        let error = error as NSError
        guard error.domain == NSURLErrorDomain else { return false }
        switch error.code {
        case NSURLErrorNotConnectedToInternet, NSURLErrorNetworkConnectionLost,
             NSURLErrorTimedOut, NSURLErrorCannotFindHost, NSURLErrorCannotConnectToHost,
             NSURLErrorDNSLookupFailed, NSURLErrorInternationalRoamingOff,
             NSURLErrorDataNotAllowed, NSURLErrorSecureConnectionFailed:
            return true
        default:
            return false
        }
    }

    private func presentingController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? scenes.first?.windows.first
        var top = window?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        return top
    }
}

// MARK: - Navigation

extension Browser: WKNavigationDelegate {
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url, let scheme = url.scheme?.lowercased() else {
            decisionHandler(.cancel)
            return
        }
        switch scheme {
        case "http", "https":
            let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? true
            if !isMainFrame || AppConfig.isInApp(url) {
                decisionHandler(.allow)
            } else {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
            }
        case "about", "blob", "data":
            decisionHandler(.allow)
        case "file":
            // Only the bundled offline page is ever loaded from disk.
            decisionHandler(url.path.hasPrefix(Bundle.main.bundlePath) ? .allow : .cancel)
        default:
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        endRefreshing()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        endRefreshing()
        if Self.isNetworkError(error) {
            let failing = (error as NSError).userInfo[NSURLErrorFailingURLErrorKey] as? URL
            showOffline(for: failing)
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        endRefreshing()
        if Self.isNetworkError(error) {
            showOffline(for: webView.url)
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        retry()
    }
}

// MARK: - Windows and JavaScript dialogs

extension Browser: WKUIDelegate {
    /// target="_blank" and window.open: same-site pages open in place, the rest in Safari.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            if AppConfig.isInApp(url) {
                webView.load(navigationAction.request)
            } else {
                UIApplication.shared.open(url)
            }
        }
        return nil
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor () -> Void
    ) {
        guard let controller = presentingController() else { return completionHandler() }
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        controller.present(alert, animated: true)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor (Bool) -> Void
    ) {
        guard let controller = presentingController() else { return completionHandler(false) }
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        controller.present(alert, animated: true)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor (String?) -> Void
    ) {
        guard let controller = presentingController() else { return completionHandler(nil) }
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
            completionHandler(alert.textFields?.first?.text)
        })
        controller.present(alert, animated: true)
    }
}

// MARK: - Messages from the offline page

extension Browser: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == Self.retryMessage, message.body as? String == "retry" {
            retry()
        }
    }
}

/// WKUserContentController retains its handlers; this breaks the cycle with the web view.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}
