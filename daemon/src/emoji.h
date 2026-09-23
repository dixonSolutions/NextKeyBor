// Emoji and symbol search.
#pragma once

#include <string>
#include <vector>

namespace nkb::emoji {

void init();  // registers SearchEmoji / NoteEmojiUsed / SearchSymbols

// Shared ranking used by emoji and symbols. Higher is better, 0 = no match.
int match_score(const std::vector<std::string> &query_tokens, const std::string &name_folded,
                const std::vector<std::string> &keywords_folded);

}  // namespace nkb::emoji

namespace nkb::symbols {

// JSON array [{"symbol", "name"}] best matches first.
std::string search(const std::string &query, unsigned max);

}  // namespace nkb::symbols
