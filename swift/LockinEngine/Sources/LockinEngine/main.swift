// lockin-engine: one model in memory, answering the worker over stdin/stdout.
//
// Each request is a line of JSON:
//   {"id":"1","op":"generate","model":"/path/to/mlx/dir","prompt":"…",
//    "images":["/slide.png"],"schema":{…JSON Schema…},"maxTokens":4000,"temperature":0.3}
//   {"id":"2","op":"unload"}
// and each answer a line too: progress while it writes, then the result or an error:
//   {"id":"1","progress":{"tokens":120}}
//   {"id":"1","text":"…"}            {"id":"1","error":"…"}
//
// With a schema, the reply is constrained to it token by token (MLXGuidedGeneration),
// so it is always valid JSON of that shape. Requests run one at a time; to cancel one,
// the worker ends this process.

import Foundation
import HuggingFace
import MLX
import MLXGuidedGeneration
import MLXHuggingFace
import MLXLLM
import MLXLMCommon
import MLXVLM
import Tokenizers

let output = FileHandle.standardOutput
let outputLock = NSLock()

func send(_ message: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: message) else { return }
    outputLock.lock()
    output.write(data)
    output.write(Data([0x0A]))
    outputLock.unlock()
}

/// The loaded model, kept between requests: loading takes seconds to a minute.
actor Engine {
    private var container: ModelContainer?
    private var loadedPath: String?

    func load(_ path: String) async throws -> ModelContainer {
        if let container, loadedPath == path { return container }
        container = nil
        loadedPath = nil
        MLX.GPU.clearCache()
        let url = URL(fileURLWithPath: path)
        let tokenizers = #huggingFaceTokenizerLoader()
        let loaded: ModelContainer
        do {
            // A model that takes images is loaded with its vision part, so one copy in
            // memory both looks at slides and writes the summary.
            loaded = try await VLMModelFactory.shared.loadContainer(from: url, using: tokenizers)
        } catch {
            loaded = try await LLMModelFactory.shared.loadContainer(from: url, using: tokenizers)
        }
        container = loaded
        loadedPath = path
        return loaded
    }

    func unload() {
        container = nil
        loadedPath = nil
        MLX.GPU.clearCache()
    }
}

let engine = Engine()

/// Whether the model has got stuck: the end of what it has written is the same stretch
/// over and over (at least four times, 400 characters in all), or a long run of blank
/// space. The same check as lib/llm/looping.ts.
func isLooping(_ text: String) -> Bool {
    let tail = Array(text.utf16.suffix(1600))
    let blank: Set<UInt16> = [32, 9, 10, 13]
    if tail.count >= 200 && tail.suffix(200).allSatisfy({ blank.contains($0) }) { return true }
    for period in 8...300 {
        let repeats = Swift.max(4, (400 + period - 1) / period)
        if period * repeats > tail.count { break }
        let unit = tail[(tail.count - period)...]
        if unit.allSatisfy({ blank.contains($0) }) { continue }
        var k = 1
        while k < repeats && tail[(tail.count - (k + 1) * period)..<(tail.count - k * period)].elementsEqual(unit) { k += 1 }
        if k >= repeats { return true }
    }
    return false
}

func generate(id: String, request: [String: Any]) async throws -> String {
    guard let model = request["model"] as? String, let prompt = request["prompt"] as? String else {
        throw NSError(domain: "lockin-engine", code: 1, userInfo: [NSLocalizedDescriptionKey: "a request needs a model and a prompt"])
    }
    let maxTokens = request["maxTokens"] as? Int ?? 2048
    let temperature = Float(request["temperature"] as? Double ?? 0.3)
    let images = (request["images"] as? [String] ?? []).map {
        UserInput.Image(source: .url(URL(fileURLWithPath: $0)))
    }
    var schema: String?
    if let object = request["schema"], !(object is NSNull) {
        schema = String(data: try JSONSerialization.data(withJSONObject: object), encoding: .utf8)
    }

    let container = try await engine.load(model)
    let constrainedSchema = schema
    return try await container.perform { context in
        let input = try await context.processor.prepare(input: UserInput(prompt: prompt, images: images))
        var lastReport = Date()
        let report: (Int) -> Void = { tokens in
            if Date().timeIntervalSince(lastReport) > 1.5 {
                lastReport = Date()
                send(["id": id, "progress": ["tokens": tokens]])
            }
        }

        if let constrainedSchema {
            let vocab = TokenizerVocabExtractor.extractForGrammar(from: context.tokenizer)
            let grammarTokenizer = try GrammarTokenizer(
                vocab: vocab.vocab,
                vocabType: vocab.vocabType,
                eosTokenId: Int32(context.tokenizer.eosTokenId ?? 0))
            let constraint = try GrammarConstraint(
                tokenizer: grammarTokenizer,
                jsonSchema: constrainedSchema,
                fastForward: true,
                hostTokenizer: context.tokenizer)
            // As the library's own structured generation does: hold back long runs of
            // blank space (a common way for a constrained model to stall), and as the
            // budget runs out, steer it to close the JSON rather than stop half-way.
            let closing = ClosingTokenBias.compute(tokenizer: context.tokenizer, eosTokenId: context.tokenizer.eosTokenId)
            let whitespace = WhitespaceTokenBias.compute(tokenizer: context.tokenizer)
            let structural = CompletionReserve.estimate(schemaJSON: constrainedSchema, tokenizer: context.tokenizer)
            var text = ""
            var tokens = 0
            var checkedAt = 0
            var looping = false
            _ = try GuidedGenerationLoop.run(
                input: input,
                context: context,
                constraint: constraint,
                maxTokens: maxTokens,
                vocabSize: grammarTokenizer.vocabSize,
                completionReserve: Swift.max(structural * 3, maxTokens / 4),
                hardReserve: structural * 8,
                closingBias: closing,
                whitespaceBias: whitespace.bias,
                whitespaceTokenIDs: whitespace.tokenIDs
            ) { delta in
                text += delta
                tokens += 1
                report(tokens)
                if text.utf16.count - checkedAt >= 64 {
                    checkedAt = text.utf16.count
                    if isLooping(text) {
                        looping = true
                        return false
                    }
                }
                return true
            }
            if looping {
                throw NSError(domain: "lockin-engine", code: 2, userInfo: [
                    NSLocalizedDescriptionKey: "the model started repeating itself — try again, or a larger model",
                ])
            }
            return text
        }

        let result = try MLXLMCommon.generate(
            input: input,
            parameters: GenerateParameters(maxTokens: maxTokens, temperature: temperature),
            context: context
        ) { tokens in
            report(tokens.count)
            return .more
        }
        return result.output
    }
}

// Requests are read and answered one at a time.
for try await line in FileHandle.standardInput.bytes.lines {
    guard
        let data = line.data(using: .utf8),
        let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let id = request["id"] as? String
    else { continue }
    do {
        switch request["op"] as? String {
        case "generate":
            send(["id": id, "text": try await generate(id: id, request: request)])
        case "unload":
            await engine.unload()
            send(["id": id, "text": ""])
        case "ping":
            send(["id": id, "text": "pong"])
        default:
            send(["id": id, "error": "unknown op"])
        }
    } catch {
        send(["id": id, "error": "\(error.localizedDescription)"])
    }
}
