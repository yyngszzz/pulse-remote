package com.pulse.remote;

/**
 * What one distilled frame should do to the notification shade.
 *
 * ## Why this is a separate, dependency-free class
 *
 * The whole notification policy is one mapping: frame kind to (headline, line,
 * whether to interrupt). Written inline in the service it could only ever be
 * exercised by a real phone receiving real frames, and that is exactly how the bug
 * this replaced survived: only `turn-end` was handled, so for the entire length of
 * a task the shade said "Pulse 已连接" and nothing else.
 *
 * With the mapping here, `tools/NoticeCheck.java` drives it under a plain JVM over
 * frames shaped like the distiller's own output. "Does a failure interrupt",
 * "does a routine tool call stay silent", "does the clock keep counting from the
 * turn's start" are then answered by a command instead of by staring at a lock
 * screen and guessing.
 *
 * What it deliberately does not decide is *timing*: a turn that ends and is immediately
 * followed by another one is not the conversation finishing, and that judgement needs a
 * clock, so it lives in the service. "Does this frame interrupt at all" is total here.
 */
public final class Notice {

    /** Headline: a turn is in flight. */
    public static final String TITLE_RUNNING = "running";

    /** Headline: something failed. */
    public static final String TITLE_PROBLEM = "problem";

    /** Headline: the agent is blocked on a human. */
    public static final String TITLE_WAITING = "waiting";

    /** Headline: the turn is over; the caller uses the frame text as the title. */
    public static final String TITLE_DONE = "done";

    /** Which string resource to use as the headline. */
    public final String title;

    /** The one-line text. */
    public final String text;

    /** The expanded body; never null. */
    public final String detail;

    /** Whether the shade should show a progress bar and a live elapsed clock. */
    public final boolean working;

    /** Epoch millis the elapsed clock counts from; 0 when nothing is running. */
    public final long since;

    /** Whether this frame is worth an interruption. */
    public final boolean alert;

    /**
     * What an interruption should be headlined with, or null to use the kind's own
     * word.
     *
     * "任务完成" alone is ambiguous the moment two sessions are open, so when the frame
     * knows its workspace that name becomes the headline and the digest underneath
     * says what it cost. Kept here rather than in the service because it is part of
     * the same mapping — and this class is the half a plain JVM can execute.
     */
    public final String alertTitle;

    private Notice(String title, String text, String detail, boolean working, long since,
                   boolean alert, String project) {
        this.title = title;
        this.text = text;
        this.detail = detail == null ? "" : detail;
        this.working = working;
        this.since = since;
        this.alert = alert;
        this.alertTitle = alert && project != null && !project.isEmpty() ? project : null;
    }

    /**
     * Map one frame onto the notice to show.
     * @param kind the frame kind, e.g. {@code turn-start}.
     * @param text the frame's one-line text.
     * @param detail the frame's expanded detail; may be null or empty.
     * @param ts the frame's own timestamp in epoch millis, 0 when absent.
     * @param project the workspace the frame belongs to; may be null or empty.
     * @param depth how deep in the delegation tree the session sits: 0 for the
     *     conversation the user started, 1+ for a subagent working inside it.
     * @param working whether a turn is already open.
     * @param since when that open turn started, 0 when there is none.
     * @param now wall clock to fall back on when the frame carries no time.
     * @return the notice to show, or null when this frame should change nothing.
     */
    public static Notice of(String kind, String text, String detail, long ts, String project,
                            int depth, boolean working, long since, long now) {
        if (kind == null || text == null || text.isEmpty()) return null;

        // A subagent finishing its own turn is not the user's conversation finishing.
        // Five of the thirteen sessions on this machine sit at depth 1, and every one of
        // their turn-ends used to interrupt the phone — which is why it was noisy about
        // work the user never asked to be told about. The shade still updates from below;
        // nothing below the top level ever interrupts.
        boolean top = depth <= 0;

        if ("turn-start".equals(kind)) {
            // Opens the clock and rewrites the shade, but does not buzz. The console
            // on the computer does not notify on a start either, and a phone that
            // rings every time anything begins is a phone whose notifications get
            // turned off.
            return new Notice(TITLE_RUNNING, text, detail, true, ts > 0L ? ts : now, false, project);
        }
        if ("turn-end".equals(kind)) {
            // The one moment worth a buzz: the machine stopped and nothing else will
            // happen until the user looks. This mirrors the computer's push, which
            // fires on `turn/end` and nowhere else.
            return new Notice(TITLE_DONE, text, detail, false, 0L, top, project);
        }
        if ("failure".equals(kind)) {
            // Shown, not announced: the computer only pushes failures when
            // `notifyFailures` is switched on, and a failed tool is usually followed
            // by a retry and then a turn-end, so alerting here would ring twice for
            // one stop. The turn-end digest carries the failure count instead.
            return new Notice(TITLE_PROBLEM, text, detail, false, 0L, false, project);
        }
        if ("decision".equals(kind)) {
            // The question itself is announced by the `decisions` event, which also
            // carries the options. This only makes the shade state what it is waiting
            // for, so it must not buzz twice. `working` is deliberately untouched:
            // the turn is still open, merely blocked on a human, and clearing it
            // would stop the line from updating once the answer comes back.
            return new Notice(TITLE_WAITING, text, detail, working, since, false, project);
        }
        if ("activity".equals(kind) || "summary".equals(kind)) {
            // Motion, not news. A tool call must never buzz a pocket; it only
            // refreshes the line, and only while a turn is actually open, so a late
            // frame cannot overwrite a digest that already said the turn was done.
            return working ? new Notice(TITLE_RUNNING, text, detail, true, since, false, project) : null;
        }
        // `session`, `decision-resolved`, and anything the distiller grows later:
        // ignore rather than guess. Silence is recoverable; a wrong buzz at 3am is
        // not, and a frame this class does not recognise is not evidence of news.
        return null;
    }

    @Override
    public String toString() {
        return "Notice(" + title + ", working=" + working + ", since=" + since
                + ", alert=" + alert + ", alertTitle=" + alertTitle + ", text=" + text + ")";
    }
}
