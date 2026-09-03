# RUNBOOK — Database Backup & Restore

Audience: anyone operating a WaterSim Pro deployment.
Last updated: 2026-09-03.

The only stateful component is PostgreSQL (`postgres_data` volume / `pgdata`
PVC). Everything else is rebuilt from images. **If the database is lost and
there is no dump, the data is gone** — keep backups running from day one.

---

## 1. How backups run

### Docker Compose deployment

`scripts/backup.sh` takes a `pg_dump` (custom format, compressed) through
`docker compose exec postgres`, writes it to `./backups/watersim-<timestamp>.dump`,
and prunes dumps older than `RETENTION_DAYS` (default 14).

Install it as a nightly cron on the host:

```bash
crontab -e
# nightly at 02:30
30 2 * * * cd /srv/watersim && ./scripts/backup.sh >> backups/backup.log 2>&1
```

Manual run: `./scripts/backup.sh` (optional arg = output dir; env overrides:
`RETENTION_DAYS`, `COMPOSE_FILE`, `ENV_FILE`).

### Kubernetes deployment

`k8s/backup-cronjob.yaml` — a `CronJob` (`pg-backup`, nightly 02:30, cluster
timezone) runs `pg_dump --format=custom` against the `postgres` service using
the password from the `watersim-secrets` Secret, writes to the `pg-backups`
PVC (20 Gi), and prunes dumps older than `RETENTION_DAYS` (14). Check on it:

```bash
kubectl -n watersim get cronjob pg-backup
kubectl -n watersim get jobs -l app=pg-backup   # via job-name label if needed
kubectl -n watersim logs job/<latest pg-backup job>
```

> **Offsite copies:** a PVC (or a directory on the same host) does not survive
> cluster/host loss. The CronJob manifest contains a commented S3 upload swap
> (`aws s3 cp …`); for the compose host, sync `./backups/` offsite, e.g.
> `rclone sync backups/ remote:watersim-backups` from the same cron.

Both paths produce the **same artifact**: a `pg_restore`-compatible custom-format
dump named `watersim-YYYYMMDD-HHMMSS.dump`.

## 2. Restore — Docker Compose

`scripts/restore.sh` is **destructive**: it terminates connections, drops and
recreates the DB, restores the dump, then prints a table count. It refuses to
proceed until you type the database name.

```bash
cd /srv/watersim
docker compose --env-file .env.prod -f docker-compose.prod.yml stop backend   # stop writers
./scripts/restore.sh backups/watersim-20260903-023000.dump
docker compose --env-file .env.prod -f docker-compose.prod.yml run --rm migrate  # only if the dump predates the current schema
docker compose --env-file .env.prod -f docker-compose.prod.yml start backend
```

## 3. Restore — Kubernetes

```bash
# 1. stop writers
kubectl -n watersim scale deploy/backend --replicas=0

# 2. copy the dump out of the backup PVC via a throwaway pod
kubectl -n watersim run pg-restore --rm -it --image=postgres:16-alpine \
  --overrides='{"spec":{"containers":[{"name":"pg-restore","image":"postgres:16-alpine",
    "stdin":true,"tty":true,"command":["sh"],
    "env":[{"name":"PGPASSWORD","valueFrom":{"secretKeyRef":{"name":"watersim-secrets","key":"POSTGRES_PASSWORD"}}}],
    "volumeMounts":[{"name":"backups","mountPath":"/backups"}]}],
    "volumes":[{"name":"backups","persistentVolumeClaim":{"claimName":"pg-backups"}}]}}'

# 3. inside that pod:
ls -lh /backups
psql -h postgres -U watersim -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='watersim_prod' AND pid<>pg_backend_pid();"
psql -h postgres -U watersim -d postgres -c 'DROP DATABASE IF EXISTS watersim_prod;'
psql -h postgres -U watersim -d postgres -c 'CREATE DATABASE watersim_prod OWNER watersim;'
pg_restore -h postgres -U watersim -d watersim_prod --no-owner --role=watersim \
  --exit-on-error /backups/watersim-<timestamp>.dump
exit

# 4. bring the API back
kubectl -n watersim scale deploy/backend --replicas=2
kubectl -n watersim rollout status deploy/backend
```

(The `pg-backup` pod label used by the throwaway pod is not required — the
NetworkPolicy allows `app in (backend, migrate, pg-backup)` to reach postgres;
add `--labels app=pg-backup` to the `kubectl run` if your CNI enforces it.)

## 4. Restore drill (run quarterly; ~15 min)

Verify a backup actually restores WITHOUT touching production data — restore
into a scratch database:

```bash
cd /srv/watersim
LATEST=$(ls -t backups/watersim-*.dump | head -1) && echo "$LATEST"

# 1. create a scratch DB
docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres \
  psql -U watersim -d postgres -c 'DROP DATABASE IF EXISTS watersim_drill;'
docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres \
  psql -U watersim -d postgres -c 'CREATE DATABASE watersim_drill OWNER watersim;'

# 2. restore the newest dump into it
docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres \
  pg_restore -U watersim -d watersim_drill --no-owner --role=watersim --exit-on-error \
  < "$LATEST"

# 3. sanity checks — expect non-zero counts and a recent MAX(created_at)
docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres \
  psql -U watersim -d watersim_drill -c \
  "SELECT (SELECT count(*) FROM users)      AS users,
          (SELECT count(*) FROM projects)   AS projects,
          (SELECT count(*) FROM flowsheets) AS flowsheets,
          (SELECT max(created_at) FROM projects) AS newest_project;"

# 4. clean up
docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres \
  psql -U watersim -d postgres -c 'DROP DATABASE watersim_drill;'
```

Record the date, dump filename, and row counts in your ops log. A drill that
has never been run means the backups are unverified.

## 5. Failure modes & notes

| Situation | Action |
|---|---|
| Dump predates current schema | After restore, run migrations (`run --rm migrate` / `k8s/migrate-job.yaml`) |
| `pg_restore: error: … already exists` | You restored into a non-empty DB — drop/recreate first (the scripts do this) |
| Backup file is tiny / empty | Check `backup.log` or CronJob logs; scripts write `.partial` first and only rename on success, so a `.dump` file is always complete |
| Postgres major version upgrade | Custom-format dumps restore across majors; take a fresh dump immediately before upgrading |
| Whole host lost | Provision new host → first-time setup (RUNBOOK-deploy.md §3/§6) → copy the offsite dump over → §2 restore |
