#include "predict.h"

#include <algorithm>
#include <cmath>
#include <map>
#include <memory>
#include <set>
#include <unordered_map>
#include <unordered_set>

#include "dbus_service.h"
#include "util.h"

namespace nkb::predict {

namespace {

struct Entry {
    std::string key;    // folded, for lookup
    std::string word;   // as it should be written
    double base;        // dictionary score
    bool stem = false;  // in the hunspell word list (a real word, not just a frequent token)
};

class Model {
public:
    explicit Model(std::string lang) : lang_(std::move(lang)) {
        load_user();
        build();
        maybe_fetch_frequencies();
    }

    std::vector<std::string> suggest(const std::string &context, unsigned max);
    std::vector<std::string> swipe(const std::string &context, const std::map<gunichar, Point> &keys,
                                   const std::vector<Point> &path, unsigned max);
    void learn(const std::string &text);
    void forget(const std::string &word);
    void build();

private:
    std::string user_path() const { return join_path(data_dir(), "words-" + lang_ + ".json"); }
    std::string freq_path() const { return join_path(data_dir("wordfreq"), freq_code() + "_50k.txt"); }
    std::string freq_code() const;
    void load_user();
    void schedule_save();
    void maybe_fetch_frequencies();
    double score(const Entry &e) const;
    void add_candidates(const std::string &prefix_key, std::map<std::string, double> &out) const;
    void add_corrections(const std::string &key, std::map<std::string, double> &out) const;

    std::string lang_;
    std::vector<Entry> entries_;                         // sorted by key
    std::unordered_map<std::string, size_t> exact_;       // key -> index
    std::set<gunichar> alphabet_;
    json user_ = json::object();
    std::unordered_set<std::string> blocked_;
    guint save_id_ = 0;
    bool fetching_ = false;
};

std::map<std::string, std::unique_ptr<Model>> g_models;
std::string g_active;

std::string dic_path(const std::string &lang) {
    for (const char *dir : {"/usr/share/hunspell", "/usr/share/myspell", "/usr/local/share/hunspell"}) {
        std::string p = join_path(dir, lang + ".dic");
        if (file_exists(p))
            return p;
    }
    return "";
}

std::string Model::freq_code() const {
    std::string l = lang_;
    std::transform(l.begin(), l.end(), l.begin(), ::tolower);
    if (l == "pt_br" || l == "zh_cn" || l == "zh_tw")
        return l;
    return l.substr(0, l.find('_'));
}

void Model::load_user() {
    user_ = load_json(user_path(), json::object());
    if (!user_.is_object())
        user_ = json::object();
    for (const char *k : {"unigrams", "bigrams"})
        if (!user_.contains(k) || !user_[k].is_object())
            user_[k] = json::object();
    if (!user_.contains("blocked") || !user_["blocked"].is_array())
        user_["blocked"] = json::array();
    for (const auto &w : user_["blocked"])
        blocked_.insert(w.get<std::string>());
}

void Model::schedule_save() {
    if (save_id_)
        return;
    save_id_ = g_timeout_add_seconds(5, [](gpointer self) -> gboolean {
        auto *m = static_cast<Model *>(self);
        m->save_id_ = 0;
        save_json(m->user_path(), m->user_);
        return G_SOURCE_REMOVE;
    }, this);
}

// Lower-case letters with inner apostrophes only: no names, no junk tokens.
bool is_plain_word(const std::string &w) {
    for (const gchar *p = w.c_str(); *p; p = g_utf8_next_char(p)) {
        gunichar c = g_utf8_get_char(p);
        if (!(g_unichar_isalpha(c) && g_unichar_islower(c)) && c != '\'')
            return false;
    }
    return !w.empty() && w.front() != '\'' && w.back() != '\'';
}

void Model::build() {
    std::unordered_map<std::string, Entry> words;

    // Hunspell stems (no affix expansion); the file's first line is the count.
    std::string dic = dic_path(lang_), text;
    if (!dic.empty() && read_file(dic, text)) {
        size_t pos = text.find('\n');
        while (pos != std::string::npos && pos + 1 < text.size()) {
            size_t end = text.find('\n', pos + 1);
            std::string line = text.substr(pos + 1, end == std::string::npos ? std::string::npos : end - pos - 1);
            pos = end;
            size_t cut = line.find_first_of("/\t ");
            std::string w = line.substr(0, cut);
            if (w.empty() || !g_utf8_validate(w.c_str(), -1, nullptr))
                continue;
            if (std::any_of(w.begin(), w.end(), [](char c) { return g_ascii_isdigit(c) || c == '.'; }))
                continue;
            std::string key = fold(w);
            auto [it, inserted] = words.emplace(key, Entry{key, w, 1.0, true});
            // "he" and "He" (helium) fold together: prefer the lower-case spelling.
            if (!inserted && g_unichar_islower(g_utf8_get_char(w.c_str())))
                it->second.word = w;
        }
    }
    bool have_dic = !words.empty();

    // Frequency ranking: "word count" per line, most common first.
    if (read_file(freq_path(), text)) {
        size_t rank = 0, pos = 0;
        while (pos < text.size()) {
            size_t end = text.find('\n', pos);
            if (end == std::string::npos)
                end = text.size();
            std::string line = text.substr(pos, end - pos);
            pos = end + 1;
            std::string w = line.substr(0, line.find(' '));
            if (w.empty() || !g_utf8_validate(w.c_str(), -1, nullptr))
                continue;
            rank++;
            std::string key = fold(w);
            double s = 10.0 + 1000.0 / (1.0 + static_cast<double>(rank) / 20.0);
            auto it = words.find(key);
            if (it != words.end()) {
                it->second.base = std::max(it->second.base, s);
            } else if (!have_dic || rank <= 3000 || (rank <= 20000 && is_plain_word(w))) {
                // The stem list has no inflections ("typing", "worked"): take
                // common words from the frequency list instead.
                words.emplace(key, Entry{key, w, s});
            }
        }
    }

    // Words only the user has typed (twice or more) join the vocabulary.
    for (auto &[w, c] : user_["unigrams"].items()) {
        std::string key = fold(w);
        if (!words.count(key) && c.get<int>() >= 2)
            words.emplace(key, Entry{key, w, 5.0});
    }

    // English "I" is always capitalised, whatever the word lists say.
    if (freq_code() == "en") {
        auto i = words.find("i");
        if (i != words.end())
            i->second.word = "I";
    }

    entries_.clear();
    entries_.reserve(words.size());
    for (auto &[k, e] : words)
        entries_.push_back(std::move(e));
    std::sort(entries_.begin(), entries_.end(), [](const Entry &a, const Entry &b) { return a.key < b.key; });
    exact_.clear();
    alphabet_.clear();
    for (size_t i = 0; i < entries_.size(); i++) {
        exact_[entries_[i].key] = i;
        if (entries_[i].base > 10)
            for (const gchar *p = entries_[i].key.c_str(); *p; p = g_utf8_next_char(p))
                alphabet_.insert(g_utf8_get_char(p));
    }
    if (alphabet_.empty())
        for (gunichar c = 'a'; c <= 'z'; c++)
            alphabet_.insert(c);
    g_message("predict: %s has %zu words", lang_.c_str(), entries_.size());
}

void Model::maybe_fetch_frequencies() {
    if (file_exists(freq_path()) || fetching_)
        return;
    fetching_ = true;
    std::string code = freq_code(), dest = freq_path(), lang = lang_;
    run_in_worker([code, dest, lang] {
        auto r = http_download("https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/" +
                                   code + "/" + code + "_50k.txt",
                               dest);
        if (!r.ok()) {
            g_message("no word frequency list for %s: %s", code.c_str(), r.error.c_str());
            return;
        }
        run_on_main([lang] {
            auto it = g_models.find(lang);
            if (it != g_models.end())
                it->second->build();
        });
    });
}

double Model::score(const Entry &e) const {
    double s = e.base;
    auto it = user_["unigrams"].find(e.word);
    if (it == user_["unigrams"].end())
        it = user_["unigrams"].find(e.key);
    if (it != user_["unigrams"].end())
        s += 400.0 * it->get<double>();
    return s;
}

void Model::add_candidates(const std::string &prefix_key, std::map<std::string, double> &out) const {
    auto lo = std::lower_bound(entries_.begin(), entries_.end(), prefix_key,
                               [](const Entry &e, const std::string &k) { return e.key < k; });
    for (auto it = lo; it != entries_.end() && it->key.compare(0, prefix_key.size(), prefix_key) == 0; ++it) {
        if (blocked_.count(it->key))
            continue;
        double s = score(*it);
        if (it->key == prefix_key)
            s *= 1.5;  // the word as typed is a complete word
        auto [pos, inserted] = out.emplace(it->word, s);
        if (!inserted)
            pos->second = std::max(pos->second, s);
    }
}

void Model::add_corrections(const std::string &key, std::map<std::string, double> &out) const {
    // Known words at edit distance 1 (delete, transpose, replace, insert).
    std::vector<std::string> chars;
    for (const gchar *p = key.c_str(); *p; p = g_utf8_next_char(p))
        chars.emplace_back(p, static_cast<size_t>(g_utf8_next_char(p) - p));
    std::vector<std::string> alpha;
    for (gunichar c : alphabet_) {
        char buf[8];
        alpha.emplace_back(buf, static_cast<size_t>(g_unichar_to_utf8(c, buf)));
    }
    auto join = [](const std::vector<std::string> &v) {
        std::string s;
        for (const auto &c : v)
            s += c;
        return s;
    };
    std::set<std::string> edits;
    for (size_t i = 0; i < chars.size(); i++) {
        auto v = chars;
        if (chars.size() >= 4) {
            v.erase(v.begin() + static_cast<long>(i));
            edits.insert(join(v));
        }
        if (i + 1 < chars.size()) {
            v = chars;
            std::swap(v[i], v[i + 1]);
            edits.insert(join(v));
        }
        for (const auto &a : alpha) {
            v = chars;
            v[i] = a;
            edits.insert(join(v));
        }
    }
    for (size_t i = 0; i <= chars.size(); i++)
        for (const auto &a : alpha) {
            auto v = chars;
            v.insert(v.begin() + static_cast<long>(i), a);
            edits.insert(join(v));
        }
    edits.erase(key);
    for (const auto &e : edits) {
        auto it = exact_.find(e);
        if (it == exact_.end() || blocked_.count(e))
            continue;
        const Entry &en = entries_[it->second];
        double s = score(en) * 0.3;
        auto [pos, inserted] = out.emplace(en.word, s);
        if (!inserted)
            pos->second = std::max(pos->second, s);
    }
}

std::string match_case(const std::string &typed, const std::string &word) {
    if (typed.empty())
        return word;
    gunichar first = g_utf8_get_char(typed.c_str());
    if (!g_unichar_isupper(first))
        return word;
    bool all_upper = g_utf8_strlen(typed.c_str(), -1) > 1;
    for (const gchar *p = typed.c_str(); *p && all_upper; p = g_utf8_next_char(p))
        if (g_unichar_islower(g_utf8_get_char(p)))
            all_upper = false;
    if (all_upper) {
        gchar *u = g_utf8_strup(word.c_str(), -1);
        std::string out = u;
        g_free(u);
        return out;
    }
    gunichar c = g_unichar_toupper(g_utf8_get_char(word.c_str()));
    char buf[8];
    std::string out(buf, static_cast<size_t>(g_unichar_to_utf8(c, buf)));
    out += g_utf8_next_char(word.c_str());
    return out;
}

std::vector<std::string> Model::suggest(const std::string &context, unsigned max) {
    std::map<std::string, double> cand;
    auto words = split_words(context);
    bool next_word = context.empty() || !g_unichar_isalnum(g_utf8_get_char(
                                            g_utf8_prev_char(context.c_str() + context.size())));
    // An apostrophe/hyphen inside a word still counts as part of it.
    if (!context.empty() && (context.back() == '\'' || context.back() == '-'))
        next_word = false;

    std::string typed = next_word || words.empty() ? "" : words.back();
    std::string prev;
    if (next_word && !words.empty())
        prev = words.back();
    else if (!next_word && words.size() >= 2)
        prev = words[words.size() - 2];
    std::string prev_key = fold(prev);

    if (!typed.empty()) {
        std::string key = fold(typed);
        add_candidates(key, cand);
        // Only look for typos when the prefix does not lead anywhere useful.
        glong len = g_utf8_strlen(key.c_str(), -1);
        if (len >= 3 && len <= 20 && cand.size() < max)
            add_corrections(key, cand);
    }

    // Bigram boost / next-word prediction.
    auto bi = user_["bigrams"].find(prev_key);
    if (!prev_key.empty() && bi != user_["bigrams"].end()) {
        std::string tkey = fold(typed);
        for (auto &[w, c] : bi->items()) {
            if (!tkey.empty() && fold(w).compare(0, tkey.size(), tkey) != 0)
                continue;
            if (blocked_.count(fold(w)))
                continue;
            cand[w] += 2000.0 * c.get<double>();
        }
    }
    if (next_word && cand.size() < max) {
        // Fall back to the most common words.
        std::vector<const Entry *> top;
        for (const auto &e : entries_)
            if (e.base > 500)
                top.push_back(&e);
        std::sort(top.begin(), top.end(), [this](const Entry *a, const Entry *b) { return score(*a) > score(*b); });
        for (size_t i = 0; i < top.size() && cand.size() < max * 2; i++)
            cand.emplace(top[i]->word, score(*top[i]) * 0.1);
    }

    std::vector<std::pair<std::string, double>> ranked(cand.begin(), cand.end());
    std::sort(ranked.begin(), ranked.end(), [](auto &a, auto &b) { return a.second > b.second; });
    std::vector<std::string> out;
    std::set<std::string> seen;
    for (auto &[w, s] : ranked) {
        std::string shown = match_case(typed, w);
        if (!seen.insert(shown).second)
            continue;
        out.push_back(shown);
        if (out.size() >= max)
            break;
    }
    // Put the literally typed word first if it is a known word, like phone keyboards do.
    if (!typed.empty()) {
        auto it = std::find(out.begin(), out.end(), typed);
        if (it != out.end() && it != out.begin())
            std::rotate(out.begin(), it, it + 1);
    }
    return out;
}

// ---- swipe typing ----

constexpr size_t kSwipeSamples = 48;
constexpr double kSwipeEndRadius = 1.0;    // first/last letter within a key of the path ends
constexpr double kSwipeLetterRadius = 0.9; // every letter passed at least this close
constexpr double kSwipeSigma = 0.22;       // tolerated mean distance from the ideal path
constexpr double kSwipeFreqWeight = 0.45;  // how much word frequency counts against shape
constexpr double kSwipeNamePenalty = 1.0;  // rare capitalised words (names) the user never typed

double path_length(const std::vector<Point> &pts) {
    double total = 0;
    for (size_t i = 1; i < pts.size(); i++)
        total += std::hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return total;
}

// n points evenly spaced along the path.
std::vector<Point> resample(const std::vector<Point> &in, size_t n) {
    double total = path_length(in);
    if (in.size() < 2 || total <= 0)
        return std::vector<Point>(n, in.empty() ? Point{0, 0} : in.front());
    double step = total / static_cast<double>(n - 1), acc = 0;
    std::vector<Point> out{in.front()};
    Point prev = in.front();
    size_t i = 1;
    while (i < in.size() && out.size() < n - 1) {
        double d = std::hypot(in[i].x - prev.x, in[i].y - prev.y);
        if (d > 0 && acc + d >= step) {
            double t = (step - acc) / d;
            prev = {prev.x + t * (in[i].x - prev.x), prev.y + t * (in[i].y - prev.y)};
            out.push_back(prev);
            acc = 0;
        } else {
            acc += d;
            prev = in[i++];
        }
    }
    while (out.size() < n)
        out.push_back(in.back());
    return out;
}

std::vector<std::string> Model::swipe(const std::string &context, const std::map<gunichar, Point> &keys,
                                      const std::vector<Point> &raw, unsigned max) {
    if (raw.size() < 2 || keys.empty())
        return {};
    const auto path = resample(raw, kSwipeSamples);
    const Point start = raw.front(), end = raw.back();
    const double user_len = path_length(raw);
    auto dist = [](Point a, Point b) { return std::hypot(a.x - b.x, a.y - b.y); };

    auto words = split_words(context);
    std::string prev_key = words.empty() ? "" : fold(words.back());
    auto bi = user_["bigrams"].find(prev_key);
    const json *bigrams = !prev_key.empty() && bi != user_["bigrams"].end() ? &*bi : nullptr;

    std::vector<std::pair<double, const Entry *>> scored;
    std::vector<Point> ideal;
    for (const auto &e : entries_) {
        ideal.clear();
        bool ok = true;
        for (const gchar *p = e.key.c_str(); *p; p = g_utf8_next_char(p)) {
            gunichar c = g_utf8_get_char(p);
            auto it = keys.find(c);
            if (it == keys.end()) {
                if (c != '\'' && c != '-') {
                    ok = false;  // a letter this layout lacks, or "mr." and the like
                    break;
                }
                continue;  // apostrophes and hyphens are not on the letter keys
            }
            // Double letters are one stop on the path.
            if (ideal.empty() || dist(ideal.back(), it->second) > 1e-6)
                ideal.push_back(it->second);
        }
        if (!ok || ideal.size() < 2 || blocked_.count(e.key))
            continue;
        if (dist(ideal.front(), start) > kSwipeEndRadius || dist(ideal.back(), end) > kSwipeEndRadius)
            continue;
        double ideal_len = path_length(ideal);
        if (std::abs(ideal_len - user_len) > 1.5 + 0.5 * std::max(ideal_len, user_len))
            continue;
        bool covered = std::all_of(ideal.begin(), ideal.end(), [&](const Point &k) {
            return std::any_of(path.begin(), path.end(), [&](const Point &q) { return dist(q, k) <= kSwipeLetterRadius; });
        });
        if (!covered)
            continue;

        auto shape = resample(ideal, kSwipeSamples);
        double d = 0;
        for (size_t i = 0; i < kSwipeSamples; i++)
            d += dist(shape[i], path[i]);
        d /= kSwipeSamples;

        double s = score(e);
        if (bigrams) {
            auto b = bigrams->find(e.word);
            if (b != bigrams->end())
                s += 2000.0 * b->get<double>();
        }
        double total = -(d * d) / (2 * kSwipeSigma * kSwipeSigma) + kSwipeFreqWeight * std::log1p(s);
        if (s <= 1.0 && g_unichar_isupper(g_utf8_get_char(e.word.c_str())))
            total -= kSwipeNamePenalty;
        if (e.word.size() > 1 && e.word != "I" &&
            std::none_of(e.word.begin(), e.word.end(), [](char c) { return g_ascii_islower(c); }))
            total -= kSwipeNamePenalty;  // acronyms: "US", "USS"
        scored.push_back({total, &e});
    }

    std::sort(scored.begin(), scored.end(), [](auto &a, auto &b) { return a.first > b.first; });
    // "dont" and "don't" trace the same path: list it once, with the apostrophe.
    auto letters = [](const std::string &w) {
        std::string k = fold(w);
        k.erase(std::remove_if(k.begin(), k.end(), [](char c) { return c == '\'' || c == '-'; }), k.end());
        return k;
    };
    // Only when the plain spelling is not a dictionary word ("well" stays).
    std::vector<const Entry *> picked;
    std::map<std::string, size_t> seen;  // letters -> index in picked
    for (auto &[s, e] : scored) {
        std::string key = letters(e->word);
        auto it = seen.find(key);
        if (it != seen.end()) {
            const Entry *&have = picked[it->second];
            bool apostrophe = e->word.find('\'') != std::string::npos &&
                              have->word.find('\'') == std::string::npos;
            if (apostrophe && !have->stem)
                have = e;
            // Both real words ("cant" and "can't"): offer both.
            if (!(apostrophe && have->stem && have != e) || picked.size() >= max)
                continue;
            picked.push_back(e);
            continue;
        }
        // Once full, keep scanning only so an apostrophe spelling can still win.
        if (picked.size() < max) {
            seen.emplace(key, picked.size());
            picked.push_back(e);
        }
    }
    std::vector<std::string> out;
    for (const Entry *e : picked)
        out.push_back(e->word);
    return out;
}

void Model::learn(const std::string &text) {
    if (!setting_bool("learn-words", true))
        return;
    // Only learn finished words: drop a trailing partial word.
    auto words = split_words(text);
    if (!text.empty() && !words.empty() &&
        g_unichar_isalnum(g_utf8_get_char(g_utf8_prev_char(text.c_str() + text.size()))))
        words.pop_back();
    if (words.empty())
        return;

    auto &uni = user_["unigrams"];
    auto &bis = user_["bigrams"];
    bool vocabulary_changed = false;
    std::string prev_key;
    for (const auto &w : words) {
        if (g_utf8_strlen(w.c_str(), -1) > 40 || g_unichar_isdigit(g_utf8_get_char(w.c_str()))) {
            prev_key.clear();
            continue;
        }
        std::string key = fold(w);
        blocked_.erase(key);
        // Store the dictionary spelling for known words so "The" and "the" share a count.
        auto known = exact_.find(key);
        std::string store = known != exact_.end() ? entries_[known->second].word : w;
        int count = uni.value(store, 0) + 1;
        uni[store] = count;
        if (known == exact_.end() && count == 2)
            vocabulary_changed = true;
        if (!prev_key.empty()) {
            auto &next = bis[prev_key];
            if (!next.is_object())
                next = json::object();
            next[store] = next.value(store, 0) + 1;
        }
        prev_key = key;
    }
    // Keep the personal dictionary bounded.
    if (uni.size() > 20000) {
        for (auto it = uni.begin(); it != uni.end();)
            it = it.value().get<int>() <= 1 ? uni.erase(it) : std::next(it);
    }
    user_["blocked"] = json(std::vector<std::string>(blocked_.begin(), blocked_.end()));
    schedule_save();
    if (vocabulary_changed)
        build();
}

void Model::forget(const std::string &word) {
    std::string key = fold(word);
    blocked_.insert(key);
    auto &uni = user_["unigrams"];
    for (auto it = uni.begin(); it != uni.end();)
        it = fold(it.key()) == key ? uni.erase(it) : std::next(it);
    auto &bis = user_["bigrams"];
    bis.erase(key);
    for (auto &[k, next] : bis.items())
        for (auto it = next.begin(); it != next.end();)
            it = fold(it.key()) == key ? next.erase(it) : std::next(it);
    user_["blocked"] = json(std::vector<std::string>(blocked_.begin(), blocked_.end()));
    schedule_save();
}

Model &model_for(std::string lang) {
    if (lang.empty())
        lang = active_language();
    auto it = g_models.find(lang);
    if (it == g_models.end())
        it = g_models.emplace(lang, std::make_unique<Model>(lang)).first;
    return *it->second;
}

}  // namespace

std::string active_language() {
    if (g_active.empty())
        g_active = setting_string("active-language", "en_US");
    return g_active;
}

void set_active_language(const std::string &code) {
    g_active = code;
    if (settings())
        g_settings_set_string(settings(), "active-language", code.c_str());
}

std::vector<std::string> suggest(const std::string &context, const std::string &lang, unsigned max) {
    return model_for(lang).suggest(context, std::clamp(max, 1u, 20u));
}

void learn(const std::string &text, const std::string &lang) {
    model_for(lang).learn(text);
}

std::vector<std::string> swipe(const std::string &context, const std::string &lang,
                               const std::map<gunichar, Point> &keys, const std::vector<Point> &path,
                               unsigned max) {
    return model_for(lang).swipe(context, keys, path, std::clamp(max, 1u, 20u));
}

void reload(const std::string &lang) {
    g_models.erase(lang);
}

void init() {
    auto &svc = Service::get();
    svc.on("Suggest", [](GVariant *params, GDBusMethodInvocation *inv) {
        const gchar *context, *lang;
        guint32 max;
        g_variant_get(params, "(&s&su)", &context, &lang, &max);
        std::vector<std::string> words;
        if (setting_bool("suggestions-enabled", true))
            words = suggest(context, lang, max ? max : 3);
        GVariantBuilder b;
        g_variant_builder_init(&b, G_VARIANT_TYPE("as"));
        for (const auto &w : words)
            g_variant_builder_add(&b, "s", w.c_str());
        g_dbus_method_invocation_return_value(inv, g_variant_new("(as)", &b));
    });
    svc.on("SwipeWords", [](GVariant *params, GDBusMethodInvocation *inv) {
        const gchar *context, *lang, *keys_json, *path_json;
        guint32 max;
        g_variant_get(params, "(&s&s&s&su)", &context, &lang, &keys_json, &path_json, &max);
        std::map<gunichar, Point> keys;
        std::vector<Point> path;
        try {
            json keys_in = json::parse(keys_json), path_in = json::parse(path_json);
            for (auto &[k, v] : keys_in.items())
                keys[g_unichar_tolower(g_utf8_get_char(k.c_str()))] = {v.at(0).get<double>(), v.at(1).get<double>()};
            for (auto &p : path_in)
                path.push_back({p.at(0).get<double>(), p.at(1).get<double>()});
        } catch (const std::exception &e) {
            g_dbus_method_invocation_return_error(inv, G_DBUS_ERROR, G_DBUS_ERROR_INVALID_ARGS,
                                                  "bad swipe data: %s", e.what());
            return;
        }
        auto words = swipe(context, lang, keys, path, max ? max : 4);
        GVariantBuilder b;
        g_variant_builder_init(&b, G_VARIANT_TYPE("as"));
        for (const auto &w : words)
            g_variant_builder_add(&b, "s", w.c_str());
        g_dbus_method_invocation_return_value(inv, g_variant_new("(as)", &b));
    });
    svc.on("LearnText", [](GVariant *params, GDBusMethodInvocation *inv) {
        const gchar *text, *lang;
        g_variant_get(params, "(&s&s)", &text, &lang);
        learn(text, lang);
        reply_empty(inv);
    });
    svc.on("ForgetWord", [](GVariant *params, GDBusMethodInvocation *inv) {
        const gchar *word;
        g_variant_get(params, "(&s)", &word);
        model_for("").forget(word);
        reply_empty(inv);
    });
}

}  // namespace nkb::predict
