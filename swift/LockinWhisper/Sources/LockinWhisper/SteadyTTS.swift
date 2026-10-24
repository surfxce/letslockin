import Foundation
// Only TTSKit here: WhisperKit has its own TokenSampling and GreedyTokenSampler, which
// would make the names below ambiguous in main.swift.
import TTSKit

/// TTSKit, with every line sampled from the same seed. TTSKit gives each line a fresh
/// random draw (even when seeded, it varies the seed per line), so one sentence came out
/// enthusiastic, then bored, then coughing; seeded alike, a line in a voice and style is
/// said the same way every time.
final class SteadyTTS: TTSKit, @unchecked Sendable {
    static let seed: UInt64 = 20_261_024

    override func setupGenerateTask(
        currentTimings: SpeechTimings, progress: Progress, tokenizer: any TTSTokenizer, sampler: any TokenSampling
    ) throws -> any SpeechGenerating {
        try super.setupGenerateTask(currentTimings: currentTimings, progress: progress, tokenizer: tokenizer,
                                    sampler: GreedyTokenSampler(seed: Self.seed))
    }
}

/// Steadier than Qwen's defaults (temperature 0.9, top 50), which suit a demo's variety
/// more than an examiner's even delivery; and room for a slow line to finish (245 steps
/// is about 20 seconds, and a drawn-out sentence was cut off).
func steadyOptions() -> GenerationOptions {
    var options = GenerationOptions()
    options.temperature = 0.6
    options.topK = 30
    options.maxNewTokens = 600
    return options
}
