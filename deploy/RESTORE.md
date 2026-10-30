# Restoring the database from a backup

ADR 0008 section 6. The backup service writes one encrypted `pg_dump` a day to the backup bucket:
`postgres/<stage>/YYYY/MM/shotx-<stage>-<UTC time>.dump.age`, with a `.sha256` file next to it.
The recovery point is up to 24 hours (open question 1 in ADR 0008). Everything written after the
dump is lost and must be recovered or reconciled (step 6).

You need:

- the **age private key** (`key.txt`), kept offline by the owner. It never goes to the VPS. You
  decrypt on your own machine and stream the plain dump to the VPS over SSH;
- a **read token** for the backup bucket. The VPS token can read too, but use your own;
- SSH to the VPS, and the `env/` files that are on it.

Set `C="docker compose --env-file .env.production"` in `deploy/` on the VPS.

## 1. Stop writes

```sh
$C stop proxy web api worker backup     # postgres, redis and monitor keep running
```

Note the incident time **T** (UTC) and tell the owner. The maintenance page is the uptime
check's down state; there is no separate page.

## 2. Pick and fetch the dump

Pick the newest dump older than the damage (for corruption: the last one before it started).
Then, on your machine:

```sh
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...    # backup bucket read token
E=https://<account-id>.r2.cloudflarestorage.com
K=postgres/prod/2026/11/shotx-prod-20261102T190004Z.dump.age
aws s3 cp --endpoint-url $E s3://shotx-prod-backups/$K .
aws s3 cp --endpoint-url $E s3://shotx-prod-backups/$K.sha256 .
sha256sum -c "$(basename $K).sha256"                      # must say OK
```

The dump's time is in its name. Call it **D**: everything between D and T is the lost window.

## 3. Copy the decrypted dump to the VPS

The plain dump holds personal data. It exists only in the SSH stream and in a 0700 directory on
the VPS's encrypted volume, and is deleted in step 7.

```sh
ssh vps 'install -d -m 700 ~/restore'
age -d -i key.txt "$(basename $K)" | ssh vps 'cat > ~/restore/db.dump && chmod 600 ~/restore/db.dump'
```

## 4. Restore into a fresh database

On the VPS. Keep the damaged database under another name until the restore is verified. The
superuser is `POSTGRES_USER` from `env/postgres.env`. The extension entries are left out of the
restore list: ltree, pg_trgm and vector are created by the superuser (`shotx` may not create
pgvector, and can't restore the extensions' comments).

```sh
PG="$C exec -T postgres"
$PG psql -U shotx_admin -d postgres -v ON_ERROR_STOP=1 \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'shotx' AND pid <> pg_backend_pid()" \
  -c 'ALTER DATABASE shotx RENAME TO shotx_damaged' \
  -c 'CREATE DATABASE shotx OWNER shotx' \
  -c 'REVOKE ALL ON DATABASE shotx FROM PUBLIC' \
  -c 'GRANT CONNECT ON DATABASE shotx TO shotx, shotx_monitor'
$PG psql -U shotx_admin -d shotx -v ON_ERROR_STOP=1 \
  -c 'CREATE EXTENSION ltree' -c 'CREATE EXTENSION pg_trgm' -c 'CREATE EXTENSION vector'
$PG sh -c 'cat > /tmp/db.dump' < ~/restore/db.dump
$PG sh -c "pg_restore --list /tmp/db.dump | grep -vE ' EXTENSION - | COMMENT - EXTENSION ' > /tmp/toc.list"
$PG pg_restore -U shotx --exit-on-error --single-transaction --no-owner --role=shotx \
  -L /tmp/toc.list -d shotx /tmp/db.dump
$PG rm /tmp/db.dump /tmp/toc.list
```

Then bring the schema up to the deployed code (the dump may be older) and re-apply the monitor's
grants:

```sh
$C run --rm migrate
```

## 5. Queues

BullMQ lives in Redis, which a database restore doesn't touch.

- **Redis survived:** leave it. Jobs that point at rows from the lost window fail and stay in the
  failed set; the monitor reports them (`queue.<name>.failed`). Review them, then clear them.
  Scheduled jobs re-run safely: the ledger lost its entries after D, and every job is
  idempotent.
- **Redis lost too:** start with an empty Redis (`$C rm -sf redis && docker volume rm
shotx_redis-data`). Lost media and face work comes back through `media.sweep` and `faces.sweep`.

## 6. Reconcile the lost window (D to T)

Start the worker only (no traffic yet), then run the reconciliations now, without waiting for
their schedules:

```sh
$C up -d worker
$C --profile tools run --rm run-job quota.reconcile.nightly
$C --profile tools run --rm run-job media.sweep
$C --profile tools run --rm run-job faces.sweep
$C --profile tools run --rm run-job faces.reconcile.daily
```

- **Payments:** charges made in the lost window are in the gateway, not in `payments`. In the
  gateway dashboard (Omise/Opn: Charges and Events) list everything after D. Where the gateway can
  re-deliver webhooks, re-deliver the events after D: the webhook handler verifies and upserts by
  `(gateway, gateway_ref)`, so replays are safe. Where it can't, an admin must apply each missing
  charge by hand. There is no tool for that yet (contract change request: a payment re-sync
  command). Check subscriptions that renewed in the window.
- **Quota and media:** `quota.reconcile.nightly` recomputes `storage_usage` from the restored rows
  and **reports** objects under `originals/` that have no row. Those are photos uploaded in the lost
  window; nothing deletes them. List them from the worker log (`orphanObjects`). Then tell the
  affected photographers to upload again, or delete the objects once they confirm. Never
  bulk-delete them without asking.
- **Faces:** `faces.reconcile.daily` deletes collection faces that have no row (photos indexed in
  the window), once `FACE_ORPHAN_GRACE_MS` has passed. `faces.sweep` re-sends restored face
  deletions that are not complete.
- **Face vectors (FACE_PROVIDER=self-hosted):** backups hold no `face_vectors` data (ADR 0009
  section 6), so restored `faces` rows point at nothing and search finds no restored photo. Before
  the `faces.sweep` above, forget them so the sweep indexes every covered photo again. **First
  withhold again every photo a "ขอลบใบหน้าของฉัน" deletion touched in the lost window**: the
  restored database lost those `faces_withheld_at` marks, and re-indexing would bring the deleted
  faces back. The worker logs each completed deletion as `face deletion done` with
  `withheldFileIds` (comma-separated file ids, no biometrics). Collect them from the worker logs
  after D (`docker logs` on the VPS if it survived, or your log store), then, in `psql` as
  `shotx`, until a re-index tool exists:

  ```sql
  BEGIN;
  -- 1. The lost window's deletions: the file ids from the log lines, one list for all of them.
  UPDATE files SET faces_withheld_at = now()
    WHERE id = ANY('{<id>,<id>,...}'::uuid[]) AND faces_withheld_at IS NULL;
  -- 2. Forget the vector-less faces (pending deletions keep their rows) and re-index the rest.
  DELETE FROM faces WHERE deletion_id IS NULL;
  UPDATE files SET face_count = NULL, faces_queued_at = NULL
    WHERE face_count IS NOT NULL AND faces_withheld_at IS NULL
      AND id NOT IN (SELECT file_id FROM faces);
  COMMIT;
  ```

  If the worker logs for the window are lost too (likely on one VPS, with the api's), nothing
  names the deletions that were lost: **don't run step 2 at all** until the DPO has decided.
  Search then finds no restored photo, which is the safe side; photos uploaded after the restore
  are indexed as usual.

- **PDPA, lost face deletions and consent withdrawals:** a "ขอลบใบหน้าของฉัน" request or a consent
  withdrawal made in the window is gone from the database. With Rekognition, faces deleted before
  T stay deleted (the collection is outside the database). With the self-hosted provider the
  vectors are gone with the backup anyway, and the withholding step above keeps the deleted faces
  from being indexed again. Either way a request still pending at T was lost. Count the worker's
  `face deletion done` lines after D (if the logs survived) and tell the DPO. The people concerned
  must be asked to send their request again; the selfie is never stored, so it can't be
  replayed.

## 7. Open, verify, clean up

```sh
$C up -d
$C ps
$C logs --tail 50 api worker
```

- The external uptime check is green, and `monitor` sends no `monitor.*` alert.
- Sign in as an admin. Open a share, scan a face, download a file.
- Delete the plain dump: `shred -u ~/restore/db.dump && rmdir ~/restore`. Delete your local
  copies of the dump and `key.txt` access as your key policy requires.
- After a week without problems: `$PG psql -U shotx_admin -d postgres -c 'DROP DATABASE shotx_damaged'`.
- Write the incident report: D, T, the payments re-synced, orphan objects, face deletions
  re-requested.

## Restore test (before launch, then every quarter)

The backup is only as good as the last restore that worked. On a **separate** machine or a staging
VPS, never the production database:

1. Start `postgres` from this compose file with fresh `env/postgres.env` passwords.
2. Fetch, verify and decrypt the newest dump as in steps 2–3, and restore it as in step 4.
3. Run `$C run --rm migrate`. It must report the migrations up to date, or apply only the newer
   ones.
4. Check the counts against production at the dump time: `plans`, `users`, `files`, `shares`,
   `payments`. Check that `SELECT max(created_at) FROM activity_events` is just before D.
5. Record the duration of each step. The total is the recovery time the owner should expect
   (ADR 0008 open question 1).
6. Delete the test database, the plain dump and the downloaded files.

This procedure was rehearsed on 2026-10-27 against a local stack, with MinIO standing in for R2.
That run covered the backup service's upload, the sha256 check, age decryption, and
`pg_restore --list`/`-L`/`--single-transaction` into a fresh database (8 migrations, 5 plans).
It still has to be run against real R2.
