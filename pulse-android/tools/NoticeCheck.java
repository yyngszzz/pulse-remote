import com.pulse.remote.DoneGate;
import com.pulse.remote.Notice;

/**
 * Execute the phone's notification policy under a plain JVM.
 *
 *   powershell -ExecutionPolicy Bypass -File tools/check-notice.ps1
 *
 * ## Why this exists
 *
 * The bug this guards against was invisible for a whole release: the service
 * handled `turn-end` and silently dropped every other frame, so during a task the
 * shade read "Pulse 已连接" and the user concluded notifications were broken. That
 * is a property of a mapping table, not of Android, and a mapping table can be
 * executed here in a millisecond instead of being rediscovered on a lock screen.
 *
 * The cases below are not invented shapes: each one is a frame the distiller in
 * `dsh-remote-pulse/lib/distill.js` actually emits, with its real kind and text.
 *
 * The run ends with a guard that at least one notice was produced, because every
 * "no notice expected" case would otherwise pass if the policy regressed to
 * returning null for everything - a check that cannot fail is worthless.
 */
public final class NoticeCheck {

    private static int checks = 0;
    private static int failures = 0;
    /** How many frames the policy actually acted on; see the guard at the end. */
    private static int notices = 0;
    /** Which frames the policy would interrupt for, as "kind@depth"; see the guard. */
    private static final java.util.List<String> interrupts = new java.util.ArrayList<>();

    private NoticeCheck() {
    }

    /**
     * Run every case.
     * @param args ignored.
     */
    public static void main(String[] args) {
        System.out.println("通知策略检查（Notice.of）");

        // --- one frame at a time -------------------------------------------------

        // A turn starting rewrites the shade and opens the clock, but must stay
        // silent: the computer does not notify on a start either, and one buzz per
        // stop is the whole point.
        frame("turn-start 推进度但不打扰")
                .kind("turn-start").text("开始处理").ts(1000L).state(false, 0L)
                .expect(Notice.TITLE_RUNNING, "开始处理", true, 1000L, false);

        // Routine activity must refresh the line and must not buzz.
        frame("activity 刷新但不打扰")
                .kind("activity").text("编辑 lib/ui.js").ts(2000L).state(true, 1000L)
                .expect(Notice.TITLE_RUNNING, "编辑 lib/ui.js", true, 1000L, false);

        // ... and the elapsed clock must still count from the turn's start, not
        // restart at this frame: that is the difference between a clock and a lie.
        frame("activity 不重置已用时间")
                .kind("activity").text("读取 lib/server.js").ts(9000L).state(true, 1000L)
                .expect(Notice.TITLE_RUNNING, "读取 lib/server.js", true, 1000L, false);

        // A collapsed run summarizes several tool calls, same rules as activity.
        frame("summary 与 activity 同等对待")
                .kind("summary").text("读取 ×3 (a.js)").ts(3000L).state(true, 1000L)
                .expect(Notice.TITLE_RUNNING, "读取 ×3 (a.js)", true, 1000L, false);

        // Outside a turn there is nothing to report: a stale frame must not
        // overwrite a digest that already announced completion.
        frame("闲时 activity 不覆盖结果")
                .kind("activity").text("读取 a.txt").ts(4000L).state(false, 0L)
                .expect(null, null, false, 0L, false);

        // A failure stops the clock and shows the reason, but stays silent: the
        // computer only pushes failures with `notifyFailures` on, and a failed tool
        // is usually retried and then followed by a turn-end - one stop, one buzz.
        frame("failure 只显示不打扰")
                .kind("failure").text("编辑失败：文件被占用").ts(5000L).state(true, 1000L)
                .expect(Notice.TITLE_PROBLEM, "编辑失败：文件被占用", false, 0L, false);

        // The digest becomes the headline; the final answer rides as the body.
        frame("turn-end 摘要与正文")
                .kind("turn-end").text("任务完成 · 52秒 · 8 次工具调用").detail("改好了，共 3 个文件")
                .ts(6000L).state(true, 1000L)
                .expect(Notice.TITLE_DONE, "任务完成 · 52秒 · 8 次工具调用", false, 0L, true);

        // A decision is announced by the `decisions` event, which also carries the
        // options; the frame only relabels the shade, so it must not buzz twice.
        // The turn stays open - it is blocked, not finished.
        frame("decision 不重复提醒且保留进行中")
                .kind("decision").text("要不要覆盖 build 输出？").ts(7000L).state(true, 1000L)
                .expect(Notice.TITLE_WAITING, "要不要覆盖 build 输出？", true, 1000L, false);

        frame("闲时 decision 也不算进行中")
                .kind("decision").text("要不要继续？").ts(7100L).state(false, 0L)
                .expect(Notice.TITLE_WAITING, "要不要继续？", false, 0L, false);

        // Kinds the policy deliberately ignores. An unrecognised frame is not
        // evidence of news, and a wrong buzz at 3am cannot be taken back.
        frame("session 翻转被忽略")
                .kind("session").text("空闲").ts(8000L).state(true, 1000L)
                .expect(null, null, false, 0L, false);

        frame("decision-resolved 被忽略")
                .kind("decision-resolved").text("已回复：是").ts(8100L).state(true, 1000L)
                .expect(null, null, false, 0L, false);

        frame("未来新增的 kind 不被猜测")
                .kind("telemetry").text("CPU 12%").ts(8200L).state(true, 1000L)
                .expect(null, null, false, 0L, false);

        frame("空文本不产生通知")
                .kind("activity").text("").ts(8300L).state(true, 1000L)
                .expect(null, null, false, 0L, false);

        frame("kind 缺失不产生通知")
                .kind(null).text("x").ts(8400L).state(true, 1000L)
                .expect(null, null, false, 0L, false);

        // A frame without a timestamp must not start the clock at the epoch.
        long now = 1_700_000_000_000L;
        frame("turn-start 无时间戳时回落到当前时间")
                .kind("turn-start").text("开始处理").ts(0L).state(false, 0L).now(now)
                .expect(Notice.TITLE_RUNNING, "开始处理", true, now, false);

        // --- which project the interruption names --------------------------------

        // Two sessions can be open at once, so "任务完成" on its own does not say what
        // finished. The frame carries its workspace, and that becomes the headline.
        frame("回合结束用项目名当标题")
                .kind("turn-end").text("任务完成 · 52秒 · 8 次工具调用").ts(9000L)
                .state(true, 1000L).project("deepseek harness")
                .expectTitle("deepseek harness");

        frame("没有项目名时回落到通用措辞")
                .kind("turn-end").text("任务完成 · 52秒").ts(9100L)
                .state(true, 1000L).project("")
                .expectTitle(null);

        // Motion never interrupts, so it never needs a headline either.
        frame("工具调用不该有打扰标题")
                .kind("activity").text("编辑 lib/ui.js").ts(9200L)
                .state(true, 1000L).project("deepseek harness")
                .expectTitle(null);

        // --- nothing from below the top level interrupts --------------------------

        // Five of the thirteen sessions on this machine are subagents (depth 1), and
        // every one of their turn-ends used to buzz the phone about work the user had
        // not asked to hear about. The line still updates; the buzz does not happen.
        frame("子代理的回合结束不打扰（那一行仍然更新）")
                .kind("turn-end").text("任务完成 · 12秒 · 3 次工具调用").ts(9300L)
                .state(true, 1000L).project("deepseek harness").depth(1)
                .expect(Notice.TITLE_DONE, "任务完成 · 12秒 · 3 次工具调用", false, 0L, false);

        frame("子代理的工具调用当然也不打扰")
                .kind("activity").text("编辑 a.js").ts(9400L)
                .state(true, 1000L).depth(1)
                .expect(Notice.TITLE_RUNNING, "编辑 a.js", true, 1000L, false);

        frame("深度 0 的会话仍然会打扰（顶层就是用户自己那条）")
                .kind("turn-end").text("任务完成").ts(9500L)
                .state(true, 1000L).depth(0)
                .expect(Notice.TITLE_DONE, "任务完成", false, 0L, true);

        // --- one whole turn, in order --------------------------------------------

        // The per-frame cases above each assume a state; this one derives it, so a
        // mistake in threading `working`/`since` through the notice cannot hide.
        sequence();

        // --- "finished" vs "paused": the same rule the service delays by ----------
        gate();

        System.out.println();
        if (notices == 0) {
            System.out.println("FAIL 所有帧都被忽略了：这些检查不可能失败，说明策略本身坏了");
            failures += 1;
        }
        // The policy in one sentence: the only shape of frame that interrupts is a
        // top-level turn end. The *set* is compared, not the count, so several cases can
        // exercise the same rule without weakening it — while adding any other kind, or
        // letting a subagent's frame through, changes the set and fails. A decision is
        // announced by the `decisions` event, which carries the answer options, so it
        // must not also arrive from here.
        java.util.TreeSet<String> shapes = new java.util.TreeSet<>(interrupts);
        if (!shapes.equals(new java.util.TreeSet<>(java.util.Collections.singleton("turn-end@0")))) {
            System.out.println("FAIL 会打断的帧涉及这些形态 " + shapes + "，期望只有 [turn-end@0]"
                    + "（深度 0 的回合结束；决定由 decisions 事件单独提醒）");
            failures += 1;
        } else {
            System.out.println("PASS 会打断的帧只有一种形态：turn-end@0（" + interrupts.size() + " 个用例覆盖它）");
        }
        System.out.println("共 " + checks + " 项检查，失败 " + failures + " 项");
        if (failures > 0) System.exit(1);
    }

    /**
     * Exercise the "is this the end, or a pause?" rule.
     *
     * This is the half of the policy that needs a clock in production: the service holds
     * the announcement for a few seconds, and a turn starting on the same session in the
     * meantime withdraws it. The rule itself has no clock in it, so it is executed here.
     */
    private static void gate() {
        DoneGate gate = new DoneGate();

        // The ordinary case: a top-level turn ends and the user is owed a notice.
        expectGate("顶层回合结束 → 欠一次提醒", gate.end("main", 0) && gate.owed());

        // A new turn on the same session means it was a pause, not an end.
        boolean withdrawn = gate.start("main");
        expectGate("同一会话又开始了 → 撤回那次提醒（不是完成，而是还在跑）",
                withdrawn && !gate.owed());

        // Another conversation starting says nothing about this one.
        gate.end("main", 0);
        boolean kept = !gate.start("other") && gate.owed();
        expectGate("别的会话开始 → 这一条的提醒仍然欠着", kept);
        gate.cleared();

        // A subagent's turn is never the user's conversation finishing.
        expectGate("子代理回合结束 → 不欠任何提醒", !gate.end("sub", 1) && !gate.owed());

        // And after the notice has been made, nothing is owed.
        gate.end("main", 0);
        gate.cleared();
        expectGate("提醒发出之后 → 不再欠", !gate.owed());
    }

    /**
     * Report one gate expectation.
     * @param label what the case is about.
     * @param ok whether it held.
     */
    private static void expectGate(String label, boolean ok) {
        checks += 1;
        if (ok) {
            System.out.println("PASS " + label);
            return;
        }
        System.out.println("FAIL " + label);
        failures += 1;
    }

    /**
     * Feed one realistic turn through the policy and watch the shade.
     */
    private static void sequence() {
        String[] kinds = {"turn-start", "activity", "activity", "failure", "failure"};
        String[] texts = {"开始处理", "读取 lib/ui.js", "编辑 lib/ui.js", "运行失败：超时", "读取失败：没了"};
        // Turn start opens the clock; nothing during the turn resets it; the first
        // failure closes it, and the second failure must not reopen it.
        boolean[] working = {true, true, true, false, false};
        long[] since = {1000L, 1000L, 1000L, 0L, 0L};

        boolean stateWorking = false;
        long stateSince = 0L;
        for (int index = 0; index < kinds.length; index += 1) {
            long ts = 1000L + index * 500L;
            Notice notice = Notice.of(kinds[index], texts[index], "", ts, "deepseek harness", 0,
                    stateWorking, stateSince, ts);
            checks += 1;
            if (notice == null) {
                System.out.println("FAIL 连续序列 " + kinds[index] + " 意外被忽略");
                failures += 1;
                continue;
            }
            notices += 1;
            if (notice.alert) interrupts.add(kinds[index] + "@0");
            stateWorking = notice.working;
            stateSince = notice.since;
            if (stateWorking != working[index] || stateSince != since[index]) {
                System.out.println("FAIL 连续序列第 " + (index + 1) + " 帧 " + kinds[index]
                        + "：期望 working=" + working[index] + " since=" + since[index]
                        + "，实际 working=" + stateWorking + " since=" + stateSince);
                failures += 1;
            } else {
                System.out.println("PASS 连续序列第 " + (index + 1) + " 帧 " + kinds[index]
                        + " → working=" + stateWorking + " since=" + stateSince);
            }
        }
    }

    // ---- a tiny expectation builder ---------------------------------------------

    /**
     * Start a case.
     * @param label what the case is about.
     * @return the builder.
     */
    private static Case frame(String label) {
        return new Case(label);
    }

    /** One frame plus the notice it is expected to produce. */
    private static final class Case {
        private final String label;
        private String kind = "";
        private String text = "";
        private String detail = "";
        private String project = "";
        private int depth = 0;
        private long ts = 0L;
        private boolean working = false;
        private long since = 0L;
        private long now = 999_999L;

        Case(String label) {
            this.label = label;
        }

        Case kind(String value) { this.kind = value; return this; }
        Case text(String value) { this.text = value; return this; }
        Case detail(String value) { this.detail = value; return this; }
        Case project(String value) { this.project = value; return this; }
        Case depth(int value) { this.depth = value; return this; }
        Case ts(long value) { this.ts = value; return this; }
        Case now(long value) { this.now = value; return this; }
        Case state(boolean isWorking, long startedAt) { this.working = isWorking; this.since = startedAt; return this; }

        /**
         * Check only the headline an interruption would carry.
         * @param expected the project name, or null for "use the generic wording".
         */
        void expectTitle(String expected) {
            checks += 1;
            Notice notice = Notice.of(kind, text, detail, ts, project, depth, working, since, now);
            if (notice == null) {
                System.out.println("FAIL " + label + "：期望有通知，实际没有");
                failures += 1;
                return;
            }
            boolean same = expected == null ? notice.alertTitle == null : expected.equals(notice.alertTitle);
            if (!same) {
                System.out.println("FAIL " + label + "：打扰标题期望 "
                        + (expected == null ? "(通用措辞)" : expected) + "，实际 "
                        + (notice.alertTitle == null ? "(通用措辞)" : notice.alertTitle));
                failures += 1;
                return;
            }
            notices += 1;
            System.out.println("PASS " + label + " → 打扰标题 "
                    + (notice.alertTitle == null ? "(通用措辞)" : notice.alertTitle));
        }

        /**
         * Compare and report.
         * @param title expected headline key, or null when no notice is expected.
         * @param body expected text, or null.
         * @param isWorking expected working flag.
         * @param startedAt expected clock start.
         * @param alert expected interruption flag.
         */
        void expect(String title, String body, boolean isWorking, long startedAt, boolean alert) {
            checks += 1;
            Notice notice = Notice.of(kind, text, detail, ts, project, depth, working, since, now);
            if (title == null) {
                if (notice != null) {
                    System.out.println("FAIL " + label + "：期望不产生通知，实际 " + notice);
                    failures += 1;
                } else {
                    System.out.println("PASS " + label + " → 不产生通知");
                }
                return;
            }
            notices += 1;
            if (notice != null && notice.alert) interrupts.add(kind + "@" + depth);
            if (notice == null) {
                System.out.println("FAIL " + label + "：期望 " + title + "，实际没有通知");
                failures += 1;
                return;
            }
            StringBuilder wrong = new StringBuilder();
            if (!title.equals(notice.title)) wrong.append(" title=").append(notice.title).append("(期望 ").append(title).append(")");
            if (body != null && !body.equals(notice.text)) wrong.append(" text=").append(notice.text);
            if (isWorking != notice.working) wrong.append(" working=").append(notice.working);
            if (startedAt != notice.since) wrong.append(" since=").append(notice.since);
            if (alert != notice.alert) wrong.append(" alert=").append(notice.alert);
            if (wrong.length() > 0) {
                System.out.println("FAIL " + label + "：期望不符 →" + wrong);
                failures += 1;
            } else {
                System.out.println("PASS " + label + " → " + notice.title
                        + "，working=" + notice.working + " since=" + notice.since
                        + " alert=" + notice.alert);
            }
        }
    }
}
