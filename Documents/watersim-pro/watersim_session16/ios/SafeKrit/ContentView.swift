// SafeKrit iOS: the screen. The web view sits inside the safe area; the strip behind the
// status bar is ink to match the site's mobile top bar, the strip below is the page grey.

import SwiftUI
import WebKit

struct ContentView: View {
    @EnvironmentObject private var browser: Browser

    var body: some View {
        ZStack(alignment: .top) {
            VStack(spacing: 0) {
                Color("LaunchBackground")
                Color("Ground")
            }
            .ignoresSafeArea()

            WebView(webView: browser.webView)

            if browser.isLoading {
                ProgressView(value: browser.progress)
                    .progressViewStyle(.linear)
                    .tint(Color.accentColor)
                    .frame(height: 2)
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.2), value: browser.isLoading)
        .onAppear { browser.loadStartIfNeeded() }
    }
}

private struct WebView: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> WKWebView { webView }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
