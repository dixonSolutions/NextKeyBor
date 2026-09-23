// System-wide physical keyboard detection (evdev) that switches the GNOME
// on-screen keyboard on and off:
//   * physical keyboard connected (Type Cover, Bluetooth, USB)   -> OSK off
//   * all keyboards gone, or Type Cover folded back (tablet mode) -> OSK on
//   * typing on a physical keyboard while the OSK is on           -> OSK off
#pragma once

#include "util.h"

namespace nkb::keyboard {

void init(bool manage);  // manage=false: observe only, never touch the OSK setting
json state();
// One-shot scan for --status (no main loop needed).
json scan_once();

}  // namespace nkb::keyboard
