// Dictation: microphone capture through PipeWire, transcription with whisper.cpp.
#pragma once

#include <string>

#include "util.h"

namespace nkb::speech {

void init();  // registers D-Bus methods
json status();
bool is_recording();
// Offline transcription of a 16 kHz mono file (WAV PCM16 or raw float32le), for testing.
int transcribe_file(const std::string &path, const std::string &language);

}  // namespace nkb::speech
