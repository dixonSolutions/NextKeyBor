#!/usr/bin/env python3
"""Drive the test session from tools/nested/run.sh with touches and screenshots.

Uses Mutter's remote desktop and screen cast D-Bus APIs (what screen sharing
uses), so the test shell needs no unsafe mode.

    tools/nested/drive.py DIR 'tap 700 800; wait 0.3; swipe 100,800 300,800 500,850; shot out.png'

Commands (coordinates are pixels on the 1440x960 test monitor):
    tap X Y [DX DY]      touch down and up (optionally drifting by DX,DY before lifting)
    swipe X,Y X,Y ...    one finger through the points, ~60 ms per segment
    hold X Y SECONDS     touch and hold
    key KEYSYM [N]       press and release a key (X keysym, e.g. 0xff08 BackSpace) N times
    chord KEYSYM+KEYSYM  hold the keys down in order, then release (e.g. 0xffe3+0xffe1+0x79 Ctrl+Shift+Y)
    wait SECONDS
    shot FILE.png        screenshot
    text FILE            print what the test app (tools/nested/textapp.py) holds
"""
import math
import subprocess
import sys
import time
from pathlib import Path

from gi.repository import Gio, GLib

MUTTER_RD = "org.gnome.Mutter.RemoteDesktop"
MUTTER_SC = "org.gnome.Mutter.ScreenCast"
STEP_S = 0.008


class Driver:
    def __init__(self, bus_address):
        self.bus = Gio.DBusConnection.new_for_address_sync(
            bus_address,
            Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
            None, None)
        self.ctx = GLib.MainContext.default()
        rd_path = self._call(MUTTER_RD, "/org/gnome/Mutter/RemoteDesktop", MUTTER_RD, "CreateSession")[0]
        self.rd = Gio.DBusProxy.new_sync(self.bus, 0, None, MUTTER_RD, rd_path, MUTTER_RD + ".Session", None)
        session_id = self.rd.get_cached_property("SessionId").unpack()
        sc_path = self._call(MUTTER_SC, "/org/gnome/Mutter/ScreenCast", MUTTER_SC, "CreateSession",
                             GLib.Variant("(a{sv})", ({"remote-desktop-session-id": GLib.Variant("s", session_id)},)))[0]
        self.stream = self._call(MUTTER_SC, sc_path, MUTTER_SC + ".Session", "RecordMonitor",
                                 GLib.Variant("(sa{sv})", ("", {})))[0]
        self.node = None
        self.bus.signal_subscribe(MUTTER_SC, MUTTER_SC + ".Stream", "PipeWireStreamAdded", self.stream,
                                  None, 0, self._on_node)
        self.rd.call_sync("Start", None, 0, 5000, None)
        self._pump_until(lambda: self.node is not None, 5)

    def _call(self, name, path, iface, method, params=None):
        return self.bus.call_sync(name, path, iface, method, params, None, 0, 5000, None).unpack()

    def _on_node(self, _conn, _sender, _path, _iface, _signal, params):
        self.node = params.unpack()[0]

    def _pump_until(self, done, timeout):
        end = time.time() + timeout
        while not done() and time.time() < end:
            self.ctx.iteration(False)
            time.sleep(0.005)

    def wait(self, seconds):
        self._pump_until(lambda: False, seconds)

    def _touch(self, method, *args):
        sig = {"NotifyTouchDown": "(sudd)", "NotifyTouchMotion": "(sudd)", "NotifyTouchUp": "(u)"}[method]
        self.rd.call_sync(method, GLib.Variant(sig, args), 0, 5000, None)

    def tap(self, x, y, dx=0.0, dy=0.0):
        self._touch("NotifyTouchDown", self.stream, 0, x, y)
        self.wait(0.03)
        if dx or dy:
            for t in (0.5, 1.0):
                self._touch("NotifyTouchMotion", self.stream, 0, x + dx * t, y + dy * t)
                self.wait(0.015)
        else:
            self.wait(0.03)
        self._touch("NotifyTouchUp", 0)
        self.wait(0.12)

    def hold(self, x, y, seconds):
        self._touch("NotifyTouchDown", self.stream, 0, x, y)
        self.wait(seconds)
        self._touch("NotifyTouchUp", 0)
        self.wait(0.12)

    def swipe(self, points, seg_s=0.06):
        (x, y) = points[0]
        self._touch("NotifyTouchDown", self.stream, 0, x, y)
        self.wait(STEP_S)
        for (x0, y0), (x1, y1) in zip(points, points[1:]):
            steps = max(2, int(seg_s / STEP_S))
            for i in range(1, steps + 1):
                t = i / steps
                self._touch("NotifyTouchMotion", self.stream, 0, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)
                self.wait(STEP_S)
        self._touch("NotifyTouchUp", 0)
        self.wait(0.15)

    def key(self, keysym, times=1):
        for _ in range(times):
            for state in (True, False):
                self.rd.call_sync("NotifyKeyboardKeysym", GLib.Variant("(ub)", (keysym, state)), 0, 5000, None)
                self.wait(0.01)

    def chord(self, keysyms):
        for keysym in keysyms:
            self.rd.call_sync("NotifyKeyboardKeysym", GLib.Variant("(ub)", (keysym, True)), 0, 5000, None)
            self.wait(0.03)
        for keysym in reversed(keysyms):
            self.rd.call_sync("NotifyKeyboardKeysym", GLib.Variant("(ub)", (keysym, False)), 0, 5000, None)
            self.wait(0.03)

    def shot(self, path):
        subprocess.run(["gst-launch-1.0", "-q", "pipewiresrc", f"path={self.node}", "keepalive-time=100", "num-buffers=1",
                        "!", "videoconvert", "!", "pngenc", "!", "filesink", f"location={path}"],
                       check=True, timeout=15)


def points(args):
    return [tuple(float(v) for v in a.split(",")) for a in args]


def main():
    state = Path(sys.argv[1])
    d = Driver(state.joinpath("bus").read_text().strip())
    for command in " ".join(sys.argv[2:]).split(";"):
        words = command.split()
        if not words:
            continue
        op, args = words[0], words[1:]
        if op == "tap":
            d.tap(*(float(a) for a in args[:4]))
        elif op == "hold":
            d.hold(float(args[0]), float(args[1]), float(args[2]))
        elif op == "swipe":
            d.swipe(points(args))
        elif op == "key":
            d.key(int(args[0], 0), int(args[1]) if len(args) > 1 else 1)
        elif op == "chord":
            d.chord([int(k, 0) for k in args[0].split("+")])
        elif op == "wait":
            d.wait(float(args[0]))
        elif op == "shot":
            d.shot(args[0])
        elif op == "text":
            print(repr(Path(args[0]).read_text()) if Path(args[0]).exists() else "<no text yet>")
        else:
            sys.exit(f"unknown command: {op}")


if __name__ == "__main__":
    main()
