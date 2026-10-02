// Off-screen WKWebView probe for the end-to-end layout tests (see e2e/form-layout.mjs): loads a URL in the
// same WebKit the macOS app runs in, seeds localStorage, runs phase scripts (async JS bodies returning JSON
// strings) and saves a snapshot of the page after each phase. Works without a visible window, and so without
// Screen Recording or Accessibility permission.
//
// usage: webkit-probe <url> <seed.js> <outdir> <width> <height> <phase1.js> [phase2.js ...]
// env: PROBE_TIMEOUT=<seconds> for the whole run (default 120)
import AppKit
import WebKit

let args = CommandLine.arguments
let url = URL(string: args[1])!
let seed = try! String(contentsOfFile: args[2], encoding: .utf8)
let outDir = args[3]
let width = Double(args[4])!, height = Double(args[5])!
let phases = Array(args[6...])

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

final class Driver: NSObject, WKNavigationDelegate {
  let web: WKWebView
  let window: NSWindow
  var results: [String] = []
  var started = false
  init(frame: NSRect) {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    config.userContentController.addUserScript(WKUserScript(source: seed, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    let css = "var s=document.createElement('style');s.textContent='*{animation:none!important;transition:none!important}';document.documentElement.appendChild(s);"
    config.userContentController.addUserScript(WKUserScript(source: css, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
    web = WKWebView(frame: frame, configuration: config)
    window = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.contentView = web
    super.init()
    web.navigationDelegate = self
  }
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    if started { print("reloaded"); return }
    started = true
    Task { @MainActor in await self.run() }
  }
  @MainActor func run() async {
    // The dev build compiles modules on first request; give the app time to settle.
    try? await Task.sleep(nanoseconds: 5_000_000_000)
    for (i, phase) in phases.enumerated() {
      let body = try! String(contentsOfFile: phase, encoding: .utf8)
      do {
        let r = try await web.callAsyncJavaScript(body, arguments: [:], in: nil, contentWorld: .page)
        results.append("{\"phase\":\"\(phase)\",\"result\":\(r as? String ?? "null")}")
      } catch {
        results.append("{\"phase\":\"\(phase)\",\"error\":\(String(reflecting: "\(error)"))}")
      }
      let cfg = WKSnapshotConfiguration()
      if let img = try? await web.takeSnapshot(configuration: cfg),
         let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
         let png = rep.representation(using: .png, properties: [:]) {
        let name = URL(fileURLWithPath: phase).deletingPathExtension().lastPathComponent
        try? png.write(to: URL(fileURLWithPath: "\(outDir)/\(name).png"))
      }
    }
    let json = "[" + results.joined(separator: ",\n") + "]"
    try? json.write(toFile: "\(outDir)/results.json", atomically: true, encoding: .utf8)
    print(json)
    exit(0)
  }
}

let driver = Driver(frame: NSRect(x: 0, y: 0, width: width, height: height))
driver.web.load(URLRequest(url: url))
// PROBE_TIMEOUT (seconds) for tests whose phases wait on real work, such as transfers.
let timeout = Double(ProcessInfo.processInfo.environment["PROBE_TIMEOUT"] ?? "") ?? 120
DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { print("timeout"); exit(2) }
app.run()
