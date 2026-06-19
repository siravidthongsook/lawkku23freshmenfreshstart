# Migrations policy — EXPAND-ONLY (for safe auto-rollback)

The deploy workflow migrates the DB **before** recreating containers, and its auto-rollback is
**code-only** (it reverts code to the previous SHA but does NOT restore the DB — see
`docs/deploy-runner.md`). That only stays safe if every migration is **expand-only**: the OLD code
(the rollback target) must still run correctly against the NEW schema.

If a migration is expand-only, then after auto-rollback the old app keeps working on the migrated
schema — no DB restore needed. A non-expand-only migration breaks that guarantee and forces a manual
`rollback.yml` run with `restore_db=true` (destructive).

## Checklist — a migration must pass ALL of these to be auto-rollback-safe

- [ ] No new `NOT NULL` column **without a default** (old-code inserts omit it → write fails).
- [ ] No new `UNIQUE` / `CHECK` / `FK` constraint that existing old-code writes could violate.
- [ ] No enum value **removal** (old code may still emit it).
- [ ] No type **narrowing** (e.g. `text` → `varchar(n)`, widening `int` → `bigint` is fine).
- [ ] No column/table **drop or rename** in the **same deploy** as the code that needs the change.
- [ ] No `CREATE INDEX CONCURRENTLY` — it can't run inside a transaction and breaks the atomic
      per-run migrate (drizzle runs each migration in a tx). Use a plain `CREATE INDEX`.

## Contract (the destructive half) = a separate later deploy

Drops, renames, and tightening constraints are **contract** changes. Ship them only **after** the new
code has been stable in prod for a while, in a **separate** deploy — never coupled with the code that
introduced the replacement. Pattern: expand (deploy N) → migrate code to new shape → contract (deploy N+1).
