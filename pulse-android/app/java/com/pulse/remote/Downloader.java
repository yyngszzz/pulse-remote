package com.pulse.remote;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Log;
import android.webkit.CookieManager;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;

/**
 * Save a file the page asked for into the phone's Downloads.
 *
 * ## Why this exists at all
 *
 * A WebView has no download manager. A page that navigates to an attachment, or
 * clicks a link carrying the download attribute, produces nothing at all unless
 * the app installs a DownloadListener — which is exactly what "I can look at the
 * file but I cannot download it" looks like from the phone.
 *
 * ## Why the bytes are fetched here instead of by the system downloader
 *
 * android.app.DownloadManager would be less code, but it runs in the system's
 * download-provider process and therefore knows nothing about this app's
 * network-security-config. This deployment's server presents a self-signed
 * certificate that only this app trusts, so the system downloader would fail the
 * TLS handshake on every file. Fetching in-process inherits both the bundled
 * trust anchor and, just as importantly, the WebView's session cookie — the
 * artifact routes answer 404 to an unauthenticated caller.
 *
 * @module pulse-android/Downloader
 */
final class Downloader {

    private static final String TAG = "PulseDownload";

    /** Guards against a page handing us something absurd as a filename. */
    private static final int MAX_NAME_LENGTH = 120;

    private Downloader() {}

    /**
     * Whether a URL points at an image the phone should open in its own viewer.
     *
     * The official file route answers with the raw bytes and no
     * Content-Disposition, so a browser shows it as a top-level image document —
     * and how such a document is fitted or zoomed is the browser's business, not
     * something a page's CSS can influence. On a phone that meant a screenshot
     * arrived wider than the screen and, with zoom previously disabled, stuck that
     * way. Handing the bytes to the system viewer instead gives fitting,
     * pinching, panning and sharing for free.
     *
     * @param url the navigated URL.
     * @return true when it names an image file.
     */
    static boolean looksLikeImage(String url) {
        if (url == null) return false;
        String path = url;
        int query = path.indexOf('?');
        if (query != -1) path = path.substring(0, query);
        int fragment = path.indexOf('#');
        if (fragment != -1) path = path.substring(0, fragment);
        String lower = path.toLowerCase();
        return lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg")
                || lower.endsWith(".gif") || lower.endsWith(".webp") || lower.endsWith(".avif")
                || lower.endsWith(".bmp")
                // The file route carries the real name in a query parameter, so the
                // path alone is not enough to decide.
                || lower.contains(".png") || lower.contains(".jpg") || lower.contains(".jpeg");
    }

    /**
     * Fetch an image into the shared cache and hand it to the system viewer.
     *
     * @param context the hosting activity.
     * @param url the image URL.
     */
    static void showExternally(Context context, String url) {
        final Context app = context.getApplicationContext();
        new Thread(() -> {
            File file = fetchToCache(app, url);
            if (file == null) {
                report(app, "这张图片取不下来");
                return;
            }
            Uri uri = FileBridge.uriFor(app, file.getName());
            Intent view = new Intent(Intent.ACTION_VIEW);
            view.setDataAndType(uri, Mime.of(file.getName()));
            // The provider is not exported, so this flag is the only thing that
            // lets the viewer read the file.
            view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                app.startActivity(view);
            } catch (Exception error) {
                Log.w(TAG, "no viewer for " + uri + ": " + error);
                report(app, "手机里没有能打开这张图片的应用");
            }
        }, "pulse-open").start();
    }

    /**
     * Fetch a URL into the provider's shared directory.
     *
     * @param context application context.
     * @param url what to fetch.
     * @return the file, or null when it could not be fetched.
     */
    private static File fetchToCache(Context context, String url) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null && !cookie.isEmpty()) connection.setRequestProperty("Cookie", cookie);
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(60_000);
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) return null;

            File directory = FileBridge.sharedDirectory(context);
            if (directory == null) return null;
            File file = unique(directory, filenameFor(url, connection.getHeaderField("Content-Disposition")));
            try (InputStream input = connection.getInputStream();
                 OutputStream output = new FileOutputStream(file)) {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = input.read(buffer)) > 0) output.write(buffer, 0, read);
            }
            return file;
        } catch (Exception error) {
            Log.w(TAG, "could not fetch " + url + ": " + error);
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /**
     * Hand a file to the system share sheet.
     *
     * This, not saving to disk, is what a phone is actually for: "send it to
     * WeChat or QQ" is one tap from the share sheet and four more from a Downloads
     * folder the user then has to go and find. Saving stays available because a
     * desktop browser has nowhere else to put a file — but the share sheet is the
     * phone's answer, so it is offered first there.
     *
     * @param context the hosting activity.
     * @param url the file URL.
     * @param mimeHint the type to advertise, or null to infer from the name.
     */
    static void shareExternally(Context context, String url, String mimeHint) {
        final Context app = context.getApplicationContext();
        new Thread(() -> {
            File file = fetchToCache(app, url);
            if (file == null) {
                report(app, "这个文件取不下来");
                return;
            }
            Uri uri = FileBridge.uriFor(app, file.getName());
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType(mimeHint == null || mimeHint.isEmpty() ? Mime.of(file.getName()) : mimeHint);
            send.putExtra(Intent.EXTRA_STREAM, uri);
            // The grant only travels with the URI if the URI is also in the clip
            // data. EXTRA_STREAM alone is not enough: the flag applies to getData()
            // and getClipData(), and a receiver that reads the extra — which is what
            // QQ and WeChat do — is handed a URI it has no permission for and shows
            // "load failed" on the attachment. Sharing to a device on the same
            // account worked, because that path never left the sending app.
            send.setClipData(ClipData.newUri(app.getContentResolver(), file.getName(), uri));
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, "转发到");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            try {
                app.startActivity(chooser);
            } catch (Exception error) {
                Log.w(TAG, "no share target for " + uri + ": " + error);
                report(app, "手机里没有可以转发的应用");
            }
        }, "pulse-share").start();
    }

    /**
     * Fetch a URL and write it into Downloads, off the main thread.
     *
     * @param context the hosting activity.
     * @param url the URL the page asked to download.
     * @param contentDisposition the header the page supplied, if any.
     * @param mimeType the type the page supplied, if any.
     */
    static void save(Context context, String url, String contentDisposition, String mimeType) {
        final Context app = context.getApplicationContext();
        new Thread(() -> fetch(app, url, contentDisposition, mimeType), "pulse-download").start();
    }

    /**
     * The actual transfer: request, stream to disk, report.
     *
     * @param context application context.
     * @param url the URL to fetch.
     * @param contentDisposition the header the page supplied.
     * @param mimeType the type the page supplied.
     */
    private static void fetch(Context context, String url, String contentDisposition, String mimeType) {
        String name = filenameFor(url, contentDisposition);
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            // The page's own session, which the WebView holds and this thread does
            // not: without it every artifact answers 404 and the download "fails"
            // for no visible reason.
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null && !cookie.isEmpty()) {
                connection.setRequestProperty("Cookie", cookie);
            }
            connection.setInstanceFollowRedirects(true);
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(120_000);

            int status = connection.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) {
                report(context, "下载失败：服务器返回 " + status);
                return;
            }
            String type = mimeType == null || mimeType.isEmpty() ? connection.getContentType() : mimeType;
            if (type == null || type.isEmpty()) type = "application/octet-stream";

            Target target = create(context, name, type);
            if (target == null) {
                report(context, "下载失败：写不进下载目录");
                return;
            }

            long written = 0;
            try (InputStream input = connection.getInputStream()) {
                OutputStream output = target.open();
                if (output == null) throw new IOException("no output stream for " + target.uri);
                try (OutputStream sink = output) {
                    byte[] buffer = new byte[64 * 1024];
                    int read;
                    while ((read = input.read(buffer)) > 0) {
                        sink.write(buffer, 0, read);
                        written += read;
                    }
                }
            }
            target.finish();
            Log.i(TAG, "saved " + name + " (" + written + " bytes)");
            report(context, target.publicLabel + "：" + name);
        } catch (Exception error) {
            Log.w(TAG, "download failed for " + url + ": " + error);
            report(context, "下载失败：" + error.getClass().getSimpleName());
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /**
     * One pending destination, so the two storage APIs can share the copy loop.
     */
    private static final class Target {
        final Uri uri;
        final String publicLabel;
        private final ContentResolver resolver;
        private final File file;
        private final boolean pending;

        /**
         * @param uri where to write.
         * @param publicLabel what to tell the user about the location.
         * @param resolver resolver for the pending flag, or null.
         * @param file the plain file, or null for the MediaStore path.
         * @param pending whether the row needs its pending flag cleared.
         */
        Target(Uri uri, String publicLabel, ContentResolver resolver, File file, boolean pending) {
            this.uri = uri;
            this.publicLabel = publicLabel;
            this.resolver = resolver;
            this.file = file;
            this.pending = pending;
        }

        /** @return the stream to write into. @throws IOException if it cannot open. */
        OutputStream open() throws IOException {
            if (file != null) return new FileOutputStream(file);
            OutputStream stream = resolver.openOutputStream(uri);
            if (stream == null) throw new IOException("no stream");
            return stream;
        }

        /** Publish the entry, so it is visible to other apps only once complete. */
        void finish() {
            if (!pending || resolver == null) return;
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.IS_PENDING, 0);
            resolver.update(uri, values, null, null);
        }
    }

    /**
     * Create the destination for a download.
     *
     * On API 29 and up this is a MediaStore row in the real Downloads collection,
     * which needs no permission and lands where the user expects. Below that the
     * public Downloads directory needs WRITE_EXTERNAL_STORAGE, and this app asks
     * for no storage permission at all, so the file goes to the app's own
     * external directory instead and the message says so rather than pretending.
     *
     * @param context application context.
     * @param name the file name to use.
     * @param mimeType the content type.
     * @return the destination, or null if it could not be created.
     */
    private static Target create(Context context, String name, String mimeType) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, name);
            values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
            // Written as pending so a half-copied file never shows up in the Files
            // app as if it were complete.
            values.put(MediaStore.Downloads.IS_PENDING, 1);
            ContentResolver resolver = context.getContentResolver();
            Uri collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
            Uri item = resolver.insert(collection, values);
            if (item == null) return null;
            return new Target(item, "已保存到「下载」", resolver, null, true);
        }

        File directory = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (directory == null) return null;
        if (!directory.exists() && !directory.mkdirs()) return null;
        File file = unique(directory, name);
        return new Target(Uri.fromFile(file), "已保存到 App 的下载目录", null, file, false);
    }

    /**
     * Pick a name that does not overwrite an earlier download.
     *
     * MediaStore renames collisions itself; a plain directory does not.
     *
     * @param directory where the file will live.
     * @param name the wanted name.
     * @return a file that does not exist yet.
     */
    private static File unique(File directory, String name) {
        File candidate = new File(directory, name);
        if (!candidate.exists()) return candidate;
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String suffix = dot > 0 ? name.substring(dot) : "";
        for (int index = 1; index < 1000; index += 1) {
            candidate = new File(directory, stem + "-" + index + suffix);
            if (!candidate.exists()) return candidate;
        }
        return candidate;
    }

    /**
     * Decide what to call the file.
     *
     * The URL is consulted first. This server builds the disposition header from a
     * path that is usually Chinese, and HTTP header values are latin-1, so the
     * header arrives mangled while the URL parameter is percent-encoded UTF-8 and
     * survives intact.
     *
     * @param url the downloaded URL.
     * @param contentDisposition the header, if the page supplied one.
     * @return a safe, non-empty file name.
     */
    private static String filenameFor(String url, String contentDisposition) {
        String fromUrl = queryBasename(url);
        if (fromUrl != null) return sanitize(fromUrl);
        String fromHeader = headerFilename(contentDisposition);
        if (fromHeader != null) return sanitize(fromHeader);
        String fromPath = basename(url);
        if (fromPath != null && !fromPath.isEmpty()) return sanitize(fromPath);
        return "pulse-download";
    }

    /**
     * @param url a URL.
     * @return the decoded base name of its path parameter, or null.
     */
    private static String queryBasename(String url) {
        int at = url.indexOf("path=");
        if (at == -1) return null;
        String value = url.substring(at + "path=".length());
        int end = value.indexOf('&');
        if (end != -1) value = value.substring(0, end);
        try {
            String decoded = URLDecoder.decode(value, "UTF-8");
            String name = basename(decoded);
            return name == null || name.isEmpty() ? null : name;
        } catch (Exception error) {
            return null;
        }
    }

    /**
     * @param contentDisposition the header value, possibly null.
     * @return the filename it declares, or null.
     */
    private static String headerFilename(String contentDisposition) {
        if (contentDisposition == null) return null;
        String lower = contentDisposition.toLowerCase();
        int at = lower.indexOf("filename=");
        if (at == -1) return null;
        String value = contentDisposition.substring(at + "filename=".length()).trim();
        int semicolon = value.indexOf(';');
        if (semicolon != -1) value = value.substring(0, semicolon);
        value = value.trim();
        if (value.length() >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
            value = value.substring(1, value.length() - 1);
        }
        return value.isEmpty() ? null : value;
    }

    /**
     * @param value a path or URL.
     * @return everything after the last slash or backslash.
     */
    private static String basename(String value) {
        int slash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
        return slash == -1 ? value : value.substring(slash + 1);
    }

    /**
     * Make a name that is safe to write and to show.
     *
     * @param name the wanted name.
     * @return a name with no separators, control characters or traversal.
     */
    private static String sanitize(String name) {
        StringBuilder clean = new StringBuilder(name.length());
        for (int index = 0; index < name.length() && clean.length() < MAX_NAME_LENGTH; index += 1) {
            char character = name.charAt(index);
            boolean control = character < 0x20 || character == 0x7f;
            boolean separator = character == '/' || character == '\\' || character == ':';
            if (control || separator) continue;
            clean.append(character);
        }
        String result = clean.toString().trim();
        if (result.isEmpty() || result.equals(".") || result.equals("..")) return "pulse-download";
        return result;
    }

    /**
     * Say what happened, on the main thread.
     *
     * @param context application context.
     * @param message what to show.
     */
    private static void report(Context context, String message) {
        new Handler(Looper.getMainLooper()).post(
                () -> Toast.makeText(context, message, Toast.LENGTH_LONG).show());
    }
}
