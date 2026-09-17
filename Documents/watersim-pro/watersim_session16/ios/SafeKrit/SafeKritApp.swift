// SafeKrit iOS: app entry. A SwiftUI shell around one WKWebView, the iOS counterpart
// of the Android Trusted Web Activity. Quick actions arrive through the scene delegate
// and are handed to the web view as a URL to open.

import SwiftUI
import UIKit

@main
struct SafeKritApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var browser = Browser.shared

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(browser)
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        // A cold launch from a quick action carries the item here, not in the scene callback.
        if let item = options.shortcutItem {
            SceneDelegate.handle(item)
        }
        let configuration = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }
}

final class SceneDelegate: NSObject, UIWindowSceneDelegate {
    func windowScene(
        _ windowScene: UIWindowScene,
        performActionFor shortcutItem: UIApplicationShortcutItem,
        completionHandler: @escaping (Bool) -> Void
    ) {
        completionHandler(Self.handle(shortcutItem))
    }

    @discardableResult
    static func handle(_ item: UIApplicationShortcutItem) -> Bool {
        guard let action = QuickAction(rawValue: item.type) else { return false }
        Browser.shared.open(action.url)
        return true
    }
}
