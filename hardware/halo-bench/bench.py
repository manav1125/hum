#!/usr/bin/env python3
"""
Halo bench — Phase 0 bring-up for the reSpeaker Clip prototype.

Answers the questions no datasheet can, in the order they matter. Every command
writes a JSON record to `runs/` so the numbers survive the session and can be
compared across firmware versions, rooms and mic modes.

    ./.venv/bin/python bench.py scan
    ./.venv/bin/python bench.py status
    ./.venv/bin/python bench.py live --seconds 300 --mode enhanced
    ./.venv/bin/python bench.py meeting --seconds 900
    ./.venv/bin/python bench.py transcribe runs/<id>/session.ogg

The one that decides the product is `meeting`: a real conversation at 2-3 m,
transcribed through Cue's own STT. If that transcript is not good enough to
extract action items from, no amount of software fixes it.

Design notes
------------
* Timing is measured at the FIRST byte of each segment file, not at
  TRANSFER_DONE — the product cares when a segment lands, not when the day ends.
* "Lag" is arrival wall-clock minus cumulative decoded audio duration. That is
  the honest end-to-end number: how far behind live the pipeline runs.
* Nothing here writes to the device beyond recording control. `AT+FORMAT`,
  `AT+PAIR=reset` and `AT+FACTORY` are deliberately not wired up — re-pairing
  formats the card, and losing a day's audio to a stray flag is not a risk
  worth carrying in a bench tool.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
import time
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
from ogg_opus import convert_to_ogg_opus  # noqa: E402

from clip import ClipClient  # noqa: E402
from clip.transports.ble import BleTransport  # noqa: E402

HERE = Path(__file__).parent
RUNS = HERE / "runs"


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------

def _ts() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _jsonable(value: Any) -> Any:
    if is_dataclass(value) and not isinstance(value, type):
        return {k: _jsonable(v) for k, v in asdict(value).items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, Path):
        return str(value)
    return value


def record_result(name: str, payload: dict[str, Any], run_dir: Path | None = None) -> Path:
    """Persist one bench result. The numbers are the deliverable, not the stdout."""
    RUNS.mkdir(parents=True, exist_ok=True)
    target = (run_dir or RUNS) / f"{name}-{_ts()}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(_jsonable(payload), indent=2) + "\n", encoding="utf-8")
    print(f"\n  → {target.relative_to(HERE)}")
    return target


def say(line: str = "") -> None:
    print(line, flush=True)


def rule(title: str) -> None:
    say()
    say(f"── {title} " + "─" * max(0, 66 - len(title)))


def ffprobe_seconds(path: Path) -> float | None:
    """Decoded duration of an audio file, or None if ffprobe can't read it."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True, timeout=30,
        )
        return float(out.stdout.strip()) if out.returncode == 0 and out.stdout.strip() else None
    except Exception:
        return None


def connect(args: argparse.Namespace) -> ClipClient:
    return ClipClient(BleTransport(address=args.address, name=args.name,
                                   connect_timeout=args.connect_timeout))


# ---------------------------------------------------------------------------
# scan — is the device advertising, and under what name?
# ---------------------------------------------------------------------------

async def cmd_scan(args: argparse.Namespace) -> int:
    from bleak import BleakScanner

    rule("BLE scan")
    say(f"Scanning {args.timeout:.0f}s for advertisers…")
    say("(First run will make macOS ask for Bluetooth permission — allow it.)")

    found = await BleakScanner.discover(timeout=args.timeout, return_adv=True)
    rows = []
    for address, (device, adv) in found.items():
        name = device.name or adv.local_name or ""
        rows.append({"address": address, "name": name, "rssi": adv.rssi})

    rows.sort(key=lambda r: r["rssi"] or -999, reverse=True)
    clips = [r for r in rows if args.name.lower() in (r["name"] or "").lower()]

    say()
    for r in rows[: args.limit]:
        mark = "  ← Clip" if r in clips else ""
        say(f"  {r['rssi']:>5} dBm  {r['name'] or '(unnamed)':<28} {r['address']}{mark}")

    say()
    if clips:
        say(f"VERDICT: found {len(clips)} Clip-like device(s).")
        say(f"         Pin it with --address {clips[0]['address']} to skip scanning next time.")
    else:
        say(f"VERDICT: no device whose name contains {args.name!r}.")
        say("         The Clip only advertises when powered on and NOT already bonded")
        say("         elsewhere — remember it holds a single bond. Long-press to wake it,")
        say("         and check the OLED is lit.")

    record_result("scan", {"devices": rows, "matches": clips})
    return 0 if clips else 1


# ---------------------------------------------------------------------------
# status — connect, pair, and read every piece of state the device exposes
# ---------------------------------------------------------------------------

async def cmd_status(args: argparse.Namespace) -> int:
    rule("Connect and read device state")
    say("macOS may show a Bluetooth pairing dialog — the Clip uses Just Works,")
    say("so it auto-confirms; accept on the Mac side.")

    client = connect(args)
    t0 = time.monotonic()
    async with client:
        connect_s = time.monotonic() - t0
        say(f"\n  connected in {connect_s:.1f}s")

        state: dict[str, Any] = {"connect_seconds": round(connect_s, 2)}
        for label, coro in (
            ("status", client.status()),
            ("battery", client.battery()),
            ("storage", client.storage()),
            ("firmware_version", client.firmware_version()),
            ("device_name", client.device_name()),
            ("mode", client.mode()),
            ("pairing", client.pairing_status()),
            ("wifi", client.wifi()),
            ("auto_delete_days", client.auto_delete_days()),
        ):
            try:
                state[label] = await coro
            except Exception as exc:  # one unsupported command must not end the run
                state[label] = {"error": f"{type(exc).__name__}: {exc}"}

        say()
        st = state.get("status")
        if hasattr(st, "state"):
            say(f"  state           {st.state}  (recording={st.recording})")
            say(f"  battery         {st.battery_percent}%  charging={st.charging}")
            say(f"  mode / bitrate  {st.mode} @ {st.bitrate} bps")
            say(f"  free space      {st.free_space_mb} MB")
        sto = state.get("storage")
        if hasattr(sto, "total_mb"):
            say(f"  storage         {sto.used_mb}/{sto.total_mb} MB used ({sto.used_percent}%)"
                f", {sto.recorded_mb} MB recorded")
        say(f"  firmware        {state.get('firmware_version')}")
        pair = state.get("pairing")
        if hasattr(pair, "paired"):
            say(f"  bond            paired={pair.paired} peer={pair.peer_address}")
            say("                  (single-bond: pairing elsewhere clears this AND formats the card)")

        sessions = await client.list_all_sessions()
        say(f"\n  sessions on device: {len(sessions)}")
        for s in sessions[: args.limit]:
            say(f"    {s.id}  files={s.files:<5} {s.size_bytes/1_048_576:.1f} MB  bookmarks={s.bookmarks}")
        state["sessions"] = sessions

    say("\nVERDICT: device reachable, protocol answering. Bring-up is good.")
    record_result("status", state)
    return 0


# ---------------------------------------------------------------------------
# live — the measurement that decides whether Halo can feel real-time
# ---------------------------------------------------------------------------

async def cmd_live(args: argparse.Namespace) -> int:
    """Record and continuously sync at the same time (protocol §4.7).

    Measures the three numbers the plan is resting on: real segment duration,
    sustained BLE throughput, and how far behind live the audio lands.
    """
    rule(f"Continuous sync — {args.seconds}s @ mode={args.mode}")
    say("Start talking when it says RECORDING. Segments stream while you speak.")

    run_dir = RUNS / f"live-{_ts()}"
    run_dir.mkdir(parents=True, exist_ok=True)

    arrivals: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    seen: set[str] = set()
    t_start = 0.0

    def on_progress(filename: str, received: int, expected: int) -> None:
        now = time.monotonic()
        if filename not in seen:
            seen.add(filename)
            arrivals.append({"file": filename, "first_byte_s": round(now - t_start, 2),
                             "last_byte_s": None, "bytes": 0})
            say(f"  [{now - t_start:7.1f}s] ← {filename} starting")
        rec = next(a for a in arrivals if a["file"] == filename)
        rec["last_byte_s"] = round(now - t_start, 2)
        rec["bytes"] = received

    client = connect(args)
    async with client:
        client.on_event(lambda e: events.append({"t": round(time.monotonic() - t_start, 2), **e}))
        await client.set_mode(args.mode)

        t_start = time.monotonic()
        session_id = await client.start_recording(args.mode)
        say(f"\n  RECORDING — session {session_id}")
        say(f"  Press the Clip's button any time to drop a bookmark.\n")

        async def stop_after() -> None:
            await asyncio.sleep(args.seconds)
            say(f"\n  [{time.monotonic() - t_start:7.1f}s] stopping…")
            await client.stop_recording()

        download = asyncio.create_task(
            client.download_session(session_id, run_dir, timeout=args.seconds + 120,
                                    progress=on_progress))
        stopper = asyncio.create_task(stop_after())
        result, _ = await asyncio.gather(download, stopper)

        details = await client.session_details(session_id)

    # -- derive the numbers -------------------------------------------------
    out_dir = Path(result.output_dir)
    segments = sorted(p for p in out_dir.glob("*.opus") if p.is_file())
    total_bytes = sum(p.stat().st_size for p in segments)

    per_segment = []
    cumulative_audio = 0.0
    for seg in segments:
        ogg = seg.with_suffix(".ogg")
        ok = convert_to_ogg_opus(seg, ogg, sample_rate=details.sample_rate_hz,
                                 channels=details.channels)
        dur = ffprobe_seconds(ogg) if ok else None
        arrival = next((a for a in arrivals if a["file"] == seg.name), None)
        if dur:
            cumulative_audio += dur
        per_segment.append({
            "file": seg.name,
            "bytes": seg.stat().st_size,
            "audio_seconds": round(dur, 2) if dur else None,
            "first_byte_s": arrival["first_byte_s"] if arrival else None,
            "complete_s": arrival["last_byte_s"] if arrival else None,
            # how far behind live this segment landed
            "lag_s": round(arrival["last_byte_s"] - cumulative_audio, 2)
            if arrival and arrival["last_byte_s"] is not None and dur else None,
        })

    durations = [s["audio_seconds"] for s in per_segment if s["audio_seconds"]]
    lags = [s["lag_s"] for s in per_segment if s["lag_s"] is not None]
    wall = arrivals[-1]["last_byte_s"] if arrivals else args.seconds
    throughput = total_bytes / wall / 1024 if wall else 0
    marks = [e for e in events if e.get("event") == "mark"]

    summary = {
        "session_id": session_id,
        "mode": args.mode,
        "requested_seconds": args.seconds,
        "channels": details.channels,
        "sample_rate_hz": details.sample_rate_hz,
        "segments": len(segments),
        "total_bytes": total_bytes,
        "segment_seconds_median": round(sorted(durations)[len(durations) // 2], 2) if durations else None,
        "segment_seconds_min": round(min(durations), 2) if durations else None,
        "segment_seconds_max": round(max(durations), 2) if durations else None,
        "throughput_kb_s": round(throughput, 1),
        "audio_rate_kb_s": round(total_bytes / cumulative_audio / 1024, 1) if cumulative_audio else None,
        "lag_seconds_median": round(sorted(lags)[len(lags) // 2], 2) if lags else None,
        "lag_seconds_max": round(max(lags), 2) if lags else None,
        "bookmarks": len(marks),
        "events": events,
        "per_segment": per_segment,
        "output_dir": str(out_dir),
    }

    rule("Results")
    say(f"  segments            {summary['segments']}")
    say(f"  segment duration    median {summary['segment_seconds_median']}s "
        f"(min {summary['segment_seconds_min']}, max {summary['segment_seconds_max']})")
    say(f"  sustained BLE       {summary['throughput_kb_s']} KB/s")
    say(f"  audio produced      {summary['audio_rate_kb_s']} KB/s")
    say(f"  lag behind live     median {summary['lag_seconds_median']}s, worst {summary['lag_seconds_max']}s")
    say(f"  bookmarks captured  {summary['bookmarks']}")

    say()
    if summary["throughput_kb_s"] and summary["audio_rate_kb_s"]:
        headroom = summary["throughput_kb_s"] / summary["audio_rate_kb_s"]
        say(f"VERDICT: {headroom:.1f}x headroom over the audio rate.")
        if headroom < 1.5:
            say("         TOO TIGHT — BLE cannot keep up with a full day. Wi-Fi catch-up")
            say("         becomes mandatory rather than optional.")
        else:
            say("         Continuous sync keeps up. The near-live path is real.")
    if summary["lag_seconds_median"] is not None:
        say(f"         Spoken word reaches the Mac ~{summary['lag_seconds_median']:.0f}s later;")
        say("         add STT time on top for the true 'in Cue' latency.")

    # merge everything into one file for transcription
    merged = out_dir / "session.opus"
    with merged.open("wb") as out:
        for seg in segments:
            out.write(seg.read_bytes())
    session_ogg = out_dir / "session.ogg"
    convert_to_ogg_opus(merged, session_ogg, sample_rate=details.sample_rate_hz,
                        channels=details.channels)
    summary["session_ogg"] = str(session_ogg)
    say(f"\n  merged audio → {session_ogg.relative_to(HERE)}")
    say(f"  transcribe it:  ./.venv/bin/python bench.py transcribe {session_ogg.relative_to(HERE)}")

    record_result("live-summary", summary, run_dir)
    return 0


# ---------------------------------------------------------------------------
# meeting — the go/no-go: real conversation, real distance, real transcript
# ---------------------------------------------------------------------------

async def cmd_meeting(args: argparse.Namespace) -> int:
    rule(f"Meeting capture — {args.seconds}s @ {args.mode}, distance {args.distance}")
    say("This is the test that decides the product. Put the Clip where it would")
    say("actually be worn, with real people at real distance, and hold a real")
    say("conversation. Note who spoke and roughly what was agreed — you are")
    say("scoring the transcript against that, not against a word-error rate.")
    say()
    input("  Press Enter when everyone is in position… ")
    rc = await cmd_live(args)
    say()
    say("Now transcribe it, then read the transcript asking one question:")
    say("  'could Cue extract the right action items from this?'")
    return rc


# ---------------------------------------------------------------------------
# marks — is the button a usable intent verb?
# ---------------------------------------------------------------------------

async def cmd_marks(args: argparse.Namespace) -> int:
    rule(f"Bookmark capture — {args.seconds}s")
    say("Single-click the Clip while it records. Each press should land here")
    say("within a second. This is the only user gesture the device offers, so")
    say("if it is unreliable the whole 'Cue, this matters' interaction changes.")

    events: list[dict[str, Any]] = []
    client = connect(args)
    async with client:
        t0 = time.monotonic()
        client.on_event(lambda e: (
            events.append({"t": round(time.monotonic() - t0, 2), **e}),
            say(f"  [{time.monotonic() - t0:6.1f}s] {e}"),
        ))
        session_id = await client.start_recording(args.mode)
        say(f"\n  RECORDING {session_id} — press the button now.\n")
        await asyncio.sleep(args.seconds)
        await client.stop_recording()
        marks = await client.list_bookmarks(session_id)

    say()
    say(f"VERDICT: {len([e for e in events if e.get('event') == 'mark'])} mark events over BLE, "
        f"{len(marks)} bookmarks stored on device.")
    if marks:
        say("         offsets: " + ", ".join(f"{m.offset_seconds}s" for m in marks))
    record_result("marks", {"session_id": session_id, "events": events,
                            "stored_bookmarks": marks})
    return 0


# ---------------------------------------------------------------------------
# wifi — the bulk catch-up path
# ---------------------------------------------------------------------------

async def cmd_wifi(args: argparse.Namespace) -> int:
    rule("Wi-Fi AP")
    client = connect(args)
    async with client:
        ap = await client.start_wifi() if args.start else await client.wifi()
    say(f"\n  running   {ap.running}")
    say(f"  ssid      {ap.ssid}")
    say(f"  password  {ap.password}")
    say(f"  endpoint  {ap.host}:{ap.port} (UDP)")
    say()
    say("The Clip is an ACCESS POINT, not a client — this Mac has to leave its")
    say("own network to sync, and loses internet while joined. That is why Wi-Fi")
    say("is the end-of-day catch-up path and BLE is the live one.")
    say()
    say("Join it from the Wi-Fi menu, then:")
    say(f"  ./.venv/bin/python bench.py wifi-sync --session <id>")
    record_result("wifi", {"ap": ap})
    return 0


async def cmd_wifi_sync(args: argparse.Namespace) -> int:
    from clip.transports.udp import UdpTransport

    rule(f"Wi-Fi UDP sync — session {args.session}")
    run_dir = RUNS / f"wifisync-{_ts()}"
    got: list[str] = []
    t0 = time.monotonic()

    def on_progress(filename: str, received: int, expected: int) -> None:
        if filename not in got:
            got.append(filename)
            say(f"  [{time.monotonic() - t0:6.1f}s] ← {filename}")

    async with ClipClient(UdpTransport(host=args.host, port=args.port)) as client:
        result = await client.download_session(args.session, run_dir, timeout=args.timeout,
                                               progress=on_progress)
    wall = time.monotonic() - t0
    total = sum(f.size_bytes for f in result.files)
    say()
    say(f"VERDICT: {len(result.files)} files, {total/1_048_576:.1f} MB in {wall:.1f}s "
        f"= {total/wall/1024:.0f} KB/s")
    say("         Compare against the BLE number from `live`. Expect ~20x.")
    record_result("wifi-sync", {"session": args.session, "seconds": round(wall, 1),
                                "bytes": total, "kb_s": round(total / wall / 1024, 1),
                                "output_dir": result.output_dir}, run_dir)
    return 0


# ---------------------------------------------------------------------------
# transcribe — hand the audio to Cue's own STT, not a side tool
# ---------------------------------------------------------------------------

def cmd_transcribe(args: argparse.Namespace) -> int:
    """Deliberately goes through the daemon's stt/transcribe-file.

    Using Cue's configured provider (and its ffmpeg chunking) is the point:
    a bench that measured some other transcriber would be measuring the wrong
    thing. The file path is read by the daemon, so it must be local to it.
    """
    import urllib.error
    import urllib.request

    path = Path(args.file).resolve()
    if not path.exists():
        say(f"no such file: {path}")
        return 1

    rule(f"Transcribe via Cue — {path.name}")
    dur = ffprobe_seconds(path)
    say(f"  duration  {dur:.0f}s" if dur else "  duration  unknown")

    url = args.daemon.rstrip("/") + "/stt/transcribe-file"
    body = json.dumps({"filePath": str(path)}).encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    token = args.token or os.environ.get("CUE_TOKEN")
    if token:
        req.add_header("Authorization", f"Bearer {token}")

    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=args.timeout) as resp:
            payload = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:400]
        say(f"\n  HTTP {exc.code}: {detail}")
        say("\n  401/403 → pass --token (or set CUE_TOKEN).")
        say("  404     → the daemon on that URL predates stt/transcribe-file.")
        return 1
    except Exception as exc:
        say(f"\n  {type(exc).__name__}: {exc}")
        say(f"\n  Is the daemon reachable at {args.daemon}?")
        return 1

    wall = time.monotonic() - t0
    transcript = payload.get("transcript", "")
    say(f"\n  provider  {payload.get('provider')}")
    say(f"  audio     {payload.get('durationSeconds')}s")
    say(f"  wall      {wall:.1f}s  ({(payload.get('durationSeconds') or 1) / wall:.1f}x realtime)")
    say(f"  words     {len(transcript.split())}")
    rule("Transcript")
    say(transcript or "(empty)")

    out = path.with_suffix(".transcript.txt")
    out.write_text(transcript, encoding="utf-8")
    say(f"\n  → {out}")
    say()
    say("Read it once as yourself and once as Cue: are the commitments, owners")
    say("and decisions recoverable from this text alone? That is the bar.")
    record_result("transcribe", {"file": str(path), "provider": payload.get("provider"),
                                 "audio_seconds": payload.get("durationSeconds"),
                                 "wall_seconds": round(wall, 1),
                                 "word_count": len(transcript.split()),
                                 "transcript_path": str(out)})
    return 0


# ---------------------------------------------------------------------------
# battery — the all-day claim, under the load we actually intend to apply
# ---------------------------------------------------------------------------

async def cmd_battery(args: argparse.Namespace) -> int:
    rule(f"Battery drain — sampling every {args.interval}s for up to {args.minutes} min")
    say("The 14-18h figure is for recording. Halo also streams over BLE all day,")
    say("which the datasheet does not cost. Run this from full charge, unplugged.")

    samples: list[dict[str, Any]] = []
    client = connect(args)
    t0 = time.monotonic()
    async with client:
        if args.record:
            await client.start_recording(args.mode)
            say(f"  recording started ({args.mode})")
        try:
            while (time.monotonic() - t0) < args.minutes * 60:
                b = await client.battery()
                s = {"minutes": round((time.monotonic() - t0) / 60, 1),
                     "percent": b.percent, "mv": b.voltage_mv,
                     "charging": b.charging, "temp_c": b.temperature_c}
                samples.append(s)
                say(f"  [{s['minutes']:6.1f} min] {s['percent']:3d}%  {s['mv']} mV  {s['temp_c']}°C")
                if b.percent <= args.floor:
                    say(f"\n  reached floor of {args.floor}%")
                    break
                await asyncio.sleep(args.interval)
        except KeyboardInterrupt:
            say("\n  stopped by hand")
        finally:
            if args.record:
                try:
                    await client.stop_recording()
                except Exception:
                    pass

    if len(samples) >= 2:
        drop = samples[0]["percent"] - samples[-1]["percent"]
        mins = samples[-1]["minutes"] - samples[0]["minutes"]
        rate = drop / mins * 60 if mins else 0
        say()
        say(f"VERDICT: {drop}% over {mins:.0f} min = {rate:.1f} %/hour")
        if rate > 0:
            say(f"         → ~{100 / rate:.1f}h from full. Datasheet claims 14-18h recording.")
    record_result("battery", {"samples": samples, "recording": args.record, "mode": args.mode})
    return 0


# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--address", help="BLE address, from `scan` (skips discovery)")
    p.add_argument("--name", default="Clip", help="advertised-name substring (default: Clip)")
    p.add_argument("--connect-timeout", type=float, default=15.0)
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("scan", help="find the device")
    s.add_argument("--timeout", type=float, default=10.0)
    s.add_argument("--limit", type=int, default=15)
    s.set_defaults(fn=cmd_scan, is_async=True)

    s = sub.add_parser("status", help="connect and dump every readable state")
    s.add_argument("--limit", type=int, default=10)
    s.set_defaults(fn=cmd_status, is_async=True)

    for name, help_text in (("live", "record + continuous sync, measure latency"),
                            ("meeting", "the go/no-go: real conversation at distance")):
        s = sub.add_parser(name, help=help_text)
        s.add_argument("--seconds", type=int, default=300 if name == "live" else 900)
        s.add_argument("--mode", default="enhanced", choices=["normal", "enhanced"])
        s.add_argument("--distance", default="2-3m", help="noted in the run record")
        s.set_defaults(fn=cmd_live if name == "live" else cmd_meeting, is_async=True)

    s = sub.add_parser("marks", help="bookmark button reliability")
    s.add_argument("--seconds", type=int, default=120)
    s.add_argument("--mode", default="enhanced", choices=["normal", "enhanced"])
    s.set_defaults(fn=cmd_marks, is_async=True)

    s = sub.add_parser("wifi", help="show or start the device's Wi-Fi AP")
    s.add_argument("--start", action="store_true")
    s.set_defaults(fn=cmd_wifi, is_async=True)

    s = sub.add_parser("wifi-sync", help="bulk download over Wi-Fi UDP (join the AP first)")
    s.add_argument("--session", required=True)
    s.add_argument("--host", default="192.168.4.1")
    s.add_argument("--port", type=int, default=8089)
    s.add_argument("--timeout", type=float, default=600.0)
    s.set_defaults(fn=cmd_wifi_sync, is_async=True)

    s = sub.add_parser("transcribe", help="transcribe through Cue's own STT")
    s.add_argument("file")
    s.add_argument("--daemon", default=os.environ.get("CUE_DAEMON", "http://127.0.0.1:7821"))
    s.add_argument("--token", default=None)
    s.add_argument("--timeout", type=float, default=900.0)
    s.set_defaults(fn=cmd_transcribe, is_async=False)

    s = sub.add_parser("battery", help="drain rate under continuous sync")
    s.add_argument("--minutes", type=float, default=480)
    s.add_argument("--interval", type=float, default=300)
    s.add_argument("--floor", type=int, default=5)
    s.add_argument("--record", action="store_true", help="record while sampling")
    s.add_argument("--mode", default="enhanced", choices=["normal", "enhanced"])
    s.set_defaults(fn=cmd_battery, is_async=True)

    return p


def main() -> int:
    args = build_parser().parse_args()
    try:
        return asyncio.run(args.fn(args)) if args.is_async else args.fn(args)
    except KeyboardInterrupt:
        say("\ninterrupted")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
