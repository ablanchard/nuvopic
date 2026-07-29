# NuvoPic private-alpha VPS runbook

This runbook deploys the single-VPS topology at `https://nuvopic.app`. It is a
private-alpha baseline, not approval for public signup or paid service. The
unresolved P0 items in `../../../VPS_DEPLOYMENT_PLAN.md` remain launch blockers.

## Repository layout

The data and control repositories must be sibling checkouts because the base
Compose file builds both contexts:

```text
deployment-root/
├── nuvopic/
└── nuvopic-saas/
```

The control repository must provide root `Dockerfile` targets `runtime` and
`migration`. The data repository must provide the same targets in
`deploy/docker/Dockerfile`.

When the VPS already runs the shared Caddy project on the external `web`
network, include `compose.shared-caddy.yaml`. It disables the bundled Caddy
service, assigns stable network aliases to both application containers, and
applies conservative private-alpha resource limits. Append
`deploy/vps/Caddyfile.shared` to the shared proxy's Caddyfile, validate it, and
reload the existing Caddy container.

## Host preparation

Use a dedicated, patched Linux host with at least 4 vCPU, 8 GB RAM, and SSD
storage. Install Docker Engine with Compose v2. Create a non-root deployment
operator with narrowly scoped Docker access.

Before starting Caddy:

1. point the `A` and, if used, `AAAA` records for `nuvopic.app` at the VPS;
2. verify that public DNS returns only this host;
3. allow inbound TCP 22, 80, and 443 plus UDP 443;
4. restrict SSH by source address where possible; and
5. verify that 5432, 8080, and 8787 are not publicly reachable.

Docker is an effective root-equivalent interface. Protect membership in its
group and do not expose the Docker socket to application containers.

## First bootstrap from source

From the `nuvopic` checkout:

```sh
chmod +x scripts/*.sh
./scripts/bootstrap.sh operator@example.com
docker compose ps
./scripts/smoke-test.sh
```

Bootstrap refuses to replace an existing `.env`. It generates the PostgreSQL
administrator credential, a separate `nuvopic_control` login, Better Auth and
directory secrets, the settings KEK, and a 3072-bit RSA signing key. It starts
PostgreSQL, creates the control role, changes `nuvopic_control` ownership to
that role, runs the control migration, and then starts the stack.

The bootstrap defaults to Modal for realtime processing and Vast.ai for batch
processing, but does not invent provider credentials. Add credentials for only
the selected providers to `.env`, then recreate the data plane:

```sh
docker compose up -d --force-recreate data-plane
```

Back up `.env` with encryption and restricted access before onboarding a
workspace. In particular, loss of `SETTINGS_KEK` makes encrypted settings
unrecoverable.

## Production images

Build and publish four immutable images in CI: runtime and migration targets
for each application. Record digests, not mutable `latest` tags, in `.env`:

```env
CONTROL_PLANE_IMAGE=registry.example/control@sha256:...
CONTROL_PLANE_MIGRATION_IMAGE=registry.example/control-migrate@sha256:...
DATA_PLANE_IMAGE=registry.example/data@sha256:...
DATA_PLANE_MIGRATION_IMAGE=registry.example/data-migrate@sha256:...
COMPOSE_FILE=compose.yaml:compose.production.yaml
```

For the shared-Caddy VPS, set:

```env
COMPOSE_FILE=compose.yaml:compose.production.yaml:compose.shared-caddy.yaml
```

The migration tags must come from the `migration` targets. Runtime images do
not contain migration sources or tools.

Preview the fully merged production configuration without printing it into
shared logs:

```sh
docker compose config --quiet
docker compose pull
```

## Release

Use backward-compatible schema changes. A normal release is:

```sh
./scripts/backup-databases.sh
./scripts/migrate-control-plane.sh
# Migrate each workspace with its protected database URL:
WORKSPACE_DATABASE_URL='postgres://...' ./scripts/migrate-workspace.sh
docker compose up -d control-plane data-plane caddy
docker compose ps
./scripts/smoke-test.sh
```

Do not continue if a backup, migration, health check, or smoke test fails.
Record the image digests, database set, migration results, operator, and time.
Application rollback uses the previous immutable image digests. Database
rollback is not assumed: prefer a forward repair or an expand/contract
migration, and restore only when explicitly approved.

## Private-alpha workspace onboarding

1. Approve the user's email and have them sign in once. This creates the
   workspace row.
2. Confirm that `workspace-provisioner` is running. It polls for unrouted
   active workspaces, creates a dedicated database and runtime role, installs
   `pgvector`, applies the current schema, and activates the route only after
   every step succeeds:

   ```sh
   docker compose ps workspace-provisioner
   docker compose logs --since 10m workspace-provisioner
   ```

3. Reload `/profile` and confirm that database routing is configured.
4. Configure the user's S3 bucket through NuvoPic. Require a webhook secret.
5. Upload a small non-sensitive test set.
6. Verify that this workspace can list only its own photos.
7. Repeat with a second workspace and test tokens in both directions.

Provisioning is idempotent and protected by a per-workspace PostgreSQL
advisory lock. A partial failure leaves the route unset, and the worker retries
it without exposing the generated credential. Use the operator command below
only as a recovery fallback while the worker is stopped:

```sh
docker compose stop workspace-provisioner
./scripts/create-workspace-db.sh 00000000-0000-0000-0000-000000000000
docker compose start workspace-provisioner
```

## Backup and restore

Create `/var/backups/nuvopic` with mode `0700` and ownership restricted to the
backup operator. Run `scripts/backup-databases.sh` nightly from a protected
scheduler. Its output is sensitive and unencrypted. Encrypt it, upload it
off-host, apply daily, weekly, and monthly retention, and alert on freshness or
upload failures. Follow `backups/README.md` for validation and an isolated
restore drill.

At least quarterly, restore the control database and one workspace database
into fresh isolated targets, supply a protected copy of the original
`SETTINGS_KEK`, run smoke tests, and record recovery time and recovery point.

Photo objects are not in PostgreSQL. Enable object versioning and an independent
replication or backup policy at the S3 provider.

## Routine checks

- `docker compose ps` shows every long-running service healthy.
- `docker compose logs --since 15m SERVICE` has no repeated auth, directory,
  database, S3, GPU, or webhook failures.
- Disk, inode, memory, CPU, and load alerts are green.
- PostgreSQL connections, locks, storage growth, and slow queries are normal.
- The latest off-host backup is fresh and checksum-validated.
- `./scripts/smoke-test.sh` passes.
- A public request to `/internal/workspaces/resolve` returns 404.

Never paste `.env`, cookies, tokens, database URLs, S3 credentials, user image
metadata, or signing keys into tickets, chat, logs, or command history.
