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

## Backup DB before every deploy

Filename bakes in the **current commit SHA** so each snapshot self-identifies the code it pairs with; `--clean` makes the dump restorable over a live DB.

```bash
cd /home/siravid/projects/eticket
SHA=$(git rev-parse --short HEAD)
docker compose exec -T db pg_dump -U lawkku_freshstart23 --clean --if-exists lawkku_freshstart23 \
  | gzip > ~/eticket-db-backup-$(date +%Y%m%d-%H%M%S)-$SHA.sql.gz
```

## Deploying

Manual only:

- GitHub → repo → **Actions** → **Deploy prod (manual)** → **Run workflow**.
- `confirm`: type `DEPLOY` (anything else aborts — guard against accidental clicks).
- `services` (optional): blank = rebuild all; or `api`, `web`, `web api` to scope.

What it does on the box (in `/home/siravid/projects/eticket`):
```
git fetch origin main && git checkout main && git pull --ff-only origin main
docker compose up -d --build [services]
docker compose ps
```
api auto-runs `pnpm db:migrate` on boot. `concurrency: prod-deploy` blocks overlapping runs.

> `--ff-only`: if the deploy clone has local commits/uncommitted changes, pull fails fast instead of merging. If that happens, SSH in and reconcile by hand.

---

## Rollback

Each backup is named `…-<TS>-<SHA>.sql.gz` — `<SHA>` = the code commit live when it was taken. Roll **code + DB** back together:

```bash
cd /home/siravid/projects/eticket
# 1. code
git checkout <SHA>              # detached at the good commit
docker compose up -d --build    # rebuild old images
# 2. DB (only if the new migration actually broke things — overwrites data since backup)
gunzip -c ~/eticket-db-backup-<TS>-<SHA>.sql.gz \
  | docker compose exec -T db psql -U lawkku_freshstart23 -d lawkku_freshstart23
```

Code-only rollback is enough when the schema is still compatible. Back to normal later:
`git checkout main && git pull --ff-only && docker compose up -d --build`.

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
