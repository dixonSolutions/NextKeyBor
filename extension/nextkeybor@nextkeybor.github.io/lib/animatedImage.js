// An actor that plays an animated GIF/WebP (anything GdkPixbuf can load as an
// animation) from a local file. Only animates while mapped, and only a
// limited number play at once to keep the shell responsive.

import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

const MAX_PLAYING = 24;
const MIN_FRAME_MS = 40;
let playing = 0;

export const AnimatedImage = GObject.registerClass(
class AnimatedImage extends St.Widget {
    _init(params = {}) {
        const {height = 96, ...rest} = params;
        super._init({
            style_class: 'nkb-media-image',
            height,
            width: height,
            ...rest,
        });
        this._targetHeight = height;
        this._iter = null;
        this._timeoutId = 0;
        this._playing = false;
        this._cancellable = null;
        this._path = null;
        this.connect('notify::mapped', () => this._syncPlayback());
        this.connect('destroy', () => this._teardown());
    }

    setFile(path) {
        if (!path || path === this._path)
            return;
        this._path = path;
        this._teardown();
        this._cancellable = new Gio.Cancellable();
        const file = Gio.File.new_for_path(path);
        file.read_async(GLib.PRIORITY_DEFAULT, this._cancellable, (f, res) => {
            let stream;
            try {
                stream = f.read_finish(res);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.warn(`NextKeyBor: cannot read ${path}: ${e.message}`);
                return;
            }
            GdkPixbuf.PixbufAnimation.new_from_stream_async(stream, this._cancellable, (_s, res2) => {
                try {
                    const anim = GdkPixbuf.PixbufAnimation.new_from_stream_finish(res2);
                    this._setAnimation(anim);
                } catch (e) {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`NextKeyBor: cannot decode ${path}: ${e.message}`);
                }
                stream.close_async(GLib.PRIORITY_DEFAULT, null, null);
            });
        });
    }

    _setAnimation(anim) {
        const w = anim.get_width();
        const h = anim.get_height();
        if (w <= 0 || h <= 0)
            return;
        this.width = Math.round(this._targetHeight * w / h);
        this._content = St.ImageContent.new_with_preferred_size(w, h);
        this.set_content(this._content);
        this._static = anim.is_static_image();
        this._iter = anim.get_iter(null);
        this._showFrame();
        this._syncPlayback();
    }

    _showFrame() {
        const pixbuf = this._iter?.get_pixbuf();
        if (!pixbuf || !this._content)
            return;
        const coglContext = global.stage.context.get_backend().get_cogl_context();
        try {
            this._content.set_bytes(coglContext, pixbuf.read_pixel_bytes(),
                pixbuf.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
                pixbuf.get_width(), pixbuf.get_height(), pixbuf.get_rowstride());
        } catch (e) {
            console.warn(`NextKeyBor: frame upload failed: ${e.message}`);
        }
    }

    _syncPlayback() {
        const shouldPlay = this.mapped && this._iter && !this._static;
        if (shouldPlay && !this._playing && playing < MAX_PLAYING) {
            this._playing = true;
            playing++;
            this._scheduleNext();
        } else if (!shouldPlay && this._playing) {
            this._stop();
        }
    }

    _scheduleNext() {
        const delay = this._iter.get_delay_time();
        if (delay < 0) {
            this._stop();
            return;
        }
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_LOW, Math.max(delay, MIN_FRAME_MS), () => {
            this._timeoutId = 0;
            if (!this._iter)
                return GLib.SOURCE_REMOVE;
            this._iter.advance(null);
            this._showFrame();
            this._scheduleNext();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stop() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._playing) {
            this._playing = false;
            playing--;
        }
    }

    _teardown() {
        this._cancellable?.cancel();
        this._cancellable = null;
        this._stop();
        this._iter = null;
    }
});
