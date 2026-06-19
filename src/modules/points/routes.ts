import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AppVariables } from "../../lib/context";
import { requireAuth } from "../../lib/auth-middleware";
import { getBalance, listUserLedger, serializeLedgerEntry } from "./service";

const router = new Hono<{ Variables: AppVariables }>();

// Pagination — consistent with other list endpoints (audit-logs uses the same shape).
const ledgerQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// GET /me/points — own balance + paginated ledger history (newest first). Reads own data only.
router.get("/me/points", requireAuth, zValidator("query", ledgerQuery), async (c) => {
  const user = c.get("user");
  const { limit, offset } = c.req.valid("query");
  const [balance, page] = await Promise.all([
    getBalance(user.id),
    listUserLedger(user.id, limit, offset),
  ]);
  return c.json({
    balance,
    history: page.rows.map(serializeLedgerEntry),
    total: page.total,
    limit,
    offset,
  });
});

export default router;
