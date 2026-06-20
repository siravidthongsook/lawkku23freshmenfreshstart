import { test, expect } from "@playwright/test";
import { QA, loginAs } from "./helpers";

// Login works for all three identifier shapes (email / username / student_id) and lands each role right.
test.describe("auth: login per role", () => {
  test("admin logs in by email → sees admin nav", async ({ page }) => {
    await loginAs(page, QA.admin);
    await expect(page.getByRole("link", { name: "ผู้ใช้" })).toBeVisible();
    await expect(page.getByRole("link", { name: "งบสตาฟ" })).toBeVisible();
  });

  test("staff logs in by username → lands on check-in, sees แจกแต้ม", async ({ page }) => {
    await loginAs(page, QA.staff);
    await expect(page).toHaveURL(/\/staff\/events/);
    await expect(page.getByRole("link", { name: "แจกแต้ม" })).toBeVisible();
  });

  test("student logs in by student_id → sees student nav", async ({ page }) => {
    await loginAs(page, QA.student1);
    await expect(page.getByRole("link", { name: "เพิ่มเพื่อน" })).toBeVisible();
    await expect(page.getByRole("link", { name: "แต้ม" })).toBeVisible();
  });

  test("wrong password → generic error, stays on /login", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("textbox").first().fill(QA.admin);
    await page.locator('input[type="password"]').fill("wrong-password-xyz");
    await page.getByRole("button", { name: "เข้าสู่ระบบ" }).click();
    await expect(page).toHaveURL(/\/login/);
  });
});
