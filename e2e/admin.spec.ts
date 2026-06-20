import { test, expect } from "@playwright/test";
import { QA, loginAs } from "./helpers";

test.describe("admin: settings, staff budget topup, leaderboard export", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, QA.admin);
  });

  test("point settings render with defaults", async ({ page }) => {
    await page.goto("/admin/point-settings");
    await expect(page.getByText("ตั้งค่าแต้ม")).toBeVisible();
    await expect(page.getByText("เวลาตัดยอด (Cutoff)")).toBeVisible();
    await expect(page.getByText("ค่าแต้มเริ่มต้น")).toBeVisible();
  });

  test("topup QA Staff budget via dialog → success toast", async ({ page }) => {
    await page.goto("/admin/staff/budget");
    // Find the QA Staff row and open its top-up dialog.
    const row = page.locator("tr", { hasText: "QA Staff" });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "เติม", exact: true }).click();

    // TopupDialog: pick a preset, give a reason, confirm (scope to the dialog).
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "+5", exact: true }).click();
    await dialog.getByRole("textbox").last().fill("e2e topup");
    await dialog.getByRole("button", { name: /^เติม/ }).click();
    await expect(page.getByText(/เติมงบ \+5 ให้ QA Staff/)).toBeVisible();
  });

  test("leaderboard shows admin CSV export button + ranked students", async ({ page }) => {
    await page.goto("/leaderboard");
    await expect(page.getByRole("button", { name: /ส่งออก CSV/ })).toBeVisible();
    await expect(page.getByText("QA Student Two")).toBeVisible();
  });
});
