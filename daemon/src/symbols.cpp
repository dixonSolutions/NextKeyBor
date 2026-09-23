// Symbol search: a generated Unicode table (arrows, currency, maths, punctuation,
// super/subscripts, Greek, …) merged with CLDR's localized names for the same characters.
#include <algorithm>
#include <map>
#include <set>

#include "emoji.h"
#include "util.h"

namespace nkb::emoji {
std::vector<std::pair<std::string, std::pair<std::string, std::vector<std::string>>>> cldr_symbols();
}

namespace nkb::symbols {

namespace {

struct Row {
    const char *symbol;
    const char *name;
    const char *aliases;
};

const Row kTable[] = {
#include "symbols_table.inc"
};

struct Sym {
    std::string symbol, name, name_folded;
    std::vector<std::string> keywords;
    int order;
};

std::vector<Sym> &table() {
    static std::vector<Sym> syms = [] {
        std::vector<Sym> out;
        std::map<std::string, size_t> index;
        for (const auto &r : kTable) {
            Sym s{r.symbol, r.name, fold(r.name), split_words(fold(r.aliases)), static_cast<int>(out.size())};
            index[s.symbol] = out.size();
            out.push_back(std::move(s));
        }
        for (auto &[cp, data] : emoji::cldr_symbols()) {
            auto &[name, kws] = data;
            auto it = index.find(cp);
            if (it == index.end()) {
                index[cp] = out.size();
                out.push_back(Sym{cp, name, name, kws, static_cast<int>(out.size())});
            } else {
                auto &k = out[it->second].keywords;
                k.insert(k.end(), kws.begin(), kws.end());
                if (!name.empty())
                    k.push_back(name);
            }
        }
        return out;
    }();
    return syms;
}

}  // namespace

std::string search(const std::string &query, unsigned max) {
    max = std::clamp(max ? max : 60u, 1u, 500u);
    auto &syms = table();
    json out = json::array();
    std::vector<std::string> toks = split_words(fold(query));
    if (toks.empty()) {
        for (size_t i = 0; i < syms.size() && out.size() < max; i++)
            out.push_back({{"symbol", syms[i].symbol}, {"name", syms[i].name}});
        return out.dump();
    }
    std::vector<std::pair<int, const Sym *>> hits;
    for (const auto &s : syms) {
        int score = emoji::match_score(toks, s.name_folded, s.keywords);
        if (score > 0)
            hits.emplace_back(score, &s);
    }
    std::stable_sort(hits.begin(), hits.end(), [](auto &a, auto &b) {
        return a.first != b.first ? a.first > b.first : a.second->order < b.second->order;
    });
    for (size_t i = 0; i < hits.size() && out.size() < max; i++)
        out.push_back({{"symbol", hits[i].second->symbol}, {"name", hits[i].second->name}});
    return out.dump();
}

}  // namespace nkb::symbols
