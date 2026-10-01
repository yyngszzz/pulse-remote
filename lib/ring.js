/**
 * Bounded, replayable frame log — the memory that makes a phone on a flaky
 * mobile network trustworthy.
 *
 * A phone that drops off 4G for two minutes must not come back to a blank
 * screen, and must not be handed a full re-render either. It reconnects with
 * the last sequence number it actually rendered and receives exactly the
 * frames it missed. Older frames than the window simply cannot be replayed,
 * and the reader is told so explicitly rather than shown a silently gapped
 * stream.
 *
 * @module dsh-remote-pulse/ring
 */

/**
 * Fixed-capacity sequence log. O(1) append, O(log n) replay by sequence.
 */
export class FrameRing {
  /**
   * @param {object} [options] - tuning.
   * @param {number} [options.capacity] - maximum retained frames.
   */
  constructor(options = {}) {
    this.capacity = Math.max(1, options.capacity ?? 800);
    /** @type {Array<object>} retained frames in ascending sequence order. */
    this.frames = [];
    /** Monotonic id assigned to every frame, so replay is unambiguous. */
    this.lastSeq = 0;
    /** Frames dropped since construction, surfaced to late readers. */
    this.dropped = 0;
  }

  /**
   * Append one frame, assigning it the next sequence number.
   * @param {object} frame - a distilled frame.
   * @returns {object} the stored frame, with `seq` set.
   */
  push(frame) {
    this.lastSeq += 1;
    const stored = { ...frame, seq: this.lastSeq };
    this.frames.push(stored);
    while (this.frames.length > this.capacity) {
      this.frames.shift();
      this.dropped += 1;
    }
    return stored;
  }

  /**
   * Replay everything after a sequence number.
   * @param {number} since - the last sequence the reader rendered.
   * @returns {{frames: Array<object>, gap: boolean, lastSeq: number}} the replay
   *   result; `gap` is true when frames the reader needed were already dropped.
   */
  since(since) {
    const from = Number.isFinite(since) ? Math.max(0, Math.trunc(since)) : 0;
    const first = this.frames.length > 0 ? this.frames[0].seq : this.lastSeq + 1;
    // A reader asking for something older than the window has a real gap.
    const gap = from > 0 && from + 1 < first;
    return {
      frames: this.frames.filter(frame => frame.seq > from),
      gap,
      lastSeq: this.lastSeq,
    };
  }

  /**
   * The most recent frames, oldest first.
   * @param {number} count - how many to return.
   * @returns {Array<object>} the tail.
   */
  tail(count = 50) {
    const n = Math.max(0, Math.trunc(count));
    return n === 0 ? [] : this.frames.slice(-n);
  }

  /** @returns {void} */
  clear() {
    this.frames.length = 0;
  }
}

export default FrameRing;
