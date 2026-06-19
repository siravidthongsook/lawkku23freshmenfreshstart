import { describe, expect, it } from "vitest";
import { request } from "./helpers/db";
import { loginAs } from "./helpers/auth";

// Proves the whole harness: app boots, DB resets, seedUser + real login flow yields a
// cookie that authenticates a protected endpoint.
describe("test harness smoke", () => {
  it("GET /health returns ok", async () => {
    const res = await request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("seedUser + loginAs(admin) yields a cookie that authenticates /auth/me", async () => {
    const { user, cookie } = await loginAs("admin");
    expect(cookie).toContain("="); // name=value

    const res = await request("/auth/me", { cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string; role: string } };
    expect(body.user.id).toBe(user.id);
    expect(body.user.role).toBe("admin");
  });

  it("without a cookie, /auth/me is rejected", async () => {
    const res = await request("/auth/me");
    expect(res.status).toBe(401);
  });
});
