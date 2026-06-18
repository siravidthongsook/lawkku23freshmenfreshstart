// Scan-outcome feedback: short WebAudio beep + navigator.vibrate, for noisy/bright venues.
// No asset files — tones synthesized via AudioContext. All calls guard for unsupported browsers.
//
// Autoplay policy: an AudioContext created before any user gesture starts "suspended". We lazily create
// it and call resume() inside the first user gesture (camera open / tab tap) via primeAudio(); after that
// playTone() works. If the browser still blocks it, every call is wrapped so it fails silently.

type AudioCtor = typeof AudioContext;

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (audioCtx) return audioCtx;
  const Ctor: AudioCtor | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
  if (!Ctor) return null; // browser without WebAudio — feedback is best-effort
  try {
    audioCtx = new Ctor();
  } catch {
    audioCtx = null;
  }
  return audioCtx;
}

// Call inside a user gesture (e.g. opening the camera) so the AudioContext is allowed to produce sound later.
export function primeAudio(): void {
  const ctx = getAudioContext();
  if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => {});
}

// Play a single tone. freq in Hz, duration in ms. Square wave = sharper/louder for a noisy room.
function playTone(freq: number, durationMs: number, type: OscillatorType = "square"): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    // Brief attack + decay so it doesn't click; cap volume so it isn't jarring.
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.25, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + durationMs / 1000 + 0.02);
  } catch {
    // ignore — feedback is best-effort
  }
}

function vibrate(pattern: number | number[]): void {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  try {
    navigator.vibrate(pattern);
  } catch {
    // ignore — not all devices honor vibrate
  }
}

// High two-step chirp + single short buzz = clearly "OK".
export function feedbackSuccess(): void {
  playTone(880, 90);
  window.setTimeout(() => playTone(1175, 110), 95);
  vibrate(120);
}

// Low buzzer + double pulse = clearly "NOT OK / denied". Distinct from success in both pitch and rhythm.
export function feedbackDeny(): void {
  playTone(220, 260, "sawtooth");
  vibrate([90, 70, 90]);
}

// Soft mid double-beep for "needs attention but not a hard deny" (already-checked-in / window not open).
export function feedbackWarn(): void {
  playTone(523, 110);
  window.setTimeout(() => playTone(523, 110), 150);
  vibrate([60, 50, 60]);
}
