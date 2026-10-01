package com.pulse.remote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;
import android.webkit.CookieManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

import javax.net.ssl.HttpsURLConnection;

/**
 * Keeps one long-lived connection to the user's own computer and turns what
 * arrives on it into notifications.
 *
 * ## Why a foreground service instead of push
 *
 * Android suspends background sockets within minutes of the screen turning off,
 * which is precisely when a notification matters. A foreground service is the
 * only sanctioned way to stay connected, and using one means this app needs **no
 * push service at all** - no Firebase account, no vendor push SDK, no third
 * party in the path. The trade is a permanent, low-priority notification and a
 * small amount of battery, plus a one-time battery-optimisation exemption on
 * ROMs that kill background apps aggressively.
 *
 * ## What it reads
 *
 * The same server-sent-events stream the console uses, authenticated by the same
 * session cookie the WebView obtained while pairing. No separate credential is
 * invented for the notification path, so revoking the device in Pulse stops the
 * notifications too.
 */
public class PulseService extends Service {

    private static final String TAG = "Pulse";
    private static final int NOTIFICATION_PERSISTENT = 1;
    private static final int NOTIFICATION_ALERT = 2;
    /**
     * The ongoing connection notification's channel.
     *
     * A new id rather than a change to the old one: an app may only lower a channel's
     * importance while the user has never touched it, and `stream` shipped as LOW, so
     * anyone who had opened the settings would have kept LOW for good.
     */
    private static final String CHANNEL_STREAM = "connection";
    /** The channel this replaced; deleted on start so it stops appearing in settings. */
    private static final String CHANNEL_STREAM_LEGACY = "stream";
    private static final String CHANNEL_ALERT = "alerts";

    /** How long to wait for the next byte before deciding the link is dead. */
    private static final int READ_TIMEOUT_MS = 75_000;

    /** Whether an Activity is currently on screen; notifications are noise then. */
    private static volatile boolean visible = false;

    private volatile boolean running = false;
    private Thread worker;

    /** True between a turn-start frame and its turn-end, mirrored into the shade. */
    private volatile boolean working = false;
    /** When the current turn started, so the notification can run a live clock. */
    private volatile long workingSince = 0L;

    /**
     * Session id → the workspace it belongs to, as seen in the frames.
     *
     * A notification that says "任务完成" without saying *which* project stops being
     * useful the moment two sessions are open. The frames carry it, and the decision
     * payload only carries a session id, so the mapping is kept here.
     */
    private final java.util.Map<String, String> projects = new java.util.concurrent.ConcurrentHashMap<>();

    /** What the ongoing notification currently says, so it is not re-posted unchanged. */
    private volatile String postedLine = null;

    /**
     * Whether the user has swept the background row away.
     *
     * Set when the row is found to be missing although it was posted, and cleared by any
     * update that carries news. See {@code updatePersistent}.
     */
    private volatile boolean backgroundDismissed = false;

    /** The Activity calls this so the service can skip notifications the user can already see. */
    static void setVisible(boolean isVisible) {
        visible = isVisible;
    }

    /** Start, or wake, the connection. Safe to call repeatedly. */
    static void start(Context context) {
        Intent intent = new Intent(context, PulseService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent);
        else context.startService(intent);
    }

    /**
     * Reconnect now, e.g. right after a page load has refreshed the cookie.
     * @param context any context.
     */
    static void wake(Context context) {
        start(context);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
        // Must be called promptly after startForegroundService, or the platform
        // kills the service.
        startForeground(NOTIFICATION_PERSISTENT, persistent(getString(R.string.service_title_connecting),
                getString(R.string.service_text_unpaired)));
        running = true;
        worker = new Thread(this::loop, "pulse-stream");
        worker.setDaemon(true);
        worker.start();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Sticky: if the system reclaims the process, the connection comes back
        // without the user having to open the app again.
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (worker != null) worker.interrupt();
        super.onDestroy();
    }

    // ---- the connection ------------------------------------------------------

    /**
     * Sleep, but wake up immediately when the service is being torn down.
     * @param ms how long to wait.
     * @throws InterruptedException when the service is stopping.
     */
    private void sleep(long ms) throws InterruptedException {
        Thread.sleep(ms);
        if (!running) throw new InterruptedException("stopping");
    }

    private void loop() {
        int attempt = 0;
        while (running) {
            try {
                String cookie = CookieManager.getInstance().getCookie(Config.BASE_URL);
                if (cookie == null || !cookie.contains("pulse_session=")) {
                    // Pairing happens in the WebView; until it does there is
                    // nothing to authenticate with, and saying so beats a
                    // silent, dead notification.
                    updatePersistent(getString(R.string.service_title_connecting),
                            getString(R.string.service_text_unpaired));
                    sleep(15_000);
                    continue;
                }
                attempt = 0;
                stream(cookie);
            } catch (InterruptedException stopped) {
                return;
            } catch (Exception error) {
                attempt += 1;
                Log.w(TAG, "stream ended: " + error);
            }
            if (!running) return;
            // The link dropped. This is a different state from "connected and idle", and it used
            // to borrow the idle wording — so a phone that could not reach the computer said
            // "当前没有任务", which reads as "everything is fine". It says what it is doing now.
            updatePersistent(getString(R.string.service_title_offline),
                    getString(R.string.service_text_offline));
            // Backoff, capped so a laptop that is simply off does not turn into
            // a wakeup storm.
            long delay = Math.min(60_000L, 2_000L * (1L << Math.min(attempt, 5)));
            try {
                sleep(delay);
            } catch (InterruptedException stopped) {
                return;
            }
        }
    }

    /**
     * Hold one SSE connection open, dispatching events until it drops.
     * @param cookie the session cookie.
     * @throws Exception when the connection fails or ends.
     */
    private void stream(String cookie) throws Exception {
        SharedPreferences prefs = getSharedPreferences(Config.PREFS, MODE_PRIVATE);
        long since = prefs.getLong(Config.PREF_SEQ, 0);

        HttpsURLConnection connection = (HttpsURLConnection) new URL(
                Config.BASE_URL + "/api/stream?since=" + since).openConnection();
        connection.setRequestMethod("GET");
        connection.setRequestProperty("Cookie", cookie);
        connection.setRequestProperty("Accept", "text/event-stream");
        connection.setRequestProperty("Cache-Control", "no-cache");
        connection.setConnectTimeout(20_000);
        // The server emits a heartbeat every 20s, so a longer silence than this
        // means the link is dead rather than idle.
        connection.setReadTimeout(READ_TIMEOUT_MS);

        int status = connection.getResponseCode();
        if (status != HttpURLConnection.HTTP_OK) {
            connection.disconnect();
            throw new IllegalStateException("stream HTTP " + status);
        }

        updatePersistent(getString(R.string.service_title), getString(R.string.service_text_live));
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), "UTF-8"))) {
            String event = null;
            StringBuilder data = new StringBuilder();
            String line;
            while (running && (line = reader.readLine()) != null) {
                if (line.isEmpty()) {
                    if (event != null) dispatch(event, data.toString());
                    event = null;
                    data.setLength(0);
                    continue;
                }
                if (line.startsWith(":")) continue; // heartbeat
                if (line.startsWith("event:")) {
                    event = line.substring(6).trim();
                } else if (line.startsWith("data:")) {
                    data.append(line.substring(5).trim());
                }
            }
        } finally {
            connection.disconnect();
        }
    }

    /**
     * Act on one server-sent event.
     * @param event the event name.
     * @param payload the JSON payload.
     */
    private void dispatch(String event, String payload) {
        try {
            if ("decisions".equals(event)) {
                JSONArray decisions = new JSONObject(payload).optJSONArray("decisions");
                if (decisions == null || decisions.length() == 0) return;
                JSONObject first = decisions.getJSONObject(0);
                String title = first.optString("title", getString(R.string.decision_title));
                String more = decisions.length() > 1 ? "（另有 " + (decisions.length() - 1) + " 项）" : "";
                // The decision payload carries a session id but not the workspace name,
                // while the frames carry both — so the project seen on this session's
                // frames is what names the notification. Without it the headline falls
                // back to the generic wording rather than to a wrong project.
                String project = projects.get(first.optString("sessionId", ""));
                // "哪个任务 + 要我做什么选择": the headline names the project, and the body is the
                // question followed by the options themselves, so the shade answers both without
                // opening the app. Without a project name the generic wording is used rather than
                // a wrong one.
                String headline = project == null || project.isEmpty()
                        ? getString(R.string.decision_title)
                        : getString(R.string.decision_headline, project);
                alert(headline, decisionBody(first, title, more), first.optString("id", null));
                return;
            }
            if ("frame".equals(event)) {
                JSONObject frame = new JSONObject(payload);
                long seq = frame.optLong("seq", 0);
                if (seq > 0) {
                    getSharedPreferences(Config.PREFS, MODE_PRIVATE).edit()
                            .putLong(Config.PREF_SEQ, seq).apply();
                }
                progress(frame);
            }
        } catch (Exception error) {
            Log.w(TAG, "could not handle " + event + ": " + error);
        }
    }

    /**
     * Mirror one distilled frame into the notification shade.
     *
     * The decision of *what* to show lives in {@link Notice}, which has no Android
     * dependencies and is therefore executed by `tools/check-notice.ps1`; this
     * method only applies the result. Every frame rewrites the single ongoing
     * notification, so the shade always answers "what is it doing right now"
     * without the user opening the app, and refresh is free because the stream
     * channel is silent.
     *
     * @param frame one `frame` event from the stream.
     */
    private void progress(JSONObject frame) {
        // Remembered before anything else looks at it: a decision arrives on its own
        // event, carrying a session id and nothing else, and this map is how that id
        // turns back into a project name.
        String sessionId = frame.optString("sessionId", "");
        String project = frame.optString("project", "");
        if (!sessionId.isEmpty() && !project.isEmpty()) projects.put(sessionId, project);

        String kind = frame.optString("kind", "");
        if ("turn-start".equals(kind)) {
            // A new turn on the session that was about to announce itself means the
            // conversation is not finished after all — the agent moved on to another
            // round. Dropping the pending announcement here is the whole reason it is
            // delayed; without this the phone says "任务完成" between two rounds of the
            // same task. It is keyed by session: another conversation starting must not
            // cancel an announcement this one is owed.
            cancelDoneNoticeFor(sessionId);
        }

        Notice notice = Notice.of(
                kind,
                frame.optString("text", ""),
                frame.optString("detail", ""),
                frame.optLong("ts", 0L),
                project,
                frame.optInt("depth", 0),
                working,
                workingSince,
                System.currentTimeMillis());
        if (notice == null) return;

        // The state travels through the Notice so the two can never disagree: the
        // elapsed clock has to keep counting from the turn's start across every
        // activity frame, not restart at each one.
        working = notice.working;
        workingSince = notice.since;

        if (Notice.TITLE_DONE.equals(notice.title)) {
            // The digest already reads as a headline ("任务完成 · 52秒 · 8 次工具调用"), so it
            // becomes the title and the final answer becomes the body — and the project rides in
            // front of it, because the row is the one line that stays in the shade and "which
            // conversation" is the first thing to get wrong with two of them open. It stays in
            // the shade until the next turn replaces it, because clearing it would leave the
            // user with a bare "当前没有任务" and nothing to read.
            String digest = notice.alertTitle != null && !notice.alertTitle.isEmpty()
                    ? getString(R.string.progress_title_done_project, notice.alertTitle, notice.text)
                    : notice.text;
            updatePersistent(digest,
                    notice.detail.isEmpty() ? getString(R.string.progress_text_done) : notice.detail,
                    "", 0L, false, true);
            // The interruption names the project: "任务完成" alone is ambiguous as soon
            // as two sessions are open, and the digest underneath says what it cost.
            // What the round actually *produced* rides along too, because "which task
            // finished, and what came of it" is the question the notification is for —
            // the digest says how long and how many tools, not the answer.
            if (notice.alert && doneGate.end(sessionId, frame.optInt("depth", 0))) {
                String headline = notice.alertTitle != null
                        ? getString(R.string.done_headline, notice.alertTitle)
                        : getString(R.string.turn_done_title);
                scheduleDoneNotice(sessionId, headline, withAnswer(notice.text, notice.detail));
            }
            return;
        }

        String title = titleFor(notice.title, project);
        updatePersistent(title, notice.text, notice.detail, notice.since, notice.working, true);
        if (notice.alert) {
            alert(notice.alertTitle != null ? notice.alertTitle : title, notice.text, null);
        }
    }

    // ---- one notification per stop, not one per round ------------------------

    /**
     * How long a finished turn is held back before the phone is told about it.
     *
     * A turn that ends and is immediately followed by another one — a goal round, a
     * continuation, anything the agent decides to keep going with — is not the
     * conversation finishing, and announcing it would put "任务完成" on the lock screen
     * between two halves of the same task. Four seconds is longer than it takes for the
     * next round to start and short enough that a real stop still feels immediate.
     */
    private static final long DONE_QUIET_MS = 4_000L;

    /** The rule about whether an announcement is owed; see {@link DoneGate}. */
    private final DoneGate doneGate = new DoneGate();

    /** The posted announcement, so a following turn can withdraw it. */
    private Runnable pendingDone;

    /**
     * The digest plus a one-line taste of what the round actually said.
     *
     * "任务完成 · 13分52秒 · 12 次工具调用" answers "which task and how big", not "what did it
     * do" — and that second question is the one that decides whether the user puts the phone
     * down or opens it. The final answer is already in the frame's detail; this trims it to a
     * readable line and appends it after the digest, which stays first so the metrics are never
     * what gets cut off.
     *
     * @param digest the frame's own one-line summary.
     * @param detail the final answer, possibly empty.
     * @return what the notification body should say.
     */
    private String withAnswer(String digest, String detail) {
        String text = detail == null ? "" : detail.replaceAll("\\s+", " ").trim();
        if (text.isEmpty()) return digest;
        int limit = 120;
        String clipped = text.length() <= limit ? text : text.substring(0, limit) + "…";
        return digest + "\n" + clipped;
    }

    /**
     * The question plus the choices, as the phone shows them.
     *
     * "需要你决定：要不要合并这两个分支" leaves the user to open the app to find out what the
     * choices *are*; the payload carries them, so they ride in the notification. Options arrive
     * as plain strings in some builds and as `{label, value}` in others, so both are read.
     *
     * @param decision one entry from the `decisions` event.
     * @return the notification body, or the bare title when nothing readable is carried.
     */
    private String decisionBody(JSONObject decision, String title, String more) {
        StringBuilder body = new StringBuilder(title).append(more);
        JSONArray options = decision.optJSONArray("options");
        if (options != null) {
            for (int index = 0; index < options.length() && index < 4; index += 1) {
                Object raw = options.opt(index);
                String label = raw instanceof JSONObject
                        ? ((JSONObject) raw).optString("label", ((JSONObject) raw).optString("value", ""))
                        : String.valueOf(raw == null ? "" : raw);
                label = label.replaceAll("\\s+", " ").trim();
                if (label.isEmpty()) continue;
                body.append(body.length() == 0 ? "" : "\n").append("· ").append(label);
            }
        }
        return body.toString();
    }

    /**
     * Announce a finished turn, unless another one starts first.
     * @param sessionId the session that finished.
     * @param title the headline.
     * @param text the digest.
     */
    private void scheduleDoneNotice(String sessionId, String title, String text) {
        cancelDoneNotice();
        pendingDone = () -> {
            pendingDone = null;
            doneGate.cleared();
            alert(title, text, null);
        };
        new android.os.Handler(getMainLooper()).postDelayed(pendingDone, DONE_QUIET_MS);
    }

    /**
     * Withdraw a pending announcement if this session is the one that owed it.
     * @param sessionId the session that is starting.
     */
    private void cancelDoneNoticeFor(String sessionId) {
        if (!doneGate.start(sessionId)) return;
        if (pendingDone != null) {
            new android.os.Handler(getMainLooper()).removeCallbacks(pendingDone);
            pendingDone = null;
        }
    }

    /** Drop any pending announcement regardless of session. */
    private void cancelDoneNotice() {
        if (pendingDone != null) {
            new android.os.Handler(getMainLooper()).removeCallbacks(pendingDone);
            pendingDone = null;
        }
        doneGate.cleared();
    }

    /**
     * Resolve a {@link Notice} headline key to its resource, naming the project when known.
     *
     * The ongoing row is the one line that stays in the shade, so it answers "which
     * conversation, and what is it doing" rather than a bare state word: with two sessions open
     * "正在处理" says nothing about which one moved. When the frame carried no project the plain
     * wording is used, because a wrong name is worse than none.
     *
     * Total on purpose. A `done` notice never reaches here - the caller uses the
     * frame's own digest as the headline, which reads better than a fixed word -
     * but every key still maps to something, so a later refactor that routes it
     * here by mistake shows the completion word rather than silently labelling a
     * finished task "Pulse 已连接".
     *
     * @param key one of the {@code Notice.TITLE_*} constants.
     * @param project the workspace the frame belongs to; may be null or empty.
     * @return the text to show.
     */
    private String titleFor(String key, String project) {
        boolean named = project != null && !project.isEmpty();
        if (Notice.TITLE_RUNNING.equals(key)) {
            return named ? getString(R.string.progress_title_running_project, project)
                    : getString(R.string.progress_title_running);
        }
        if (Notice.TITLE_PROBLEM.equals(key)) {
            return named ? getString(R.string.progress_title_problem_project, project)
                    : getString(R.string.progress_title_problem);
        }
        if (Notice.TITLE_WAITING.equals(key)) {
            return named ? getString(R.string.progress_title_waiting_project, project)
                    : getString(R.string.progress_title_waiting);
        }
        if (Notice.TITLE_DONE.equals(key)) return getString(R.string.turn_done_title);
        return getString(R.string.service_title);
    }

    // ---- notifications -------------------------------------------------------

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;

        // IMPORTANCE_MIN, which is the quietest an ongoing connection is allowed to be:
        // no status-bar icon, no sound, no heads-up — a collapsed row at the very
        // bottom of the shade. The first version used LOW and justified it as "the
        // notification is the only sign the connection is alive", which was a
        // developer's reason: on a lock screen it was simply a permanent notice the
        // user had not asked for and could not get rid of. The notification now also
        // asks to be kept off the lock screen entirely (VISIBILITY_SECRET), and the
        // connection's health is still answerable from inside the app.
        NotificationChannel stream = new NotificationChannel(CHANNEL_STREAM,
                getString(R.string.channel_stream_name), NotificationManager.IMPORTANCE_MIN);
        stream.setDescription(getString(R.string.channel_stream_desc));
        stream.setShowBadge(false);
        stream.setSound(null, null);
        manager.createNotificationChannel(stream);
        // Without this the old channel lingers in the app's notification settings,
        // silent and unused, looking like a second switch to configure.
        manager.deleteNotificationChannel(CHANNEL_STREAM_LEGACY);

        NotificationChannel alerts = new NotificationChannel(CHANNEL_ALERT,
                getString(R.string.channel_alert_name), NotificationManager.IMPORTANCE_HIGH);
        alerts.setDescription(getString(R.string.channel_alert_desc));
        manager.createNotificationChannel(alerts);
    }

    /**
     * Open the app, optionally carrying an action.
     * @param decisionId decision to deep-link to, or null.
     * @param installCert whether to launch the certificate installer instead.
     * @return the pending intent.
     */
    private PendingIntent openApp(String decisionId, boolean installCert) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (decisionId != null) intent.putExtra("decisionId", decisionId);
        if (installCert) intent.putExtra("installCert", true);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        int requestCode = decisionId != null ? decisionId.hashCode() : (installCert ? 7 : 0);
        return PendingIntent.getActivity(this, requestCode, intent, flags);
    }

    private Notification persistent(String title, String text) {
        return persistent(title, text, "", 0L, false);
    }

    /**
     * Build the one ongoing notification.
     * @param title the headline.
     * @param text the second line.
     * @param detail expanded body, shown in place of the outline when opened; may
     *     be empty.
     * @param since epoch millis to run a live elapsed clock from, or 0 for none.
     * @param busy whether to show an indeterminate progress bar.
     * @return the built notification.
     */
    private Notification persistent(String title, String text, String detail, long since, boolean busy) {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_STREAM)
                : new Notification.Builder(this);
        // The line is a whole activity sentence ("编辑 lib/ui.js"), which the shade
        // truncates to "编辑 lib…"; expanded, it is readable in full, and the detail
        // rides underneath it when the frame carried one.
        String expanded = detail == null || detail.isEmpty() ? text : text + "\n" + detail;
        builder
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(expanded))
                .setSmallIcon(R.drawable.ic_notification)
                .setContentIntent(openApp(null, false))
                // Hidden from the lock screen, which is where it used to sit
                // permanently. This notification exists because Android requires a
                // foreground service to have one — a platform rule, not a design
                // choice — so the job is to make it as close to absent as the platform
                // allows. Silence comes from the channel being IMPORTANCE_MIN:
                // `setSilent` is a support-library method and this app has no
                // AndroidX, and on API 26+ the channel is what decides anyway.
                .setVisibility(Notification.VISIBILITY_SECRET)
                .setOnlyAlertOnce(true)
                // Not `ongoing`. The row exists because a foreground service must post
                // one, but the user was right that it "kept living there": an ongoing
                // notification cannot be dismissed at all, so there was no way to get rid
                // of a row that has nothing to say. Dismissible plus the dismissal being
                // respected (see updatePersistent) is what makes the shade quiet between
                // events.
                .setOngoing(false);
        if (since > 0L) {
            // The only progress signal that stays honest without the server
            // sending percentages: a clock the platform keeps ticking between
            // frames, so a long step never looks like a frozen notification.
            builder.setWhen(since).setUsesChronometer(true).setShowWhen(true);
        } else {
            builder.setShowWhen(false);
        }
        if (busy) builder.setProgress(0, 0, true);
        // The escape hatch for the one failure this app cannot detect on its own:
        // a WebView that renders the page but refuses the official client's
        // WebSocket because of the self-signed certificate. The remedy needs no
        // file transfer and no hunting through Settings, so it belongs where it is
        // always one swipe away.
        builder.addAction(new Notification.Action.Builder(
                null, getString(R.string.action_install_cert), openApp(null, true)).build());
        return builder.build();
    }

    private void updatePersistent(String title, String text) {
        updatePersistent(title, text, "", 0L, false, false);
    }

    /**
     * Rewrite the ongoing notification in place.
     *
     * ## Respecting a dismissal
     *
     * The row is dismissible (it is not `ongoing`), and a dismissal is taken as an
     * answer: once it is gone, **idle updates do not bring it back**. Only news does —
     * a turn starting, a turn finishing, a decision — which is exactly what was asked
     * for: nothing in the shade until there is something to say, and then a row that can
     * be swept away again.
     *
     * `getActiveNotifications` is how the dismissal is noticed at all; there is no
     * callback for it, so it is checked on the way to posting something idle.
     *
     * The same content is never posted twice either, which is the other half of the same
     * idea: re-posting an identical line is needless work and would also undo a
     * dismissal on a ROM that allows one.
     *
     * @param title the headline.
     * @param text the second line.
     * @param detail expanded body; may be empty.
     * @param since epoch millis for the live clock, or 0.
     * @param busy whether to show the progress bar.
     * @param news whether this update carries something worth reappearing for.
     */
    private void updatePersistent(String title, String text, String detail, long since, boolean busy,
                                  boolean news) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;

        if (postedLine != null && !news && !backgroundRowPosted(manager)) {
            // It was posted, it is gone, and this update is not news: the user swiped it.
            backgroundDismissed = true;
        }
        if (news) backgroundDismissed = false;
        if (backgroundDismissed) return;

        String line = title + '\u0001' + text + '\u0001' + detail + '\u0001' + (busy ? '1' : '0');
        if (line.equals(postedLine)) return;
        postedLine = line;
        manager.notify(NOTIFICATION_PERSISTENT, persistent(title, text, detail, since, busy));
    }

    /**
     * Whether the background notification is currently in the shade.
     *
     * The only way to notice a dismissal: the system offers no callback for it. Answers
     * `true` when it cannot tell, so an unreadable list never turns into a notification
     * that quietly stops appearing.
     *
     * @param manager the notification manager.
     * @return true when the row is posted, or when that cannot be determined.
     */
    private boolean backgroundRowPosted(NotificationManager manager) {
        try {
            for (android.service.notification.StatusBarNotification posted : manager.getActiveNotifications()) {
                if (posted.getId() == NOTIFICATION_PERSISTENT) return true;
            }
            return false;
        } catch (Exception error) {
            Log.w(TAG, "could not list active notifications: " + error);
            return true;
        }
    }

    /**
     * Raise a lock-screen notification.
     * @param title the headline.
     * @param body the detail.
     * @param decisionId decision to deep-link to, or null.
     */
    private void alert(String title, String body, String decisionId) {
        // While the user is looking at the app the information is already on
        // screen, and a notification would just be noise.
        if (visible) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ALERT)
                : new Notification.Builder(this);
        builder.setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setSmallIcon(R.drawable.ic_notification)
                .setContentIntent(openApp(decisionId, false))
                .setAutoCancel(true);
        // A blocked agent is the one notice that must survive being ignored.
        if (decisionId != null) builder.setOngoing(false).setPriority(Notification.PRIORITY_HIGH);
        manager.notify(NOTIFICATION_ALERT + (decisionId == null ? 0 : 1), builder.build());
    }
}
