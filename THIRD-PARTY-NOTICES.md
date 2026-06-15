# Third-Party Notices

This product includes software developed by third parties, used under their
respective licenses.

## clicky

Cue Live's voice pipeline (push-to-talk speech-to-text via AssemblyAI, and
text-to-speech replies via ElevenLabs) adapts source code from **clicky** by
Farza — https://github.com/farzaa/clicky. Specifically, portions of
`apps/macos/native/mac-helper/Sources/MacHelperExecutable/CueVoice.swift` are
derived from clicky's `AssemblyAIStreamingTranscriptionProvider.swift`,
`BuddyAudioConversionSupport.swift`, `GlobalPushToTalkShortcutMonitor.swift`,
and `ElevenLabsTTSClient.swift`. The code was adapted to authenticate directly
with the user's own API keys (clicky uses a Cloudflare Worker proxy) and to
integrate with Cue's local daemon and overlay.

Used under the MIT License:

```
MIT License

Copyright (c) 2026 Farza

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
