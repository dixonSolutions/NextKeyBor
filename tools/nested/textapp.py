#!/usr/bin/env python3
"""A text box for the test session; saves what it holds to a file on every change.

    WAYLAND_DISPLAY=nkb-test tools/nested/textapp.py OUT.txt
"""
import sys

import gi

gi.require_version("Gtk", "4.0")
from gi.repository import Gtk  # noqa: E402

out = sys.argv[1]


def on_activate(app):
    win = Gtk.ApplicationWindow(application=app, title="NextKeyBor test", default_width=1400, default_height=420)
    view = Gtk.TextView(wrap_mode=Gtk.WrapMode.WORD_CHAR, top_margin=12, left_margin=12)
    view.get_buffer().connect("changed", lambda buf: open(out, "w").write(
        buf.get_text(buf.get_start_iter(), buf.get_end_iter(), False)))
    win.set_child(view)
    win.present()
    view.grab_focus()


app = Gtk.Application(application_id="io.github.nextkeybor.TestText")
app.connect("activate", on_activate)
app.run([])
