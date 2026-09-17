// SafeKrit iOS: the site the app wraps, and the quick actions on the home-screen icon.
// Keep these in step with android/twa-manifest.json and frontend/public/manifest.json.

import Foundation

enum AppConfig {
    static let host = "dt.inferconautomation.com"
    static let origin = URL(string: "https://\(host)")!
    static let startURL = URL(string: "/dashboard", relativeTo: origin)!.absoluteURL

    /// Appended to the WKWebView user agent so the server can tell the app from Safari.
    static let userAgentSuffix = "SafeKritiOS/1.0"

    /// A URL stays inside the app when it is on the site's host; anything else opens in Safari.
    static func isInApp(_ url: URL) -> Bool {
        url.host?.lowercased() == host
    }
}

/// Home-screen quick actions. The type strings match UIApplicationShortcutItems in SafeKrit-Info.plist.
enum QuickAction: String {
    case live = "com.inferconautomation.safekrit.live"
    case alarms = "com.inferconautomation.safekrit.alarms"
    case tasks = "com.inferconautomation.safekrit.tasks"

    var url: URL {
        let path: String
        switch self {
        case .live: path = "/live"
        case .alarms: path = "/alarms"
        case .tasks: path = "/tasks"
        }
        return URL(string: path, relativeTo: AppConfig.origin)!.absoluteURL
    }
}
