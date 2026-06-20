import { test, expect } from "@playwright/test";
import { QA, loginAs } from "./helpers";

test.describe("student: wallet, ledger detail, connect QR, leaderboard", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, QA.student1);
  });

  test("wallet shows balance + history + rank, row opens its detail", async ({ page }) => {
    await page.goto("/me/points");
    await expect(page.getByText("กระเป๋าแต้มของฉัน")).toBeVisible();
    await expect(page.getByText("แต้มสะสมทั้งหมด")).toBeVisible();
    await expect(page.getByText(/อันดับที่/)).toBeVisible();

    // History row → ledger detail.
    const firstEntry = page.locator('a[href^="/me/points/"]').first();
    await expect(firstEntry).toBeVisible();
    await firstEntry.click();
    await expect(page).toHaveURL(/\/me\/points\/[0-9a-f-]{36}/);
  });

  test("connect page shows my re-displayable QR", async ({ page }) => {
    await page.goto("/me/connect");
    await expect(page.getByText("QR ของฉัน")).toBeVisible();
    await expect(page.getByText(/\+5 แต้ม/)).toBeVisible();
    await expect(page.locator("svg").first()).toBeVisible(); // QRCodeSVG
  });

  test("leaderboard shows my-rank strip and highlights my row", async ({ page }) => {
    await page.goto("/leaderboard");
    await expect(page.getByText("อันดับของคุณ")).toBeVisible();
    await expect(page.getByText("QA Student One")).toBeVisible();
  });
});
