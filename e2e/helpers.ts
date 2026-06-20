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
