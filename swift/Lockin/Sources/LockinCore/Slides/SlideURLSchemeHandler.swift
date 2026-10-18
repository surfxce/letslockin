import Foundation
import WebKit

public final class SlideURLSchemeHandler: NSObject, WKURLSchemeHandler, @unchecked Sendable {
    public static let scheme = "lockin-slide"

    private let database: LockinDatabase?
    private let renderer: SlideRenderer
    private var activeTasks = Set<ObjectIdentifier>()

    public init(database: LockinDatabase?, renderer: SlideRenderer) {
        self.database = database
        self.renderer = renderer
    }

    public func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url,
              let database = self.database else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        let taskID = ObjectIdentifier(urlSchemeTask)
        activeTasks.insert(taskID)
        // Expected URL: lockin-slide://lectures/<lectureId>/slides/<n>?crop=...
        let pathParts = url.pathComponents.filter { $0 != "/" }
        let host = url.host ?? ""
        let lectureId: String
        let slideSegment: String
        if host == "lectures", pathParts.count >= 3, pathParts[1] == "slides" {
            lectureId = pathParts[0]
            slideSegment = pathParts[2]
        } else if pathParts.count >= 4, pathParts[0] == "lectures", pathParts[2] == "slides" {
            lectureId = pathParts[1]
            slideSegment = pathParts[3]
        } else {
            activeTasks.remove(taskID)
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }

        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let cropParam = components?.queryItems?.first(where: { $0.name == "crop" })?.value
        let renderer = self.renderer

        DispatchQueue.global(qos: .userInitiated).async {
            let response = slideImageResponse(
                database: database,
                lectureId: lectureId,
                slide: slideSegment,
                crop: cropParam,
                renderer: renderer
            )
            let httpResponse = HTTPURLResponse(
                url: url,
                statusCode: response.status,
                httpVersion: "HTTP/1.1",
                headerFields: response.headers
            )
            DispatchQueue.main.async {
                guard self.activeTasks.remove(taskID) != nil else { return }
                if let httpResponse {
                    urlSchemeTask.didReceive(httpResponse)
                }
                urlSchemeTask.didReceive(response.body)
                urlSchemeTask.didFinish()
            }
        }
    }

    public func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {
        activeTasks.remove(ObjectIdentifier(urlSchemeTask))
    }
}

