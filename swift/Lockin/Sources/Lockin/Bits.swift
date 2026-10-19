import SwiftUI
import LockinCore

// Small shared pieces of the app's look, used by more than one file (moved out of
// LockinApp.swift, where they began).

func toneSwiftUIColor(_ tone: Tone) -> Color {
    switch tone {
    case .gray: return .secondary
    case .brown: return .brown
    case .orange: return .orange
    case .yellow: return Color(red: 0.78, green: 0.58, blue: 0.05)
    case .green: return .green
    case .blue: return .blue
    case .purple: return .purple
    case .pink: return .pink
    case .red: return .red
    }
}

struct TagBadge: View {
    let text: String
    var tone: Tone = .gray

    var body: some View {
        Text(text)
            .font(.caption.weight(.medium))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(toneSwiftUIColor(tone).opacity(0.15))
            .foregroundStyle(toneSwiftUIColor(tone))
            .clipShape(RoundedRectangle(cornerRadius: 4))
    }
}
