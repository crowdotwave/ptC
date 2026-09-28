// The count in on a clock-led day: three short beeps and a long one as each window turns over.
//
// An EMOM is a client racing a clock that does not care, and the whole of this screen is built so
// that nobody has to look at it: the rows write themselves, the station changes itself. The one thing
// that still needed eyes was knowing when the minute was about to turn, which on a rower or under a
// barbell is exactly when nobody is looking at a phone. So the last three seconds of every window
// are said out loud, "3, 2, 1", and the next window opens on a long "go".
//
// Beeps rather than a voice, because speech synthesis starts when the phone gets round to it, and a
// "go" that arrives a quarter of a second late on a clock that is supposed to be exact is worse than
// no go at all. Tones are scheduled on the audio clock, which runs on its own thread, so they land
// on the second even when the page's own timers are late. That is the same promise js/emom.js makes
// about the block itself: nothing here cares how often it is called.
//
// Two limits that are the phone's and not this file's. Safari mutes web audio when the ring switch
// is on silent, and nothing plays once the screen locks. Both are left alone: the silent switch is
// the mute control somebody already knows how to use, and a locked phone is already a clock nobody
// is watching.

/** Seconds before a window ends that each short beep sounds. */
export const COUNT_IN_SECONDS = [3, 2, 1];

// What each cue sounds like. The count is short and mid pitched, the go is higher and held so it
// reads as the thing the count was counting to, and the end of the block drops rather than rising,
// because it is not the start of anything.
const TONES = {
  tick: { hz: 880, seconds: 0.12 },
  go: { hz: 1320, seconds: 0.45 },
  end: { hz: 660, seconds: 0.8 },
};

/**
 * The cues owed for the window now running, as wall clock instants.
 *
 * Read off the cursor alone, so a minute added to this window moves every cue with it and a caller
 * only has to ask again. The window that closes the block ends on `end` rather than `go`, since no
 * window follows it. Returns nothing for a block that has not started or has finished.
 */
export function windowCues(block, cursor) {
  if (!block || !cursor || cursor.windowStartedAt === null) return [];
  if (cursor.windowsDone >= block.minutes) return [];

  const endsAt = cursor.windowStartedAt + cursor.windowMs;
  const last = cursor.windowsDone + 1 >= block.minutes;
  return [
    ...COUNT_IN_SECONDS.map((s) => ({ at: endsAt - s * 1000, kind: 'tick' })),
    { at: endsAt, kind: last ? 'end' : 'go' },
  ];
}

/**
 * A key that changes exactly when the cues for the running window do. The screen ticks four times a
 * second and cues are scheduled once per window, so this is what decides a tick has anything to do.
 */
export function cueKey(block, cursor) {
  if (!block || !cursor || cursor.windowStartedAt === null) return null;
  return `${cursor.windowsDone}/${block.minutes}:${cursor.windowStartedAt}+${cursor.windowMs}`;
}

/**
 * The speaker. One per page, created lazily, because an AudioContext made before anybody has touched
 * the page starts suspended on every phone this runs on and stays that way.
 *
 * `unlock` must be called from inside a tap handler, synchronously: that tap is the only thing iOS
 * accepts as permission to make a sound. The start control is that tap, which is why the clock and
 * the sound begin on the same press.
 */
export function createCountdown() {
  let ctx = null;
  let scheduled = [];

  function context() {
    if (ctx) return ctx;
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
    } catch {
      ctx = null;
    }
    return ctx;
  }

  function tone(kind, when) {
    const spec = TONES[kind];
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = spec.hz;
    // A few milliseconds of attack so the tone does not click on, then an exponential fall, which is
    // what a struck bell does and what reads as a beep rather than a test signal.
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(0.6, when + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + spec.seconds);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(when);
    oscillator.stop(when + spec.seconds + 0.02);
    return { oscillator, when };
  }

  return {
    /** Wakes the audio. Call from the tap that starts the clock. Harmless to call again. */
    unlock() {
      const c = context();
      if (c && c.state === 'suspended') c.resume().catch(() => {});
    },

    /**
     * Replaces whatever is pending with these cues. A cue already more than a beat in the past is
     * dropped rather than played late: a "3" heard during the "1" is a wrong count.
     */
    schedule(cues, now = Date.now()) {
      this.cancel();
      const c = context();
      if (!c) return;
      for (const cue of cues) {
        const inSeconds = (cue.at - now) / 1000;
        if (inSeconds < -0.05) continue;
        scheduled.push(tone(cue.kind, c.currentTime + Math.max(0, inSeconds)));
      }
    },

    /** Plays one cue now, for the go that opens a fresh block. */
    now(kind) {
      const c = context();
      if (!c) return;
      tone(kind, c.currentTime);
    },

    /**
     * Silences anything not yet sounding, for a minute added, a day left, or a block that ended
     * early. A tone already playing is left to finish: the window turning over is itself what asks
     * for the next window's cues, at the very instant its go starts, and cutting that go off to make
     * room would silence the one beep the count exists for. A tone due within a quarter second
     * counts as sounding too: the page's clock and the audio clock are read separately and can
     * disagree by a few milliseconds, which is exactly the gap a go lands in when a window turns.
     */
    cancel() {
      const at = ctx ? ctx.currentTime + 0.25 : Infinity;
      for (const { oscillator, when } of scheduled) {
        if (when <= at) continue;
        try {
          oscillator.stop();
        } catch {
          // Already stopped.
        }
      }
      scheduled = [];
    },
  };
}
