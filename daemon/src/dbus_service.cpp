#include "dbus_service.h"

extern const char nkb_iface_xml[];

namespace nkb {

Service &Service::get() {
    static Service s;
    return s;
}

void Service::on_call(GDBusConnection *, const gchar *, const gchar *, const gchar *,
                      const gchar *method, GVariant *params, GDBusMethodInvocation *inv,
                      gpointer self) {
    auto *svc = static_cast<Service *>(self);
    auto it = svc->handlers_.find(method);
    if (it == svc->handlers_.end()) {
        g_dbus_method_invocation_return_error(inv, G_DBUS_ERROR, G_DBUS_ERROR_UNKNOWN_METHOD,
                                              "Method %s is not implemented", method);
        return;
    }
    try {
        it->second(params, inv);
    } catch (const std::exception &e) {
        reply_error(inv, e.what());
    }
}

void Service::emit(const char *signal, GVariant *params) {
    if (!conn_) {
        g_variant_unref(g_variant_ref_sink(params));
        return;
    }
    GError *err = nullptr;
    if (!g_dbus_connection_emit_signal(conn_, nullptr, kObjectPath, kInterface, signal, params,
                                       &err)) {
        g_warning("emitting %s failed: %s", signal, err->message);
        g_error_free(err);
    }
}

void Service::start(bool replace, std::function<void(bool)> on_ready) {
    on_ready_ = std::move(on_ready);
    GError *err = nullptr;
    node_ = g_dbus_node_info_new_for_xml(nkb_iface_xml, &err);
    if (!node_)
        g_error("bad interface XML: %s", err->message);

    auto flags = static_cast<GBusNameOwnerFlags>(
        G_BUS_NAME_OWNER_FLAGS_ALLOW_REPLACEMENT |
        (replace ? G_BUS_NAME_OWNER_FLAGS_REPLACE : G_BUS_NAME_OWNER_FLAGS_NONE));

    g_bus_own_name(
        G_BUS_TYPE_SESSION, kBusName, flags,
        [](GDBusConnection *conn, const gchar *, gpointer self) {
            auto *svc = static_cast<Service *>(self);
            static const GDBusInterfaceVTable vtable = {Service::on_call, nullptr, nullptr, {}};
            GError *e = nullptr;
            if (!g_dbus_connection_register_object(conn, kObjectPath, svc->node_->interfaces[0],
                                                   &vtable, svc, nullptr, &e)) {
                g_warning("register_object failed: %s", e->message);
                g_error_free(e);
                return;
            }
            svc->conn_ = conn;
        },
        [](GDBusConnection *, const gchar *name, gpointer self) {
            g_message("owning %s", name);
            auto *svc = static_cast<Service *>(self);
            if (svc->on_ready_)
                svc->on_ready_(true);
        },
        [](GDBusConnection *, const gchar *name, gpointer self) {
            auto *svc = static_cast<Service *>(self);
            g_warning("lost or could not own %s", name);
            if (svc->on_ready_)
                svc->on_ready_(false);
        },
        this, nullptr);
}

void reply_string(GDBusMethodInvocation *inv, const std::string &s) {
    g_dbus_method_invocation_return_value(inv, g_variant_new("(s)", s.c_str()));
}

void reply_empty(GDBusMethodInvocation *inv) {
    g_dbus_method_invocation_return_value(inv, nullptr);
}

void reply_error(GDBusMethodInvocation *inv, const std::string &message) {
    g_dbus_method_invocation_return_dbus_error(inv, "io.github.nextkeybor.Error",
                                               message.c_str());
}

}  // namespace nkb
