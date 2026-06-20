import { test, expect } from "@playwright/test";
import { QA, loginAs } from "./helpers";

// The headline new feature: a grant QR is re-displayable, and re-creating an identical
// unscanned QR reuses it (no extra budget spent) instead of minting a new token.
test.describe("staff grant QR: reuse on re-create + re-display from list", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, QA.staff);
    await page.goto("/staff/points");
    await expect(page.getByText("งบแต้มคงเหลือ")).toBeVisible();
  });

  test("re-creating an identical unscanned QR reuses it (toast, no debit)", async ({ page }) => {
    await page.locator("#grant-value").fill("7");
    await page.locator("#grant-claims").fill("1");

    // First create → QR dialog opens.
    await page.getByRole("button", { name: "สร้าง QR", exact: true }).click();
    await expect(page.getByText(/QR แต้ม \(/)).toBeVisible();
    await page.getByRole("button", { name: "เสร็จสิ้น" }).click();

    // Second identical create → reuse path: info toast + same QR re-shown (budget not debited again).
    await page.getByRole("button", { name: "สร้าง QR", exact: true }).click();
    await expect(page.getByText("ใช้ QR เดิมที่ยังไม่ถูกสแกน (ไม่หักงบเพิ่ม)")).toBeVisible();
    await expect(page.getByText(/QR แต้ม \(/)).toBeVisible();
    await page.getByRole("button", { name: "เสร็จสิ้น" }).click();
  });

  test('"ดู QR" re-displays an existing token from the list', async ({ page }) => {
    // Ensure at least one token exists in the list.
    await page.locator("#grant-value").fill("8");
    await page.locator("#grant-claims").fill("1");
    await page.getByRole("button", { name: "สร้าง QR", exact: true }).click();
    await expect(page.getByText(/QR แต้ม \(/)).toBeVisible();
    await page.getByRole("button", { name: "เสร็จสิ้น" }).click();

    // Re-open the same QR from the "QR ที่สร้างไว้" list — no new token.
    await page.getByRole("button", { name: "ดู QR" }).first().click();
    await expect(page.getByText(/QR แต้ม \(/)).toBeVisible();
    await expect(page.getByRole("button", { name: "คัดลอกโทเค็น" })).toBeVisible();
  });
});
