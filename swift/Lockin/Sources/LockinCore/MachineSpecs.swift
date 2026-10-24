import Foundation

// Port of lib/specs.ts: what this computer has, for choosing a local model. Deliberately
// simple — memory, cores, and whether it is Apple Silicon (unified memory with a GPU the
// engine uses) — because that is most of what decides which model runs well.

/// `sysctlbyname`, for the chip question.
private func sysctlInt(_ name: String) -> Int32? {
    var value: Int32 = 0
    var size = MemoryLayout<Int32>.size
    guard sysctlbyname(name, &value, &size, nil, 0) == 0 else { return nil }
    return value
}

/// `Math.round((os.totalmem() / 1024**3) * 10) / 10`.
private func gbRounded(_ bytes: UInt64) -> Double {
    (Double(bytes) / 1_073_741_824 * 10).rounded() / 10
}

/// `machineSpecs()`. `sysctl hw.optional.arm64` asks the hardware, so an x64 process
/// under Rosetta still counts as Apple Silicon — which is what runs the MLX engine.
public func machineSpecs() -> MachineSpecs {
    let processInfo = ProcessInfo.processInfo
    return MachineSpecs(
        ramGb: gbRounded(processInfo.physicalMemory),
        cores: processInfo.processorCount,
        appleSilicon: sysctlInt("hw.optional.arm64") == 1,
        kind: "Mac"
    )
}
