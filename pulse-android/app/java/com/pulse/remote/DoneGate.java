package com.pulse.remote;

/**
 * Whether a finished turn is the end of the conversation or just a pause in it.
 *
 * ## Why this is not simply "turn/end"
 *
 * The phone was told about every turn end, and a turn end is not the same event as the
 * user's conversation stopping. Two things made that visible:
 *
 *   * **subagents.** A delegation runs as its own session — five of the thirteen
 *     sessions on this machine sit at depth 1 — and each of them ends a turn too, so the
 *     phone kept announcing work the user had never asked to hear about;
 *   * **continuations.** A turn that ends and is immediately followed by another one on
 *     the same session (a goal round, anything the agent decides to carry on with) is
 *     one task with a pause in it, and announcing the pause puts "任务完成" on the lock
 *     screen halfway through.
 *
 * So an announcement is *owed* when a top-level turn ends, and it is *withdrawn* if that
 * same session starts another turn before the caller gets round to making it. The caller
 * owns the clock (a `Handler` delay); this class owns the rule, which is why
 * `tools/NoticeCheck.java` can execute it.
 *
 * The withdrawal is keyed by session on purpose: another conversation starting a turn
 * must not cancel an announcement this one is owed.
 */
public final class DoneGate {

    /** Session whose completion is currently owed, or null. */
    private String pending;

    /**
     * Observe a turn end.
     *
     * @param sessionId the session that finished.
     * @param depth its delegation depth: 0 for the user's own conversation, 1+ for a
     *     subagent working inside it.
     * @return true when the caller now owes the user an announcement.
     */
    public boolean end(String sessionId, int depth) {
        if (depth > 0) return false;
        pending = sessionId == null ? "" : sessionId;
        return true;
    }

    /**
     * Observe a turn start.
     *
     * @param sessionId the session that started.
     * @return true when this cancelled an owed announcement.
     */
    public boolean start(String sessionId) {
        if (pending == null) return false;
        if (sessionId != null && sessionId.equals(pending)) {
            pending = null;
            return true;
        }
        // A different conversation starting says nothing about this one.
        return false;
    }

    /** @return true when an announcement is currently owed. */
    public boolean owed() {
        return pending != null;
    }

    /** Forget the owed announcement, once it has been made. */
    public void cleared() {
        pending = null;
    }

    /** @return the session the owed announcement belongs to, or null. */
    public String session() {
        return pending;
    }
}
