package com.pulse.remote;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;

/**
 * A minimal, dependency-free content provider for one purpose: handing a file to
 * the camera and getting a readable URI back.
 *
 * ## Why this exists
 *
 * Since Android 7 a `file://` URI handed to another app throws
 * `FileUriExposedException`, so the camera must be given a `content://` URI. The
 * usual answer is `androidx.core.content.FileProvider` — but this app is built
 * without Gradle and therefore without AndroidX, and pulling in a dependency
 * graph to serve one directory is exactly what the build avoids.
 *
 * So this provider does the whole job in one small class: it serves files from a
 * single directory under the app's cache, and it refuses anything that resolves
 * outside that directory. The containment check is the part that matters — a
 * provider that will open any path handed to it is a way to read every file the
 * app can read.
 *
 * Nothing here is exported: the provider is usable only through an explicit
 * per-URI grant, which is how the camera gets write access to exactly one file.
 */
public class FileBridge extends ContentProvider {

    /** Authority declared in the manifest. */
    public static final String AUTHORITY = "com.pulse.remote.files";

    /** Every served file lives here; nothing outside it is reachable. */
    private static final String DIRECTORY = "shared";

    /** @return the directory files are served from, created if needed. */
    static File sharedDirectory(android.content.Context context) {
        File directory = new File(context.getCacheDir(), DIRECTORY);
        if (!directory.exists()) directory.mkdirs();
        return directory;
    }

    /**
     * Build the URI for a file in the shared directory.
     * @param context any context.
     * @param name the file name (no separators).
     * @return the content URI.
     */
    static Uri uriFor(android.content.Context context, String name) {
        sharedDirectory(context);
        return new Uri.Builder().scheme("content").authority(AUTHORITY).appendPath(name).build();
    }

    /**
     * Resolve a URI to a file inside the shared directory, or null.
     * @param uri the incoming URI.
     * @return the file, or null when it escapes the directory.
     */
    private File resolve(Uri uri) {
        String name = uri.getLastPathSegment();
        if (name == null || name.isEmpty()) return null;
        // A path segment cannot contain a separator, but the check is cheap and
        // this is the one place a mistake would expose the app's whole storage.
        if (name.contains("/") || name.contains("\\") || name.contains("..")) return null;
        File directory = sharedDirectory(getContext());
        File candidate = new File(directory, name);
        try {
            if (!candidate.getCanonicalPath().startsWith(directory.getCanonicalPath() + File.separator)) {
                return null;
            }
        } catch (IOException error) {
            return null;
        }
        return candidate;
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File file = resolve(uri);
        if (file == null) throw new FileNotFoundException("outside the shared directory: " + uri);
        int flags = mode != null && mode.contains("w")
                ? ParcelFileDescriptor.MODE_CREATE | ParcelFileDescriptor.MODE_READ_WRITE | ParcelFileDescriptor.MODE_TRUNCATE
                : ParcelFileDescriptor.MODE_READ_ONLY;
        return ParcelFileDescriptor.open(file, flags);
    }

    @Override
    public String getType(Uri uri) {
        File file = resolve(uri);
        if (file == null) return null;
        String name = file.getName();
        int dot = name.lastIndexOf('.');
        if (dot < 0 || dot == name.length() - 1) return "application/octet-stream";
        String type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase());
        return type == null ? "application/octet-stream" : type;
    }

    /**
     * Report the columns a consumer needs to show a file name and size.
     *
     * The WebView asks for these when it turns the URI into a File; omitting them
     * yields an attachment with no name, which the official client then displays
     * as an unlabelled blob.
     */
    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        File file = resolve(uri);
        if (file == null || !file.exists()) return null;
        String[] columns = projection != null ? projection
                : new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE };
        MatrixCursor cursor = new MatrixCursor(columns, 1);
        Object[] row = new Object[columns.length];
        for (int index = 0; index < columns.length; index += 1) {
            if (OpenableColumns.DISPLAY_NAME.equals(columns[index])) row[index] = file.getName();
            else if (OpenableColumns.SIZE.equals(columns[index])) row[index] = file.length();
            else row[index] = null;
        }
        cursor.addRow(row);
        return cursor;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException("read-only provider");
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("read-only provider");
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("read-only provider");
    }
}
