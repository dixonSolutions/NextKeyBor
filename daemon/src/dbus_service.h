// Owns the io.github.nextkeybor.Daemon bus name and dispatches method calls.
#pragma once

#include <functional>
#include <map>
#include <string>

#include <gio/gio.h>

namespace nkb {

constexpr const char *kBusName = "io.github.nextkeybor.Daemon";
constexpr const char *kObjectPath = "/io/github/nextkeybor/Daemon";
constexpr const char *kInterface = "io.github.nextkeybor.Daemon";

class Service {
public:
    // Handlers must reply to the invocation exactly once (possibly later).
    using Handler = std::function<void(GVariant *params, GDBusMethodInvocation *inv)>;

    static Service &get();

    void on(const std::string &method, Handler h) { handlers_[method] = std::move(h); }
    // Takes ownership of a floating params variant. Safe from the main thread only.
    void emit(const char *signal, GVariant *params);

    // Returns false if the name could not be owned (another daemon runs without --replace).
    void start(bool replace, std::function<void(bool ok)> on_ready);

private:
    static void on_call(GDBusConnection *, const gchar *, const gchar *, const gchar *,
                        const gchar *method, GVariant *params, GDBusMethodInvocation *inv,
                        gpointer self);

    std::map<std::string, Handler> handlers_;
    GDBusConnection *conn_ = nullptr;
    GDBusNodeInfo *node_ = nullptr;
    std::function<void(bool)> on_ready_;
};

// Reply helpers.
void reply_string(GDBusMethodInvocation *inv, const std::string &s);
void reply_empty(GDBusMethodInvocation *inv);
void reply_error(GDBusMethodInvocation *inv, const std::string &message);

}  // namespace nkb
