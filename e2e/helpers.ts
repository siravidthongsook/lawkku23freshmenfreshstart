import { expect, type Page } from "@playwright/test";

// QA fixtures seeded by scripts/seed-qa.ts (see e2e/global-setup.ts).
export const QA = {
  password: "QaTest1234!",
  admin: "qa-admin@test.local",
  staff: "qa-staff-01", // staff login by username
  student1: "QA0001", // student login by student_id
  student2: "QA0002",
} as const;

// Real login through the UI: fill identifier + password, submit, wait until off /login.
export async function loginAs(page: Page, identifier: string, password = QA.password) {
  await page.goto("/login");
  await page.getByRole("textbox").first().fill(identifier);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: "เข้าสู่ระบบ" }).click();
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 30_000 });
}

// Log out via the top-nav button (present on every authed page).
export async function logout(page: Page) {
  await page.getByRole("button", { name: "ออกจากระบบ" }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
}

// Create a published event with an active registration form + an OPEN check-in window,
// using the real admin API (same-origin /api proxy → cookies from the logged-in page).
// The walk-in dialog needs all three; the QA seed only seeds users, so the test self-seeds
// its event here via the documented endpoints (no DB hacks, no faked infra).
// Returns the event id. The page MUST already be logged in as admin.
export async function createWalkinReadyEvent(page: Page, title: string): Promise<string> {
  // Check-in window spans "now" (±12h) so checkin_now actually stamps + awards points.
  const now = Date.now();
  const checkinOpenAt = new Date(now - 12 * 3600_000).toISOString();
  const checkinCloseAt = new Date(now + 12 * 3600_000).toISOString();

  const createRes = await page.request.post("/api/admin/events", {
    data: { title, checkinOpenAt, checkinCloseAt },
  });
  if (!createRes.ok()) throw new Error(`create event failed: ${createRes.status()} ${await createRes.text()}`);
  const eventId = (await createRes.json()).event.id as string;

  // Bootstrap form v1 (one optional field is enough; walk-in relaxes required fields anyway).
  const formRes = await page.request.patch(`/api/admin/events/${eventId}/form`, {
    data: { schema: { fields: [{ key: "note", type: "short_text", label: "หมายเหตุ" }] } },
  });
  if (!formRes.ok()) throw new Error(`bootstrap form failed: ${formRes.status()} ${await formRes.text()}`);

  // Publish (events are created as draft; walk-in rejects unpublished with event_not_published).
  const pubRes = await page.request.post(`/api/admin/events/${eventId}/status`, {
    data: { status: "published" },
  });
  if (!pubRes.ok()) throw new Error(`publish failed: ${pubRes.status()} ${await pubRes.text()}`);

  return eventId;
}
