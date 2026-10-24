# Lockin for iPhone

A companion to the desktop app for studying on the go: read summaries with their slide
pictures, answer LAQs closed book, and review AK cards. It syncs straight with Lockin on
your computer over Wi-Fi, encrypted with a key only the two of them share. There's no
account and no cloud server.

- **Summaries** are rendered on the computer exactly as Lockin shows them. Slide pictures
  are downloaded at each sync, so everything works offline.
- **LAQs**: start a sitting (the computer picks the questions, as it would on the
  desktop), answer it, and hand it in. How it gets marked depends on how Lockin marks on
  the computer:
  - **API key** (Settings → Summaries and LAQs → API key): the phone marks it straight
    away, anywhere, with the same key, model and marking prompt. The key reaches the phone
    encrypted and is kept in its Keychain. You can turn this off in Settings → iPhone.
  - **Claude Code, Codex, Antigravity or an offline model**: these run on the computer,
    so the phone keeps your answers and sends them at the next sync. The computer marks
    them, and the marks come back at the sync after that.
- **AK**: review due cards with the same four ratings and scheduler as the desktop.
  Reviews are sent at the next sync. A card reviewed on both devices counts once.

## Pairing

1. On the computer: Lockin → Settings → **iPhone** → **Pair an iPhone**.
2. On the phone: open Lockin and tap **Scan the pairing code**, or point the Camera app
   at the code.

Both need to be on the same network. The phone syncs whenever you open it while Lockin is
open on the computer. Pull down on any list to sync by hand.

The first time, macOS asks whether Lockin may accept incoming network connections. Choose
**Allow**: that's the phone connecting.

University Wi-Fi (eduroam and the like) usually stops devices on it from reaching each
other. When that happens, turn on your phone's Personal Hotspot and join it from the
laptop. Syncing then goes straight across the hotspot and uses no mobile data.

## Installing on your iPhone (free Apple ID)

You need a Mac with Xcode (from the App Store) and [Homebrew](https://brew.sh).

```sh
brew install xcodegen
cd ios
xcodegen            # makes LockinPhone.xcodeproj from project.yml
open LockinPhone.xcodeproj
```

In Xcode:

1. **Settings → Accounts**: add your Apple ID. A free one is fine.
2. Select the **LockinPhone** target → **Signing & Capabilities** → **Team**: choose your
   Personal Team. If Xcode says the bundle identifier is taken, change
   `com.sandeswelagedara.lockin` to anything unique.
3. Plug in your iPhone, and choose it as the run destination at the top.
4. On the iPhone, turn on **Settings → Privacy & Security → Developer Mode** (it restarts).
5. Press **Run** (⌘R). The first time, the iPhone asks you to trust the developer:
   **Settings → General → VPN & Device Management** → your Apple ID → **Trust**.

With a free Apple ID, the app runs for 7 days. After that, plug the phone in and press Run
again; your data stays. A paid Apple Developer account ($99 a year) makes it last a year
and allows TestFlight.

## For development

- `ios/LockinKit` is a Swift package with everything apart from the screens: the
  encryption, sync, the AK scheduler and marking. Test it with `swift test` there.
- `ios/LockinPhone` is the SwiftUI app.
- The protocol is in `lib/phone/` on the computer. Both sides test against the same
  fixtures in `ios/LockinKit/Tests/LockinKitTests/Fixtures`.
- `npm run dev` with `npm run phone` beside it lets the phone sync with the dev server.
- CI (`.github/workflows/ios.yml`) runs the tests and builds the app for the simulator.
