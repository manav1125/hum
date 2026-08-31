#!/usr/bin/env python3
"""
Proves the raw-Opus -> OGG/Opus remux before there is hardware to prove it on.

The device hands us bare `[2-byte LE length][opus frame]` with no container.
Every consumer downstream — ffmpeg, Deepgram, Whisper, Cue's stt/transcribe-file
— needs a real OGG stream. If that remux is wrong we would only find out with a
Clip in hand and a meeting already recorded, which is the worst moment to learn
it, so we synthesise the device's output here instead:

    ffmpeg (sine) -> ogg/opus -> [parse pages, strip headers] -> raw framed opus
                  -> convert_to_ogg_opus -> ffprobe

Round-tripping through our own muxer and back out through ffprobe means both
halves have to be right for the duration to survive.
"""

import struct
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from ogg_opus import convert_to_ogg_opus, parse_raw_opus_frames

DURATION = 5.0
RATE = 16000


def ogg_packets(data: bytes) -> list[bytes]:
    """Pull packets out of an OGG stream. Enough of the spec for this job."""
    packets, partial, pos = [], b"", 0
    while pos < len(data):
        assert data[pos:pos + 4] == b"OggS", f"bad page magic at {pos}"
        n_segments = data[pos + 26]
        table = data[pos + 27:pos + 27 + n_segments]
        body_start = pos + 27 + n_segments
        body = data[body_start:body_start + sum(table)]
        off = 0
        for lace in table:
            partial += body[off:off + lace]
            off += lace
            if lace < 255:            # a lacing value < 255 terminates a packet
                packets.append(partial)
                partial = b""
        pos = body_start + sum(table)
    return packets


def ffprobe_seconds(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        src, raw, out = d / "src.ogg", d / "device.opus", d / "remuxed.ogg"

        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "lavfi",
             "-i", f"sine=frequency=440:duration={DURATION}:sample_rate={RATE}",
             "-ac", "1", "-c:a", "libopus", "-b:a", "32k", str(src)],
            check=True)
        print(f"  source          {src.stat().st_size} bytes, {ffprobe_seconds(src):.2f}s")

        packets = ogg_packets(src.read_bytes())
        audio = [p for p in packets if not p.startswith((b"OpusHead", b"OpusTags"))]
        print(f"  packets         {len(packets)} total, {len(audio)} audio")
        assert audio, "no audio packets recovered"

        # exactly what the firmware writes to the card
        raw.write_bytes(b"".join(struct.pack("<H", len(p)) + p for p in audio))
        print(f"  raw framed      {raw.stat().st_size} bytes")

        reparsed = parse_raw_opus_frames(raw.read_bytes())
        assert len(reparsed) == len(audio), f"frame count drift: {len(reparsed)} != {len(audio)}"
        assert reparsed == audio, "frame payloads changed through the framing round-trip"
        print(f"  reparsed        {len(reparsed)} frames, byte-identical")

        assert convert_to_ogg_opus(raw, out, sample_rate=RATE, channels=1), "remux returned False"
        seconds = ffprobe_seconds(out)
        print(f"  remuxed         {out.stat().st_size} bytes, {seconds:.2f}s")

        drift = abs(seconds - DURATION)
        assert drift < 0.1, f"duration drifted {drift:.3f}s — granulepos is wrong"

        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries",
             "stream=codec_name,sample_rate,channels",
             "-of", "default=noprint_wrappers=1", str(out)],
            capture_output=True, text=True, check=True).stdout.strip().replace("\n", "  ")
        print(f"  stream          {probe}")

        # the real bar: Cue's STT accepts .ogg, so ffmpeg must decode it cleanly
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(out),
                        "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
                        str(d / "out.wav")], check=True)
        wav_seconds = ffprobe_seconds(d / "out.wav")
        assert abs(wav_seconds - DURATION) < 0.1, f"wav duration {wav_seconds}"
        print(f"  decodes to wav  {wav_seconds:.2f}s")

    print("\nPASS — the device -> Cue audio path is sound before the device arrives.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
