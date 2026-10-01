package com.pulse.remote;

/**
 * The content type to advertise for a file name.
 *
 * ## Why this is a class and not a one-liner
 *
 * The share sheet is told what it is being handed, and the receiving app believes it.
 * The first version of this fell back to `image/*` for anything it did not recognise,
 * which is worse than useless: WeChat and QQ take the URI as an image, try to decode
 * it, fail, and report 发送失败 for a `.md`, a `.zip` or an `.apk`. That looks exactly
 * like a permission problem — which is what the real permission bug looked like too —
 * so it costs an hour of chasing the wrong thing.
 *
 * Unknown extensions therefore fall back to `application/octet-stream`, which every
 * receiver reads as "some file", and the file name carries the rest.
 *
 * Pure on purpose: `tools/check-mime.ps1` runs this on a plain JVM, where "no
 * non-image extension is ever announced as an image" is a line of code instead of a
 * hope.
 */
public final class Mime {

    /** What to announce when nothing is known about the extension. */
    public static final String UNKNOWN = "application/octet-stream";

    private Mime() {
    }

    /**
     * The type to advertise for a file.
     *
     * @param filename the file's name; null, empty and extensionless names are safe.
     * @return a MIME type, never null or empty.
     */
    public static String of(String filename) {
        String extension = extensionOf(filename);
        if (extension.isEmpty()) return UNKNOWN;
        switch (extension) {
            // Images. Anything here is genuinely decodable as an image; nothing else
            // in this method is allowed to claim image/*.
            case "png": return "image/png";
            case "jpg": case "jpeg": case "jpe": return "image/jpeg";
            case "gif": return "image/gif";
            case "webp": return "image/webp";
            case "avif": return "image/avif";
            case "bmp": return "image/bmp";
            case "heic": case "heif": return "image/heic";
            case "svg": return "image/svg+xml";
            case "ico": return "image/x-icon";

            case "mp4": case "m4v": return "video/mp4";
            case "mov": return "video/quicktime";
            case "webm": return "video/webm";
            case "mkv": return "video/x-matroska";
            case "avi": return "video/x-msvideo";
            case "3gp": return "video/3gpp";

            case "mp3": return "audio/mpeg";
            case "m4a": return "audio/mp4";
            case "aac": return "audio/aac";
            case "wav": return "audio/wav";
            case "ogg": case "opus": return "audio/ogg";
            case "flac": return "audio/flac";
            case "amr": return "audio/amr";

            case "pdf": return "application/pdf";
            case "zip": return "application/zip";
            case "rar": return "application/vnd.rar";
            case "7z": return "application/x-7z-compressed";
            case "tar": return "application/x-tar";
            case "gz": return "application/gzip";
            case "apk": return "application/vnd.android.package-archive";
            case "doc": return "application/msword";
            case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            case "xls": return "application/vnd.ms-excel";
            case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
            case "ppt": return "application/vnd.ms-powerpoint";
            case "pptx": return "application/vnd.openxmlformats-officedocument.presentationml.presentation";

            // Text. `text/plain` rather than a precise type for source files: a
            // receiver that does not know `text/markdown` shows nothing at all, while
            // every one of them shows plain text.
            case "md": case "markdown": return "text/markdown";
            case "json": return "application/json";
            case "csv": return "text/csv";
            case "html": case "htm": return "text/html";
            case "xml": return "text/xml";
            case "js": case "mjs": case "cjs": case "ts": case "tsx": case "jsx":
            case "css": case "scss": case "yaml": case "yml": case "toml": case "ini":
            case "txt": case "log": case "sh": case "bash": case "ps1": case "bat":
            case "cmd": case "py": case "rb": case "go": case "rs": case "java":
            case "c": case "h": case "cpp": case "hpp": case "sql":
                return "text/plain";

            default: return UNKNOWN;
        }
    }

    /**
     * The lowercased extension, without the dot.
     *
     * @param filename the file's name.
     * @return the extension, or an empty string.
     */
    public static String extensionOf(String filename) {
        if (filename == null) return "";
        String name = filename.trim();
        // A path is not a name, but callers hand over both, so only the last segment
        // is examined.
        int slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
        if (slash != -1) name = name.substring(slash + 1);
        int dot = name.lastIndexOf('.');
        if (dot <= 0 || dot == name.length() - 1) return "";
        return name.substring(dot + 1).toLowerCase();
    }
}
