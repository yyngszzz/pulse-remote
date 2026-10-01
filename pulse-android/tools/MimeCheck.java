import com.pulse.remote.Mime;

/**
 * Execute the app's MIME table under a plain JVM.
 *
 *   powershell -ExecutionPolicy Bypass -File tools/check-mime.ps1
 *
 * ## Why this exists
 *
 * The share sheet believes what it is told. The table used to fall back to `image/*`
 * for every extension it did not recognise, so forwarding a `.md`, a `.zip` or an
 * `.apk` handed WeChat a URI declared as an image: it tried to decode the bytes,
 * failed, and showed 发送失败 — the same message the real permission bug produced, from
 * a completely different cause.
 *
 * The property that matters is negative and therefore easy to lose again: **no
 * non-image file may be announced as an image**. It is asserted here over every
 * extension the table knows plus a sweep of unknown ones, on a plain JVM, in a
 * millisecond.
 */
public final class MimeCheck {

    private static int checks = 0;
    private static int failures = 0;
    /** How many distinct types the table produced; see the guard at the end. */
    private static int distinct = 0;

    private MimeCheck() {
    }

    /**
     * Run every case.
     * @param args ignored.
     */
    public static void main(String[] args) {
        System.out.println("MIME 表检查（Mime.of）");

        // The named extensions people actually forward.
        expect("shot.png", "image/png");
        expect("shot.PNG", "image/png");
        expect("photo.jpeg", "image/jpeg");
        expect("anim.gif", "image/gif");
        expect("mobile-shell.md", "text/markdown");
        expect("notes.txt", "text/plain");
        expect("data.json", "application/json");
        expect("table.csv", "text/csv");
        expect("pulse-remote.apk", "application/vnd.android.package-archive");
        expect("bundle.zip", "application/zip");
        expect("report.pdf", "application/pdf");
        expect("clip.mp4", "video/mp4");
        expect("voice.m4a", "audio/mp4");
        expect("archive.tar.gz", "application/gzip");
        expect("script.ps1", "text/plain");
        expect("ui.js", "text/plain");

        // The regression itself, named: these are the ones that used to arrive as
        // image/* and made the receiving app fail.
        for (String name : new String[] {"pulse-remote.apk", "lib.zip", "README.md", "notes.txt",
            "data.json", "noidea.qqq", "file", "trailing."}) {
            checks += 1;
            String type = Mime.of(name);
            if (type == null || type.isEmpty()) {
                System.out.println("FAIL " + name + "：类型为空");
                failures += 1;
            } else if (type.startsWith("image/")) {
                System.out.println("FAIL " + name + "：非图片文件被声明成 " + type
                    + "（这正是让微信/QQ 报「发送失败」的那个 bug）");
                failures += 1;
            } else {
                count(type);
                System.out.println("PASS " + name + " → " + type + "（没有被谎报成图片）");
            }
        }

        // Whatever the table does not know must be handed over as an opaque file, and
        // never as an image.
        expect("mystery.qqq", Mime.UNKNOWN);
        expect("noextension", Mime.UNKNOWN);
        expect("trailing.", Mime.UNKNOWN);
        expect("", Mime.UNKNOWN);
        expect(null, Mime.UNKNOWN);
        expect("D:\\deepseek harness\\pulse-android\\dist\\pulse-remote.apk",
            "application/vnd.android.package-archive");

        System.out.println();
        if (distinct < 8) {
            System.out.println("FAIL 整张表只产出了 " + distinct + " 种类型：这说明它退化成了"
                + "「一律 octet-stream」，图片也会被当普通文件发出去");
            failures += 1;
        } else {
            System.out.println("PASS 全表产出 " + distinct + " 种类型（没有退化成单一兜底）");
        }
        System.out.println("共 " + checks + " 项检查，失败 " + failures + " 项");
        if (failures > 0) System.exit(1);
    }

    /**
     * Compare one name against the expected type.
     * @param filename the file name.
     * @param expected the type it must produce.
     */
    private static void expect(String filename, String expected) {
        checks += 1;
        String actual = Mime.of(filename);
        if (actual == null || !actual.equals(expected)) {
            System.out.println("FAIL " + (filename == null ? "(null)" : filename)
                + "：期望 " + expected + "，实际 " + actual);
            failures += 1;
            return;
        }
        count(actual);
        System.out.println("PASS " + (filename == null ? "(null)" : filename) + " → " + actual);
    }

    /** Distinct types produced so far; a list rather than a Set to stay dependency-free. */
    private static final java.util.List<String> SEEN = new java.util.ArrayList<>();

    /**
     * Count a type the first time it is produced.
     * @param type the type.
     */
    private static void count(String type) {
        if (!SEEN.contains(type)) SEEN.add(type);
        distinct = SEEN.size();
    }
}
