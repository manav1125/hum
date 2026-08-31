#!/usr/bin/env python3
"""Every subcommand parses and dispatches to a real handler.

Cheap, but it catches the class of mistake that only shows up when you are
stood next to the hardware with a meeting about to start.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from bench import build_parser

CASES = [
    ["scan"],
    ["--address", "AA:BB:CC:DD:EE:FF", "status"],
    ["live", "--seconds", "60", "--mode", "normal"],
    ["meeting", "--seconds", "900", "--distance", "3m"],
    ["marks", "--seconds", "120"],
    ["wifi", "--start"],
    ["wifi-sync", "--session", "20260830120000"],
    ["transcribe", "session.ogg", "--daemon", "http://127.0.0.1:8787"],
    ["battery", "--minutes", "60", "--record"],
]

def main() -> int:
    parser = build_parser()
    for argv in CASES:
        args = parser.parse_args(argv)
        assert callable(args.fn), f"{argv}: no handler"
        assert isinstance(args.is_async, bool), f"{argv}: is_async unset"
        print(f"  OK  {' '.join(argv):<58} -> {args.fn.__name__}")
    print("\nPASS — all subcommands parse and dispatch.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
