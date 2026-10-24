import Foundation

/// Letting an offline model see the slides (lib/llm/vision.ts). On MLX the model the
/// engine already has loaded takes images itself, so each PDF slide is shown to it as a
/// picture, one at a time, and what it sees becomes the slide notes the summary and LAQs
/// are written from, as Claude's are. If it fails, preparing carries on with text
/// recognition instead (Slides/SlideOCR.swift).
///
/// The Electron app can also run llama.cpp's server for a GGUF model's vision part; this
/// app runs MLX models only.

/// What the model is asked about each slide (`PROMPT`).
public let visionPrompt =
    "This is one slide from a university lecture. For a student's revision notes, write every word on it — " +
    "including words inside pictures, diagrams and tables — and then what each figure, diagram, graph, table or " +
    "photo shows: labels, arrows, axes and trends. Be factual and brief: one to four sentences. If the slide is " +
    "only a title, a logo or decoration, say so in a few words."

/// The longest note a slide gets, in tokens.
let visionMaxTokens = 350
/// Low: the notes should say what is there, not imagine.
let visionTemperature = 0.1

/// Shows the model every PDF slide of a lecture (at most `maxSlidePictures`), one at a
/// time, and writes down what it sees (`lookAtSlidesMlx`). `modelDirectory` is the MLX
/// model's folder: the slide reader's when there is one, else the writer's own.
///
/// Slides the model says nothing about get no note. Cancelling stops before the next
/// slide (and the engine stops mid-answer) with `CancellationError`.
public func lookAtSlidesMlx(
    modelDirectory: String,
    slides: SlidesInfo,
    renderer: any SlideRendering,
    engine: any EngineGenerating,
    onProgress: (@Sendable (String) -> Void)?
) async throws -> [SlideNote] {
    let pictures = try slidePictures(slides, renderer: renderer)
    var notes: [SlideNote] = []
    for (index, picture) in pictures.enumerated() {
        try Task.checkCancellation()
        onProgress?("looking at slide \(index + 1) of \(pictures.count)")
        let reply = try await engine.generate(
            model: modelDirectory,
            prompt: visionPrompt,
            images: [picture.file],
            schema: nil,
            maxTokens: visionMaxTokens,
            temperature: visionTemperature,
            onTokens: nil
        )
        let text = slideTextTrim(reply)
        if !text.isEmpty {
            notes.append(SlideNote(slide: picture.slide, notes: text))
        }
    }
    return notes
}
