# NextKeyBor

A smarter on-screen keyboard for GNOME on Wayland, made for touchscreens and 2-in-1s such as the Microsoft Surface.

NextKeyBor adds these to GNOME's built-in on-screen keyboard (OSK):

- **🎤 Dictation:** speak and the text goes straight into the app. It runs locally with [whisper.cpp](https://github.com/ggml-org/whisper.cpp), and you can pick the language (or leave it on auto-detect). Optionally, with [GroqType](https://github.com/dixonSolutions/GroqType) installed and a Groq API key set (in GroqType, or from NextKeyBor's settings), dictation uses Groq's cloud Whisper instead, falling back to the local model when offline.
- **🌐 Languages:** switch the dictation language and your system keyboard layouts. It can also download spell-check dictionaries and language packs through PackageKit, the same system that GNOME Software uses.
- **Autocomplete:** word completion, typo fixes and next-word prediction. It learns the words you type and keeps them only on your machine.
- **Swipe typing:** slide across the letters and lift; a fading trail follows your finger. The best match is typed, the other matches wait in the suggestion bar, and backspace right after removes the whole word.
- **Resizable:** drag the handle on top of the keyboard to set its height, separately for landscape and portrait.
- **Floating keyboard:** switch it on from the keyboard button in the top bar (hold it for the menu) or in settings. The keyboard becomes a panel you drag by its top bar; it opens where you left it, whether you tap a text field or the top bar button, and its X closes it.
- **Screenshots:** the camera button opens GNOME's screenshot tool (area, window or screen; picture or video).
- **Hold for special characters:** long-press top-row letters for the digits 1–0. Other keys give common symbols, alongside GNOME's accented letters.
- **Emoji and symbol search:** find emoji by name in your own language (using Unicode CLDR data) and search more than 1,100 symbols (arrows, currency, maths…).
- **GIFs and stickers:** search online results from GIPHY, Tenor or KLIPY with a free API key, or from Openverse with no key at all (openly licensed, mostly Wikimedia animations). You can:
  - favourite items (saved locally, so they work offline)
  - import your own GIFs through the system file picker
  - search your favourites and your own GIFs too.
- **Physical keyboard detection:** the on-screen keyboard switches on when no real keyboard can be used, and off again when one can. This covers a Type Cover folded back into tablet mode, a Bluetooth or USB keyboard being connected, and typing on a physical keyboard.
- **Fixes for GNOME's keyboard:**
  - The keyboard now opens when you tap text fields in Chromium, Electron and Qt apps. Mutter only opens it for apps that re-enable text input on each tap, which those apps don't do.
  - Shift no longer switches on by itself after every backspace in terminals and Chromium apps.

## How it's built

| Part | Language | What it does |
|---|---|---|
| `daemon/`: `nextkeybord` | C++20 | D-Bus service `io.github.nextkeybor.Daemon`: speech capture and transcription, suggestions, emoji and symbol search, GIF providers and cache, languages, keyboard detection through evdev |
| `extension/` | GJS | GNOME Shell extension that adds the toolbar and panels to the stock OSK. Keyboard UI has to live in the shell on Wayland, so it can't be a C++ app. |
| `data/` | | D-Bus interface, GSettings schema, systemd and D-Bus activation files |

## Install

Requires GNOME Shell 50, CMake, Ninja, a C++20 compiler, GLib and libcurl development headers, and PipeWire (`pw-record`). whisper.cpp and nlohmann/json are downloaded automatically when you build.

```sh
# Fedora
sudo dnf install cmake ninja-build gcc-c++ glib2-devel libcurl-devel pipewire-utils
./install.sh            # builds and installs for your user only, no root needed
```

Then log out and back in. Download a speech model from the 🌐 button on the keyboard. The `base` model is 142 MB and supports many languages.

GIF search works straight away through Openverse. For GIPHY, KLIPY or Tenor results, add a free API key: `gnome-extensions prefs nextkeybor@nextkeybor.github.io`.

To uninstall, run `./install.sh --uninstall`.

## Data and privacy

Everything stays on your machine unless you search for GIFs or stickers, which sends your query to the provider you picked.

- Learned words, favourites and your own GIF library: `~/.local/share/nextkeybor/`
- Cache: `~/.cache/nextkeybor/`

## Licence

GPL-3.0-or-later. Word frequency lists come from [FrequencyWords](https://github.com/hermitdave/FrequencyWords) (CC-BY-SA 4.0) and are downloaded the first time each language is used.

## Testing without logging out

`tools/nested/` runs a second GNOME Shell with its own D-Bus session and a copy of your settings, loads the installed NextKeyBor, and drives it with touches through Mutter's remote desktop API:

```bash
./install.sh
tools/nested/restart.sh /tmp/nkb                                   # session + a text box to type into
tools/nested/drive.py /tmp/nkb 'tap 700 450; wait 1; shot /tmp/k.png'
```

With `mutter-devkit` installed (`sudo dnf install mutter-devkit`) the session also opens as a window you can use yourself.
