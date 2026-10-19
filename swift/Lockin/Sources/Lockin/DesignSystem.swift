import SwiftUI
import LockinCore

// The design system, ported from app/globals.css: "a quiet, Notion-like surface —
// white canvas, soft grey rules, coloured select tags carrying meaning, one blue for
// actions." Every colour here has the CSS variable it ports in its comment; the views
// use nothing else.

// MARK: - Colours

/// A colour with its light and dark values (`color-mix` and friends aside, the CSS is
/// two flat palettes under a media query).
private func themeColor(_ lightHex: UInt32, _ darkHex: UInt32) -> Color {
    func rgb(_ hex: UInt32) -> NSColor {
        NSColor(srgbRed: Double((hex >> 16) & 0xFF) / 255,
                green: Double((hex >> 8) & 0xFF) / 255,
                blue: Double(hex & 0xFF) / 255, alpha: 1)
    }
    let dynamic = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? rgb(darkHex) : rgb(lightHex)
    }
    return Color(nsColor: dynamic)
}

enum L {
    // Canvas and rules (`--bg`, `--bg-soft`, `--bg-sunk`, `--rule`, `--rule-strong`).
    static let bg = themeColor(0xFFFFFF, 0x191919)
    static let bgSoft = themeColor(0xF7F7F5, 0x202020)
    static let bgSunk = themeColor(0xF1F1EF, 0x252525)
    static let hover = themeColor(0x0F0F0F, 0xFFFFFF).opacity(0.06)
    static let press = themeColor(0x0F0F0F, 0xFFFFFF).opacity(0.10)
    static let rule = themeColor(0xE9E9E7, 0x2F2F2F)
    static let ruleStrong = themeColor(0xDCDCD9, 0x3A3A3A)

    // Text (`--text`, `--text-soft`, `--text-faint`).
    static let text = themeColor(0x37352F, 0xD4D4D4)
    static let textSoft = themeColor(0x73726E, 0x9B9B9B)
    static let textFaint = themeColor(0xA5A29A, 0x6F6F6F)

    // One blue for actions (`--accent`, `--accent-text`, `--accent-soft`), and danger.
    static let accent = themeColor(0x2383E2, 0x2383E2)
    static let accentHover = themeColor(0x0F72D4, 0x3B91E6)
    static let accentSoft = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 35/255, green: 131/255, blue: 226/255, alpha: 0.16)
            : NSColor(srgbRed: 35/255, green: 131/255, blue: 226/255, alpha: 0.10)
    })
    static let accentText = themeColor(0x1A6FC2, 0x529CCA)
    static let danger = themeColor(0xE03E3E, 0xFF7369)

    /// Notion's select colours, background and text pairs (`--t-*-bg`, `--t-*`).
    static let tagPalettes: [Tone: (bg: Color, fg: Color)] = [
        .gray: (themeColor(0xE3E2E0, 0x373737), themeColor(0x32302C, 0xD4D4D4)),
        .brown: (themeColor(0xEEE0DA, 0x4A3228), themeColor(0x442A1E, 0xE6D3C9)),
        .orange: (themeColor(0xFADEC9, 0x5C3B23), themeColor(0x49290E, 0xF3D2B4)),
        .yellow: (themeColor(0xFDECC8, 0x564328), themeColor(0x402C1B, 0xF4E3C0)),
        .green: (themeColor(0xDBEDDB, 0x243D30), themeColor(0x1C3829, 0xC7E3D0)),
        .blue: (themeColor(0xD3E5EF, 0x143A4E), themeColor(0x183347, 0xC1DDEF)),
        .purple: (themeColor(0xE8DEEE, 0x3C2D49), themeColor(0x412454, 0xE2CDEF)),
        .pink: (themeColor(0xF5E0E9, 0x4E2C3C), themeColor(0x4C2337, 0xF3CDE0)),
        .red: (themeColor(0xFFE2DD, 0x522E2A), themeColor(0x5D1715, 0xF8CDC6)),
    ]

    /// Strong versions, for bars, dots and trend arrows (`--s-*`).
    static let strong: [Tone: Color] = [
        .gray: themeColor(0x9B9A97, 0x7F7F7F),
        .brown: themeColor(0x9F6B53, 0x937264),
        .orange: themeColor(0xD9730D, 0xFFA344),
        .yellow: themeColor(0xCB912F, 0xFFDC49),
        .green: themeColor(0x448361, 0x4DAB9A),
        .blue: themeColor(0x337EA9, 0x529CCA),
        .purple: themeColor(0x9065B0, 0x9A6DD7),
        .pink: themeColor(0xC14C8A, 0xE255A1),
        .red: themeColor(0xD44C47, 0xFF7369),
    ]

    /// The card shadow (`--shadow`): a hairline ring and a soft drop. In the dark theme
    /// the CSS swaps to a white ring — that ring is what keeps cards visible there, so
    /// the stroke carries it and the black drop does the light theme.
    static let cardRing = themeColor(0x0F0F0F, 0xFFFFFF).opacity(0.07)

    static func cardShadow(_ view: some View) -> some View {
        view
            .shadow(color: Color.black.opacity(0.05), radius: 0.5, y: 1)
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(cardRing, lineWidth: 1)
            )
    }
}

// MARK: - Type

/// Type scales straight from the CSS (15px body, 34px page title, 19px section).
extension Font {
    static let lockinBody = Font.system(size: 15)
    static let lockinTitle = Font.system(size: 34, weight: .bold)
    static let lockinH2 = Font.system(size: 19, weight: .semibold)
    static let lockinH3 = Font.system(size: 16, weight: .semibold)
    static let lockinSmall = Font.system(size: 13)
    static let lockinTag = Font.system(size: 12.5)
    static let lockinMono = Font.system(size: 12, weight: .medium, design: .monospaced)
}

// MARK: - Tags

func toneSwiftUIColor(_ tone: Tone) -> Color {
    L.strong[tone] ?? .secondary
}

/// `.tag`: a select chip carrying meaning — Notion's background/text pairs, 21px tall.
struct TagBadge: View {
    let text: String
    var tone: Tone = .gray
    var round = false
    /// Tabular digits and the score weight (`.score` in the CSS).
    var score = false

    var body: some View {
        let palette = L.tagPalettes[tone] ?? L.tagPalettes[.gray]!
        Text(text)
            .font(score ? Font.system(size: 12.5, weight: .semibold, design: .monospaced) : Font.system(size: 12.5))
            .lineLimit(1)
            .padding(.horizontal, round ? 9 : 7)
            .frame(height: 21)
            .background(palette.bg)
            .foregroundStyle(palette.fg)
            .clipShape(RoundedRectangle(cornerRadius: round ? 11 : 4))
    }
}

/// The score tag: tabular digits on a select colour, with the trend beside it.
struct ScoreTagView: View {
    let score: Double?
    var prev: Double? = nil

    var body: some View {
        if let score {
            HStack(spacing: 0) {
                TagBadge(text: formatScore(score), tone: scoreTone(score), score: true)
                if let prev {
                    let diff = score - prev
                    if abs(diff) >= 0.05 {
                        Text(String(format: "%@%.1f", diff > 0 ? "+" : "", diff))
                            .font(.system(size: 11, weight: .medium, design: .monospaced))
                            .foregroundStyle(diff > 0 ? L.strong[.green] ?? .green : L.strong[.red] ?? .red)
                            .padding(.leading, 4)
                    }
                }
            }
        } else {
            Text("—")
                .font(.lockinSmall)
                .foregroundStyle(L.textFaint)
        }
    }
}

// MARK: - Buttons

/// `.btn` and its moods: a white bordered button with a hairline drop, a blue primary,
/// and the quiet ghost.
struct LockinButtonStyle: ButtonStyle {
    enum Kind { case normal, primary, quiet, danger }
    enum Size { case normal, small, large }

    var kind: Kind = .normal
    var size: Size = .normal
    @Environment(\.isEnabled) private var enabled

    private var height: CGFloat {
        switch size {
        case .small: return 26
        case .large: return 38
        case .normal: return 32
        }
    }
    private var font: Font {
        switch size {
        case .small: return .system(size: 13, weight: .medium)
        case .large: return .system(size: 15, weight: .medium)
        case .normal: return .system(size: 14, weight: .medium)
        }
    }
    private var corner: CGFloat { size == .small ? 5 : 6 }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(font)
            .foregroundStyle(foreground)
            .padding(.horizontal, size == .small ? 8 : (size == .large ? 16 : 12))
            .frame(height: height)
            .background(background(configuration.isPressed))
            .overlay(
                RoundedRectangle(cornerRadius: corner)
                    .strokeBorder(borderColor, lineWidth: 1)
            )
            .cornerRadius(corner)
            .opacity(enabled ? 1 : 0.45)
    }

    private var foreground: Color {
        switch kind {
        case .normal: return L.text
        case .primary: return .white
        case .quiet: return L.textSoft
        case .danger: return L.danger
        }
    }
    private func background(_ pressed: Bool) -> Color {
        if pressed {
            switch kind {
            case .primary: return L.accentHover
            case .quiet: return L.hover
            default: return L.press
            }
        }
        switch kind {
        case .primary: return L.accent
        case .quiet: return .clear
        default: return L.bg
        }
    }
    private var borderColor: Color {
        switch kind {
        case .primary: return L.accent
        case .quiet: return .clear
        case .danger: return L.ruleStrong
        case .normal: return L.ruleStrong
        }
    }
}

extension ButtonStyle where Self == LockinButtonStyle {
    static var lockin: LockinButtonStyle { LockinButtonStyle() }
    static var lockinPrimary: LockinButtonStyle { LockinButtonStyle(kind: .primary) }
    static var lockinQuiet: LockinButtonStyle { LockinButtonStyle(kind: .quiet) }
    static var lockinDanger: LockinButtonStyle { LockinButtonStyle(kind: .danger) }
    static func lockin(_ kind: LockinButtonStyle.Kind = .normal, size: LockinButtonStyle.Size = .normal) -> LockinButtonStyle {
        LockinButtonStyle(kind: kind, size: size)
    }
}

// MARK: - Page furniture

/// `.page`: centred, max-width, generous padding — the web app's canvas.
struct PageContainer<Content: View>: View {
    var narrow = false
    @ViewBuilder var content: () -> Content

    var body: some View {
        ScrollView {
            content()
                .frame(maxWidth: narrow ? 800 : 1120, alignment: .center)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 48)
                .padding(.top, 36)
                .padding(.bottom, 80)
        }
        .background(L.bg)
        .defaultScrollAnchor(.top)
    }
}

/// `h1.page-title`.
struct PageTitle: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.lockinTitle)
            .tracking(-0.5)
            .foregroundStyle(L.text)
    }
}

/// `h2`.
struct SectionHeading: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.lockinH2)
            .foregroundStyle(L.text)
    }
}

/// `.crumbs`.
struct Crumbs: View {
    let parts: [(String, () -> Void)]
    var body: some View {
        HStack(spacing: 4) {
            ForEach(parts.indices, id: \.self) { index in
                if index > 0 {
                    Text("/").foregroundStyle(L.textFaint).font(.system(size: 14))
                }
                Button(action: parts[index].1) {
                    Text(parts[index].0)
                        .font(.system(size: 14))
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(index == parts.count - 1 ? Color.clear : Color.clear)
                        .foregroundStyle(L.textSoft)
                }
                .buttonStyle(.plain)
                .onHover { inside in
                    if inside { NSCursor.pointingHand.set() }
                }
            }
        }
    }
}

/// `.card` and `.soft-card`.
struct Card<Content: View>: View {
    var soft = false
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .padding(.horizontal, 20)
            .padding(.vertical, 18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(soft ? L.bgSoft : L.bg)
            .cornerRadius(8)
            .modifier(CardShadowIfSolid(soft: soft))
    }
}

private struct CardShadowIfSolid: ViewModifier {
    let soft: Bool
    func body(content: Content) -> some View {
        if soft {
            content
        } else {
            L.cardShadow(content)
        }
    }
}

/// Underline tabs (`.tabs`): text with a 2px active underline and a count pill.
struct UnderlineTabs<Tab: Hashable>: View {
    @Binding var selection: Tab
    let tabs: [(tab: Tab, label: String, count: Int?)]

    var body: some View {
        HStack(spacing: 2) {
            ForEach(tabs, id: \.tab) { item in
                let on = item.tab == selection
                Button {
                    selection = item.tab
                } label: {
                    HStack(spacing: 6) {
                        Text(item.label)
                            .font(.system(size: 14.5, weight: on ? .medium : .regular))
                            .foregroundStyle(on ? L.text : L.textSoft)
                        if let count = item.count {
                            Text("\(count)")
                                .font(.system(size: 12))
                                .padding(.horizontal, 6)
                                .frame(height: 18)
                                .background(L.bgSunk)
                                .foregroundStyle(L.textFaint)
                                .clipShape(Capsule())
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .overlay(alignment: .bottom) {
                        Rectangle()
                            .fill(on ? L.text : Color.clear)
                            .frame(height: 2)
                            .offset(y: 1)
                    }
                }
                .buttonStyle(.plain)
            }
            Spacer(minLength: 0)
        }
        .background(alignment: .bottom) {
            Rectangle().fill(L.rule).frame(height: 1)
        }
        .padding(.bottom, 1)
    }
}
