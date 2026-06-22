import { test, expect, type Page } from "@playwright/test";
import { QA, loginAs, createWalkinReadyEvent } from "./helpers";

// Walk-in dialog (web/components/walkin/walkin-dialog.tsx) shared by the staff check-in gate
// (checkinNow=true: create + register + check-in now) and the admin desk (checkinNow=false: register only).
// One endpoint: POST /events/:id/walkin. Flow: fill → ตรวจสอบ (dry-run) → ยืนยันบันทึก (commit) → result.
//
// The QA seed (scripts/seed-qa.ts) only seeds users, so each run self-seeds its own published event with an
// OPEN check-in window + active form via the real admin API (see createWalkinReadyEvent). Unique student_ids
// (Date.now suffix) keep reruns from colliding on the user_exists guard.

// Fill the dialog's three required fields (name, student_id, reason); email optional.
// NOTE: the Field labels aren't htmlFor-associated with their inputs, so getByLabel won't match —
// anchor each input via its label's wrapping div instead. The reason textarea DOES have id=walkin-reason.
function fieldInput(page: Page, label: string) {
  return page
    .getByRole("dialog")
    .locator("div.space-y-1\\.5", { has: page.getByText(label, { exact: false }) })
    .locator("input")
    .first();
}

async function fillWalkinForm(
  page: Page,
  data: { fullName: string; studentId: string; reason: string; email?: string },
) {
  const dialog = page.getByRole("dialog");
  await fieldInput(page, "ชื่อ-นามสกุล").fill(data.fullName);
  await fieldInput(page, "รหัสนักศึกษา").fill(data.studentId);
  if (data.email) await dialog.locator('input[type="email"]').fill(data.email);
  await dialog.locator("#walkin-reason").fill(data.reason);
}

test.describe("walk-in register dialog", () => {
  let eventId: string;

  // Self-seed one published, check-in-open event for the whole file (logged in as admin to use admin API).
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAs(page, QA.admin);
    eventId = await createWalkinReadyEvent(page, `E2E Walk-in ${Date.now()}`);
    await page.close();
  });

  test("staff gate: fill → ตรวจสอบ → confirm shows identity → ยืนยันบันทึก → checked-in + points", async ({
    page,
  }) => {
    const studentId = `W${Date.now()}`;
    const fullName = "วอล์คอิน ทดสอบ";

    await loginAs(page, QA.staff);
    await page.goto(`/staff/events/${eventId}/checkin`);

    // Open the dialog from the scanner screen's walk-in button.
    await page.getByRole("button", { name: "เพิ่ม Walk-in" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("เพิ่ม Walk-in")).toBeVisible();

    await fillWalkinForm(page, { fullName, studentId, reason: "ลงทะเบียนหน้างาน e2e" });

    // Step 1: dry-run preview → confirm screen shows the typed identity + "จะลงทะเบียนและเช็คอินทันที".
    await dialog.getByRole("button", { name: "ตรวจสอบ" }).click();
    await expect(dialog.getByText("ยืนยันข้อมูล")).toBeVisible();
    await expect(dialog.getByText(fullName)).toBeVisible();
    await expect(dialog.getByText(studentId)).toBeVisible();
    await expect(dialog.getByText("จะลงทะเบียนและเช็คอินทันที")).toBeVisible();

    // Step 2: commit → result screen shows success + checked-in (window is open → +points).
    await dialog.getByRole("button", { name: "ยืนยันบันทึก" }).click();
    await expect(dialog.getByText("บันทึกสำเร็จ")).toBeVisible();
    await expect(dialog.getByText(/เช็คอินแล้ว/)).toBeVisible();
    // student_id is highlighted on the result for later account-claiming.
    await expect(dialog.getByText(studentId)).toBeVisible();

    await dialog.getByRole("button", { name: "เสร็จสิ้น" }).click();
  });

  test("staff gate: duplicate student_id → friendly 'มีบัญชีอยู่แล้ว' error (no commit)", async ({
    page,
  }) => {
    // First commit creates the user; the second walk-in with the same student_id must hit user_exists.
    const studentId = `WD${Date.now()}`;

    await loginAs(page, QA.staff);
    await page.goto(`/staff/events/${eventId}/checkin`);

    // First: create the user successfully.
    await page.getByRole("button", { name: "เพิ่ม Walk-in" }).click();
    let dialog = page.getByRole("dialog");
    await fillWalkinForm(page, { fullName: "ซ้ำ หนึ่ง", studentId, reason: "ครั้งแรก" });
    await dialog.getByRole("button", { name: "ตรวจสอบ" }).click();
    await dialog.getByRole("button", { name: "ยืนยันบันทึก" }).click();
    await expect(dialog.getByText("บันทึกสำเร็จ")).toBeVisible();
    await dialog.getByRole("button", { name: "เสร็จสิ้น" }).click();

    // Second: same student_id → user_exists surfaces as the friendly Thai message on the form (not a crash).
    await page.getByRole("button", { name: "เพิ่ม Walk-in" }).click();
    dialog = page.getByRole("dialog");
    await fillWalkinForm(page, { fullName: "ซ้ำ สอง", studentId, reason: "ครั้งที่สอง" });
    await dialog.getByRole("button", { name: "ตรวจสอบ" }).click();
    await expect(dialog.getByText(/มีบัญชีอยู่แล้ว/)).toBeVisible();
    // Still on the form (no confirm screen) — nothing was committed.
    await expect(dialog.getByText("ยืนยันข้อมูล")).toHaveCount(0);
  });

  test("admin desk: ตรวจสอบ → ยืนยันบันทึก → 'ลงทะเบียนแล้ว (ยังไม่เช็คอิน)'", async ({ page }) => {
    const studentId = `WA${Date.now()}`;
    const fullName = "เดสก์ แอดมิน";

    await loginAs(page, QA.admin);
    await page.goto(`/admin/events/${eventId}/registrations`);

    // Same dialog, opened with checkinNow=false from the registrations desk.
    await page.getByRole("button", { name: "เพิ่มผู้เข้าร่วมใหม่" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("เพิ่มผู้เข้าร่วมใหม่")).toBeVisible();

    await fillWalkinForm(page, { fullName, studentId, reason: "ลงทะเบียนล่วงหน้า e2e" });

    // Source dropdown shows only on the admin desk — override the default Walk-in to ปกติ (normal).
    await dialog.getByRole("combobox").click();
    await page.getByRole("option", { name: "ปกติ" }).click();

    // Confirm screen states register-only (no check-in).
    await dialog.getByRole("button", { name: "ตรวจสอบ" }).click();
    await expect(dialog.getByText("ยืนยันข้อมูล")).toBeVisible();
    await expect(dialog.getByText("จะลงทะเบียนเท่านั้น (ยังไม่เช็คอิน)")).toBeVisible();

    // Result = registered, not checked in.
    await dialog.getByRole("button", { name: "ยืนยันบันทึก" }).click();
    await expect(dialog.getByText("บันทึกสำเร็จ")).toBeVisible();
    await expect(dialog.getByText("ลงทะเบียนแล้ว (ยังไม่เช็คอิน)")).toBeVisible();

    await dialog.getByRole("button", { name: "เสร็จสิ้น" }).click();
  });
});
