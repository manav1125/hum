# Halo bench — Phase 0 hardware bring-up

Getting the reSpeaker Clip prototype from "in a box" to "we know whether Halo
works." Every number in [`docs/cue-halo-hardware-plan.md`](../../docs/cue-halo-hardware-plan.md)
that is marked *verify on the bench* is verified by something in here.

## Setup (done)

```bash
./.venv/bin/python test_codec.py   # audio path, no hardware needed
./.venv/bin/python test_cli.py     # every subcommand dispatches
```

Both already pass. The venv holds Seeed's Apache-2.0 async Python SDK
(`respeaker-clip-sdk`, installed editable from `~/respeaker_clip/sdk`) plus
`bleak`, which talks to CoreBluetooth on macOS.

`ogg_opus.py` is vendored from the firmware repo — it is the raw-Opus → OGG
remux, and it is the one piece of the audio path that had to be proven before
the hardware arrived, because the device writes bare `[2-byte LE length][opus
frame]` that nothing downstream will read. `test_codec.py` synthesises exactly
that byte layout with ffmpeg and round-trips it, so the remux is known-good.

## First, one thing only you can do: Bluetooth permission

**Run the first command yourself, from Terminal.app or iTerm.** Not from an
agent session, not over SSH.

macOS gates Bluetooth behind TCC, and a Python process that asks for it without
an approved, GUI-attached parent is **killed with SIGABRT** — no prompt, no
error, just a silent abort and exit 134. That is what happens when this harness
is driven from a headless session, and it looks exactly like "no devices found",
which is the worst possible failure mode to debug next to a Clip that is
working fine.

So: open Terminal, run `bench.py scan`, and approve the Bluetooth prompt when
macOS shows it. After that one approval, everything else works from anywhere,
including agent sessions.

> **Note — your Homebrew Python was modified.** `bleak` also needs
> `NSBluetoothAlwaysUsageDescription` in the interpreter's `Info.plist`, which
> Homebrew's build does not ship. Both Bluetooth usage keys have been added to
> `python@3.14`'s framework plist and the framework re-signed. The original is
> saved as `Info.plist.orig.bak` here; `brew upgrade python@3.14` will revert
> the change and it will need reapplying. To undo it deliberately:
>
> ```bash
> cp Info.plist.orig.bak "$(./.venv/bin/python -c 'import sys;print(sys.base_prefix)')/Resources/Info.plist"
> ```
>
> This was necessary but not sufficient on its own — the GUI approval above is
> the part that actually unblocks it, and it has not been done yet.

## The runbook, in order

Run these in sequence. Each one earns the right to run the next.

### 1. Is it alive?

```bash
./.venv/bin/python bench.py scan
```

Power the Clip on (long press). macOS will ask for Bluetooth permission the
first time — allow it. You want a line ending `← Clip`. Copy the address; every
later command takes `--address AA:BB:…` **before** the subcommand, which skips
a 10-second scan each time.

If nothing shows up: the Clip advertises only when powered and not already
bonded to something else. It holds **one bond**. If it was paired to a phone,
it will not talk to this Mac until that bond is cleared — and clearing it
**formats the card**.

### 2. Does the protocol answer?

```bash
./.venv/bin/python bench.py --address AA:BB:CC:DD:EE:FF status
```

Prints battery, storage, firmware, mode, bond state, Wi-Fi state and every
session already on the device. macOS may show a pairing dialog; the Clip uses
Just Works and auto-confirms, so accept on the Mac side.

This is the point at which bring-up is either done or the problem is physical.

### 3. Can it keep up with a day? *(the architecture question)*

```bash
./.venv/bin/python bench.py --address … live --seconds 300 --mode enhanced
```

Records and continuously syncs at once — protocol §4.7 — and times the arrival
of every segment. Talk during it, and press the button a couple of times.

Three numbers come out, and the plan rests on all three:

| Number | What it decides |
|---|---|
| **Segment duration** | The latency floor. The spec's own example implies ~20 s; if it is 60 s, "near-live" is a different product |
| **Sustained BLE KB/s** | Whether continuous sync keeps up. Audio is ~4 KB/s; the docs claim ~28 KB/s at MTU 517. Under ~1.5× headroom and Wi-Fi catch-up stops being optional |
| **Lag behind live** | How stale Cue's picture of your day is, before STT |

It merges the segments into `session.ogg` at the end, ready for step 5.

### 4. Is the button a usable verb?

```bash
./.venv/bin/python bench.py --address … marks --seconds 120
```

Click the Clip several times, at a deliberate rhythm. The single click while
recording is `AT+MARK`, and it is the **only** gesture the device gives us —
no speaker, no wake word, no text on the OLED. If Cue is ever going to hear
"this matters" from a person's hand, this is the channel, so it has to be
reliable. Check that every press appears both as a live BLE event and in the
stored bookmark list.

### 5. Is the audio good enough? *(the go/no-go)*

```bash
./.venv/bin/python bench.py --address … meeting --seconds 900 --distance 2-3m
./.venv/bin/python bench.py transcribe runs/live-<ts>/<session>/session.ogg
```

A real conversation, real people, worn where it would actually be worn. Then
transcribe it **through Cue's own daemon** (`stt/transcribe-file`, default
`http://127.0.0.1:7821`, override with `--daemon` / `CUE_DAEMON`, and
`--token` / `CUE_TOKEN` if it wants auth) — using Cue's configured provider is
the point, because a bench that measured some other transcriber would be
measuring the wrong thing.

Then read the transcript once as yourself and once as Cue, asking one question:
**are the commitments, owners and decisions recoverable from this text alone?**

That is the whole go/no-go. Two omnidirectional mics is not the eight-mic
beamforming array halo.html promises, and if it cannot hold a four-person table
at 2–3 m, that is a hardware-spec finding — which is exactly what a prototype
is for, and far cheaper to learn now than after tooling.

Run it twice, `--mode normal` and `--mode enhanced`, and keep both transcripts.

### 6. Does it last the day?

```bash
./.venv/bin/python bench.py --address … battery --minutes 480 --record
```

From a full charge, unplugged. The 14–18 h figure is for *recording*; Halo also
streams over BLE all day, which the datasheet does not cost.

### 7. Wi-Fi, for end-of-day catch-up

```bash
./.venv/bin/python bench.py --address … wifi --start
# join ClipAP_XXXX from the Wi-Fi menu (password 12345678), then:
./.venv/bin/python bench.py wifi-sync --session <id>
```

The Clip is an **access point**, not a client — this Mac leaves its own network
and loses internet while joined. That is the whole reason Wi-Fi is the bulk
catch-up path and BLE is the live one. Expect roughly 20× the BLE rate.

## What comes out

Everything lands in `runs/` as JSON, timestamped, alongside the audio. Keep it —
these are the numbers Phase 1 is designed against, and the baseline to compare
against when Seeed ships new firmware.

## Deliberately not wired up

`AT+FORMAT`, `AT+PAIR=reset` and `AT+FACTORY`. Re-pairing formats the card, and
losing a day's recording to a stray flag is not a risk worth carrying in a
bench tool. Use `clip.terminal` from the SDK if you genuinely need them.
