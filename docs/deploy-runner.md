# Prod deploy via self-hosted GitHub Actions runner

Manual-only deploy for `lawkku23freshmenfreshstart` (eticket). **Prod is live with real users** — deploy fires only when you dispatch it by hand.

## Why a second runner

The prod box already runs a runner, but it is **repo-scoped** to `siravidthongsook/interactivelearning` (`agentName: itl-prod`). A repo-scoped runner serves only its one repo, and `siravidthongsook` is a personal account (no org-level runners). So eticket needs its **own runner instance** on the same box.

Both runners coexist: separate dirs, separate services, separate labels.

| | ITL runner (existing) | eticket runner (new) |
|---|---|---|
| dir | `/home/siravid/actions-runner` | `/home/siravid/actions-runner-eticket` |
| repo | `interactivelearning` | `lawkku23freshmenfreshstart` |
| label | (default) | `eticket` ← workflow targets this |

The workflow's `runs-on: [self-hosted, eticket]` is what keeps eticket deploys off the ITL runner.

---

## One-time setup (run ON the prod box)

> Token is short-lived (~1h) and per-repo. Grab a fresh one right before configuring.

1. **Get a runner registration token**
   GitHub → repo `lawkku23freshmenfreshstart` → Settings → Actions → Runners → **New self-hosted runner** (Linux x64). Copy the token from the `./config.sh ... --token <TOKEN>` line.

2. **Lay down a separate runner instance** (reuse the already-downloaded tarball — same version 2.323.0):
   ```bash
   mkdir -p /home/siravid/actions-runner-eticket
   cd /home/siravid/actions-runner-eticket
   tar xzf /home/siravid/actions-runner/actions-runner-linux-x64-2.323.0.tar.gz
   ```

3. **Configure** (non-interactive; `eticket` label is mandatory):
   ```bash
   ./config.sh \
     --url https://github.com/siravidthongsook/lawkku23freshmenfreshstart \
     --token <TOKEN> \
     --name eticket-prod \
     --labels eticket \
     --work _work \
     --unattended
   ```

4. **Install as a systemd service** (survives reboot/logout — unlike the ITL one which runs under a bare `run.sh`):
   ```bash
   sudo ./svc.sh install siravid
   sudo ./svc.sh start
   sudo ./svc.sh status
   ```

5. **Confirm** runner shows **Idle** in repo Settings → Actions → Runners.

---

## Backups (automated by the deploy workflow)

The deploy job runs `scripts/db-backup.sh <sha>` before touching anything. It writes two files into
`~/eticket-backups/`, both tagged with the **current commit SHA** so each snapshot self-identifies
the code it pairs with:

- `db-<TS>-<SHA>.sql.gz` — `pg_dump --clean --if-exists` (restorable over a live DB), gzip-validated + size-checked.
- `storage-<TS>-<SHA>.tar.gz` — tar of the `eticket_storage` volume, gzip + tar validated.

It keeps the newest **20** of each prefix and prunes the rest on every run. Backup is
belt-and-suspenders: drizzle migrate is atomic per run, so a *failed* migrate needs no restore —
restore is only for a *bad-but-succeeded* migration.

Manual one-off backup:
```bash
cd /home/siravid/projects/eticket
bash scripts/db-backup.sh "$(git rev-parse --short HEAD)"
```

## Deploying

Manual only:

- GitHub → repo → **Actions** → **Deploy prod (manual)** → **Run workflow**.
- `confirm`: type `DEPLOY` (anything else aborts — guard against accidental clicks).
- `services` (optional): blank = rebuild all; or `api`, `web`, `web api` to scope.

New ordered sequence on the box (in `/home/siravid/projects/eticket`):
```
1. capture FROM_SHA (live commit, before pull)
2. partial-deploy guard: block a `services` subset that excludes `api` if migrations are pending
3. backup DB + storage (scripts/db-backup.sh)
4. retag current images :latest -> :prev (for instant code-only rollback)
5. git fetch/checkout/pull --ff-only main  -> TO_SHA
6. docker compose build [services]          # build ONLY, prod still serving old
7. docker compose run --rm api pnpm db:migrate   # explicit one-shot, atomic; fail -> abort, no recreate
8. docker compose up -d [services]          # recreate (brief downtime accepted)
9. verify: /ready (DB-backed) + web root, container State check
10. on step 8/9 failure -> code-only auto-rollback (see below)
```

**Migrations no longer run on container boot** — the Dockerfile CMD is `pnpm start` only.
Migration is the explicit step 7. It runs **before** recreate so a migrate failure aborts with
nothing recreated: the old app keeps serving old code on the still-intact schema. Steps 6+7 stay
coupled so we never migrate against a stale image. `concurrency: prod-deploy` blocks overlapping runs.

> `--ff-only`: if the deploy clone has local commits/uncommitted changes, pull fails fast instead of merging. If that happens, SSH in and reconcile by hand.

Migrations must be **expand-only** to keep auto-rollback safe — see `docs/migrations-policy.md`.

---

## Rollback

### Automatic (code-only, during a deploy)
If **recreate or verify** fails (step 8/9), the deploy job auto-rolls-back: `git checkout <FROM_SHA>`,
retag `:prev -> :latest`, `docker compose up -d --no-build`, re-verify, then **fails loudly**.
It is **code-only** by design — the DB is NOT auto-restored (restore overwrites rows since the backup;
that's destructive and must be a deliberate choice). A migrate failure (step 7) just aborts and needs
no rollback (schema untouched, old app still serving).

> After any rollback the bad commit is **still on origin/main** — `git revert` it before the next
> deploy or it will re-ship.

### Manual (code + optional DB restore) — `rollback.yml`
For a bad migration that *succeeded* and now needs the pre-deploy DB snapshot:

- GitHub → **Actions** → **Rollback prod (manual)** → **Run workflow**.
- `to_sha` (required): the known-good commit.
- `restore_db` (bool): also restore the DB (DESTRUCTIVE — overwrites current data).
- `db_backup_file` (required if restore_db): e.g. `/home/siravid/eticket-backups/db-<TS>-<SHA>.sql.gz`.
- `storage_backup_file` (optional): matching `storage-<TS>-<SHA>.tar.gz`.
- `confirm`: type `ROLLBACK`.

It checks out `to_sha` (**detached HEAD**), optionally runs `scripts/db-restore.sh`
(single-transaction + `ON_ERROR_STOP=1`, so a failed restore rolls back), then `up -d --build`
(rollback target may have no prebuilt image) and verifies `/ready` + web.

> **Caveat:** prod is left at a **detached HEAD** and `origin/main` is unchanged. Revert the bad
> commit on `origin/main`, then return to normal later:
> `git checkout main && git pull --ff-only && docker compose up -d --build`.

### Residual risk
Backups are **on-box only** (`~/eticket-backups`). If the box's disk dies they're gone with prod.
Off-box backup is the #1 documented follow-up risk — not built in V1.

## Ops

```bash
cd /home/siravid/actions-runner-eticket
sudo ./svc.sh status      # check
sudo ./svc.sh stop        # pause deploys
sudo ./svc.sh start       # resume

# Remove runner entirely (needs a fresh removal token from repo settings):
sudo ./svc.sh uninstall
./config.sh remove --token <REMOVAL_TOKEN>
```

Runner logs: `journalctl -u actions.runner.siravidthongsook-lawkku23freshmenfreshstart.eticket-prod.service -f`
(exact unit name printed by `svc.sh install`).
