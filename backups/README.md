# Database backups

`scripts/backup-databases.sh` creates one timestamped directory containing:

- `globals.sql`, with PostgreSQL roles but without role password hashes;
- one custom-format dump for `nuvopic_control`;
- one custom-format dump per `nuvopic_ws_*` database; and
- `SHA256SUMS` for archive integrity checks.

The default destination is `/var/backups/nuvopic`, outside the source checkout.
Create it with ownership restricted to the backup operator, or set
`BACKUP_ROOT` to a protected mounted backup volume:

```sh
BACKUP_ROOT=/mnt/nuvopic-backups ./scripts/backup-databases.sh
```

These files are outside the source checkout, but they are not encrypted by the
script. They contain user, workspace, and application data. Encrypt each backup
and copy it to a different provider or failure domain immediately. Do not rely
on the PostgreSQL Docker volume as a backup.

The `SETTINGS_KEK`, database passwords, signing key, and service tokens are not
included. Keep a separately encrypted, access-controlled copy of `.env`. A
database restore without the original `SETTINGS_KEK` cannot decrypt stored S3
and webhook secrets.

Validate an archive without restoring it:

```sh
(cd /var/backups/nuvopic/20260728T010000Z && sha256sum -c SHA256SUMS)
docker compose exec -T postgres pg_restore --list \
  < /var/backups/nuvopic/20260728T010000Z/nuvopic_control.dump >/dev/null
```

Restores are intentionally restricted to dedicated databases whose names end
in `_restore_NAME`. Create one, restore into it, test it, and only then consider
changing a route:

```sh
docker compose exec -T postgres createdb \
  -U nuvopic_admin -O nuvopic_control nuvopic_control_restore_drill
RESTORE_CONFIRM=nuvopic_control_restore_drill \
RESTORE_OWNER=nuvopic_control \
  ./scripts/restore-database.sh \
  /var/backups/nuvopic/20260728T010000Z/nuvopic_control.dump \
  nuvopic_control_restore_drill
```

Never point production at an unverified restore. Record archive checks,
application smoke-test results, elapsed restore time, and the operator in the
restore-drill log.
