// Word completion, correction and next-word prediction.
//
// Vocabulary comes from the installed hunspell dictionary for the language,
// ranked by the FrequencyWords list (downloaded once per language), and is
// boosted by what the user actually types (unigrams + bigrams, stored locally).
#pragma once

#include <string>
#include <vector>

namespace nkb::predict {

void init();  // registers D-Bus methods
std::string active_language();
void set_active_language(const std::string &code);
std::vector<std::string> suggest(const std::string &context, const std::string &lang, unsigned max);
void learn(const std::string &text, const std::string &lang);
// Drops the cached vocabulary so a newly installed dictionary is picked up.
void reload(const std::string &lang);

}  // namespace nkb::predict
