// Stable random device token, created once per browser and reused.
// Sent as X-Device-Id on login/claim → backend rate-limit precision dim (NOT a security boundary;
// can be cleared/spoofed). Account lockout + IP stuffing-gate remain the real defenses.
const STORAGE_KEY = "eticket_device_id";

export function getDeviceId(): string {
  try {
    let id = localStorage.getItem(STORAGE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(STORAGE_KEY, id);
    }
    return id;
  } catch {
    // Private mode / storage blocked: ephemeral id is fine — header still sent for this session.
    return crypto.randomUUID();
  }
}
