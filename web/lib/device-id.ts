// Stable random device token, created once per browser and reused.
// Sent as X-Device-Id on login/claim → backend rate-limit precision dim (NOT a security boundary;
// can be cleared/spoofed). Account lockout + IP stuffing-gate remain the real defenses.
const STORAGE_KEY = "eticket_device_id";

// crypto.randomUUID exists only in secure contexts (https / localhost). Over a plain-http LAN IP
// (mobile/LAN dev) it's undefined and would throw — fall back to getRandomValues, then Math.random.
function randomUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
    return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
  }
  return `dev-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
}

export function getDeviceId(): string {
  try {
    let id = localStorage.getItem(STORAGE_KEY);
    if (!id) {
      id = randomUUID();
      localStorage.setItem(STORAGE_KEY, id);
    }
    return id;
  } catch {
    // Private mode / storage blocked: ephemeral id is fine — header still sent for this session.
    return randomUUID();
  }
}
