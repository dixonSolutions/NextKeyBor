#!/usr/bin/env python3
"""Show the test session live in a window on your desktop (view only).

    tools/nested/view.py DIR

For a session you can also use, install mutter-devkit instead; run.sh then
opens it as a window by itself.
"""
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from drive import Driver  # noqa: E402


def main():
    state = Path(sys.argv[1])
    d = Driver(state.joinpath("bus").read_text().strip())
    # The screen cast lives as long as this process keeps its D-Bus session.
    subprocess.run(["gst-launch-1.0", "-q", "pipewiresrc", f"path={d.node}", "keepalive-time=100",
                    "!", "videoconvert", "!", "autovideosink", "sync=false"])


if __name__ == "__main__":
    main()
