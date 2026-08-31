# HaloPreview

A throwaway host app whose only job is to put `HaloKit` on a simulator screen.

It exists because the bug that mattered most in the first render was invisible
to the compiler and to the unit tests: the arc drew a solid warm stroke across
an unheard afternoon, which is exactly the lie the three-treatment grammar is
there to prevent — and it looked completely fine. Only a screenshot caught it.

```bash
cd apps/ios/HaloPreview
xcodegen generate
xcodebuild -project HaloPreview.xcodeproj -scheme HaloPreview \
  -sdk iphonesimulator -configuration Debug -derivedDataPath build build
xcrun simctl boot "iPhone 16 Pro" 2>/dev/null
xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/HaloPreview.app
xcrun simctl launch booted ai.justcue.halopreview
```

`Sources/App.swift` carries the E1 frame's own day as sample data — the same
chapters, the same 2:12pm, the same 11–1 gap — so a render can be held next to
the design and compared rather than judged.

Not shipped, not signed, not part of the app. Delete it the day Halo's surfaces
live inside the real target and can be driven with real data.
