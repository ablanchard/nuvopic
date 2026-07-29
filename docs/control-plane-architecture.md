# NuvoPic Control Plane Architecture

Status: Current-state reference and target architecture

Audience: Engineering, security, and operations

Last updated: 2026-07-27

## 1. Purpose

This document describes the current NuvoPic managed control plane and defines
the target architecture required to operate it as a production multi-tenant
service.

The existing NuvoPic application is the **data plane**. It serves the photo
application, processes images, and reads and writes one workspace database at a
time. It already contains the receiving side of a managed authentication
protocol:

- it accepts workspace-scoped bearer JWTs;
- it validates those JWTs with a JSON Web Key Set (JWKS);
- it resolves `workspace_id` to a database connection;
- it runs the request inside a workspace-specific database context; and
- its browser client can exchange a control-plane session for a short-lived
  bearer token.

The implementation is split across two sibling projects:

- `gphoto` is the NuvoPic data plane; and
- `nuvopic-saas` is the control plane.

The control plane already authenticates users, issues workspace tokens,
publishes signing keys, stores workspace routing, and provides profile and admin
pages. It is an operational scaffold, not yet the complete target system
described in this document.

### 1.1 Current implementation

The current `nuvopic-saas` application is a Node.js and Hono service backed by
PostgreSQL.

| Capability | Current implementation |
| --- | --- |
| Human authentication | Better Auth with email and password |
| Browser session | Better Auth session cookie |
| Workspace model | One automatically created workspace per owner |
| Workspace roles | `owner`, or `admin` when the owner's email is in an environment allowlist |
| Access token | RS256 JWT, five-minute default lifetime |
| Signing key | One RSA private key supplied through an environment variable |
| Public keys | One-key JWKS at `/.well-known/jwks.json` |
| Workspace routing | Raw database URL stored in the control database |
| Directory authentication | Static bearer token |
| Profile UI | Server-rendered account and manual database-routing form |
| Admin UI | Read-only server-rendered user and workspace overview |
| Provisioning | Manual; the owner supplies the workspace database URL |
| Photo and S3 settings | Remain in the workspace data plane |

The current end-to-end flow is:

1. a user signs up or logs in to `nuvopic-saas`;
2. Better Auth establishes the browser session;
3. the profile flow creates one workspace for that user if needed;
4. the owner manually provides the NuvoPic workspace database URL;
5. the browser calls `POST /managed/session/token`;
6. the control plane signs a workspace-scoped JWT;
7. the browser sends the JWT to the `gphoto` API;
8. `gphoto` validates it using the control-plane JWKS;
9. `gphoto` resolves the token's `workspace_id` through the internal workspace
   directory; and
10. `gphoto` uses its request-scoped database context for the selected workspace.

The rest of this document distinguishes these implemented contracts from the
recommended production target.

## 2. Goals

The control plane must:

1. authenticate users and maintain browser sessions;
2. manage workspace membership and roles;
3. issue short-lived, workspace-scoped access tokens;
4. publish signing keys without exposing private keys;
5. provision, suspend, and delete workspace resources;
6. provide an authenticated workspace-directory API to the data plane;
7. provide profile, workspace-selection, and administration interfaces;
8. preserve strict tenant isolation even when the data-plane fleet is shared;
9. support safe key, credential, and database rotation; and
10. produce audit records for security-sensitive operations.

## 3. Non-goals

The control plane should not:

- proxy photo data during normal application use;
- store photos, face embeddings, tags, or photo search data;
- run image-processing workloads;
- place long-lived database credentials in browser tokens;
- use the browser-provided workspace identifier without checking membership; or
- turn the control-plane database into a shared photo database.

Billing, plan enforcement, and automated regional placement may be added later.
The initial design leaves room for them but does not require them.

## 4. Terminology

| Term | Meaning |
| --- | --- |
| Control plane | Service that owns identity, workspaces, membership, provisioning, and token issuance |
| Data plane | Existing NuvoPic server and web application |
| Workspace | Tenant boundary for users, settings, storage, and photo data |
| Control database | Shared database containing users, workspaces, memberships, and operational metadata |
| Workspace database | Database selected by `workspace_id` and used by the NuvoPic data plane |
| Browser session | Opaque, revocable control-plane session represented by a secure cookie |
| Access token | Short-lived JWT authorizing one user to access one workspace |
| Workspace directory | Internal API that maps a workspace ID to its data-plane database |

## 5. Target system context

```mermaid
flowchart LR
    Browser[Browser]
    Edge[Gateway / same-origin router]
    CP[Control plane]
    CD[(Control database)]
    IdP[Identity provider]
    KMS[KMS / secret manager]
    DP[NuvoPic data-plane fleet]
    WD1[(Workspace DB A)]
    WD2[(Workspace DB B)]
    S3A[(Object storage A)]
    S3B[(Object storage B)]

    Browser -->|HTTPS| Edge
    Edge -->|/auth, /managed, /profile, /admin| CP
    Edge -->|/api, /process, app assets| DP
    CP --> IdP
    CP --> CD
    CP --> KMS
    DP -->|JWKS and workspace resolution| CP
    DP -->|request-scoped connection| WD1
    DP -->|request-scoped connection| WD2
    DP --> S3A
    DP --> S3B
```

This diagram is the target architecture. The current scaffold uses Better Auth
email/password instead of an external identity provider, an environment-provided
private key instead of KMS, and manual database routing instead of a
provisioning worker.

The recommended topology uses a gateway so the control plane and data plane
appear on the same origin. This matches the existing web client, which calls a
relative token endpoint with `credentials: "include"`.

Suggested routing:

| Path | Owner |
| --- | --- |
| `/auth/*` | Control plane |
| `/managed/*` | Control plane |
| `/profile` and `/profile/*` | Control plane |
| `/admin` and `/admin/*` | Control plane |
| `/.well-known/jwks.json` | Control plane |
| `/api/v1/*` | Data plane |
| `/process` | Data plane |
| `/webhook/*` | Data plane |
| Application assets and routes | Data plane |

Current: neither sibling project contains the gateway configuration. A
deployment must either route the relative `/managed`, `/profile`, and `/admin`
paths to `nuvopic-saas`, or configure an absolute managed-token endpoint and the
matching trusted origin. Same-origin gateway routing remains the preferred
production setup.

Using separate origins is possible, but it requires explicit CORS allowlists,
cross-site cookie decisions, and corresponding client configuration. It should
not be the default.

## 6. Trust boundaries

There are four important trust boundaries:

1. **Browser to edge:** untrusted input over public HTTPS.
2. **Control plane to data plane:** signed tokens cross this boundary. No shared
   private signing secret should be needed.
3. **Data plane to workspace directory:** trusted service-to-service traffic
   containing database routing information.
4. **Workspace to workspace:** the primary tenant boundary. A request for one
   workspace must never acquire another workspace's database context.

The JWT `workspace_id` is the only tenant-routing input for normal API requests.
Route parameters, query parameters, headers supplied directly by the browser,
and values stored in client-side state must not override it.

## 7. Component responsibilities

This section describes the target responsibility of each component. Notes
beginning with "Current" document the behavior already implemented in
`nuvopic-saas`.

### 7.1 Edge gateway

The gateway:

- terminates TLS;
- applies the path routing above;
- adds request IDs;
- enforces request-size and basic rate limits;
- preserves the original host and scheme;
- blocks direct public access to internal control-plane endpoints; and
- may apply coarse denial-of-service protection.

The gateway does not make authorization decisions about workspace membership.

### 7.2 Identity and session service

Current: `nuvopic-saas` uses Better Auth with its PostgreSQL adapter,
email/password login, an eight-character minimum password, secure cookies in
production, and production-only Better Auth rate limiting. Login, signup, and
logout are implemented as server-rendered forms with Origin validation.

Target: retain Better Auth as the session framework, but integrate an
established OpenID Connect provider for passkeys, MFA, account recovery, and
email verification. The control plane remains responsible for mapping the
provider identity to its own user record. Direct email/password authentication
may remain as a development or recovery option if product policy requires it.

After identity-provider callback, the control plane creates a server-side,
revocable session and sets an opaque cookie:

```http
Set-Cookie: __Host-nuvopic_session=<opaque-random-value>;
            Path=/; HttpOnly; Secure; SameSite=Lax
```

Only a hash of the opaque session value is stored in the control database.
Sessions should have:

- a short idle timeout, initially 24 hours;
- an absolute lifetime, initially 30 days;
- rotation after authentication and privilege changes;
- revocation on logout, password reset, provider unlink, or administrator
  action; and
- optional MFA recency for sensitive actions.

The browser session is not accepted by the data plane. It is only accepted by
the control plane and exchanged for short-lived access tokens.

### 7.3 Token service

The token service converts an authenticated browser session into an access token
for one workspace.

It must:

1. authenticate the browser session;
2. determine the requested or currently selected workspace;
3. verify that the user has an active membership in that workspace;
4. verify that the user and workspace are active;
5. derive the effective role server-side;
6. sign a short-lived JWT with the current asymmetric key; and
7. return the token without setting it as a cookie.

The existing client keeps this token in memory. It fetches another token after a
`401` and retries the API request once. No refresh token is exposed to
JavaScript.

Current: `POST /managed/session/token` reads the Better Auth session, creates or
loads the user's single workspace, requires a configured database URL and an
active workspace, and returns a five-minute RS256 token. The response uses
`Cache-Control: no-store`. Workspace selection and membership lookup are not
implemented because the current model allows exactly one owner per workspace.

### 7.4 Workspace service

The workspace service owns:

- workspace metadata and lifecycle state;
- memberships and invitations;
- workspace selection;
- provisioning state;
- deployment region and data-plane placement;
- references to workspace database credentials;
- subscription or quota metadata when billing is added; and
- workspace deletion and retention workflows.

Current: the control database contains one `workspace` row per Better Auth user.
The user is always its owner. The row contains name, slug, raw database URL, SSL
flag, and `active` or `disabled` status. There are no memberships, invitations,
plans, deletion workflows, or deployment records yet.

### 7.5 Provisioning worker

Current: no provisioning worker exists. Workspace owners enter an existing
database connection manually in `/profile`.

Provisioning is asynchronous and idempotent. A worker consumes provisioning
jobs and:

1. creates or assigns a workspace database;
2. enables required PostgreSQL extensions;
3. applies the NuvoPic schema and migrations;
4. creates least-privilege data-plane credentials;
5. writes credentials to the secret manager;
6. records the credential reference and database metadata;
7. marks the workspace active; and
8. emits an audit event.

Retrying a job must not create duplicate databases or credentials. Each external
operation must use the workspace ID as its idempotency key where supported.

### 7.6 Workspace-directory service

The workspace directory is an internal control-plane API used only by the data
plane. It returns the database connection needed for a validated workspace.

The initial contract matches the current NuvoPic implementation:

```http
GET /internal/workspaces/resolve?workspaceId=ws_01J...
Authorization: Bearer <data-plane-service-token>
Accept: application/json
```

```json
{
  "workspaceId": "ws_01J...",
  "databaseUrl": "postgres://nuvopic_runtime:...@db.example/ws_01J...",
  "databaseSsl": true,
  "status": "active"
}
```

The service must authenticate the data plane using mTLS, a workload identity, or
a rotated service token. Using both mTLS and a service token is recommended for
the first hosted deployment.

Current: the directory uses a static bearer token from
`MANAGED_WORKSPACE_DIRECTORY_TOKEN` and returns the raw `database_url` stored in
the control database. It returns `404` for an unknown workspace, `409` when the
database route is missing, and the workspace's `active` or `disabled` status in
the success body.

Database credentials are secrets. This endpoint must:

- never be publicly routed;
- avoid logging response bodies or connection strings;
- return `Cache-Control: no-store`;
- restrict callers by service identity and network policy;
- rate-limit unexpected lookup patterns; and
- audit changes to the underlying workspace mapping.

The existing data plane caches directory responses for 60 seconds and connection
pools for longer. Suspension and credential-rotation procedures must account for
that delay.

In a later version, the directory should return a secret reference or a
short-lived database credential instead of a long-lived connection string. That
change requires corresponding data-plane support.

### 7.7 Signing-key service

Current: `nuvopic-saas` loads one RSA private key from
`MANAGED_JWT_PRIVATE_KEY_PEM`, signs RS256 tokens in process, and publishes the
derived public key using `MANAGED_JWT_KEY_ID`. The JWKS contains only that key,
so there is no overlap mechanism for zero-downtime rotation.

Private keys live in a KMS or HSM and are never stored as plaintext application
configuration. The control plane publishes public keys:

```http
GET /.well-known/jwks.json
Cache-Control: public, max-age=300
```

```json
{
  "keys": [
    {
      "kty": "RSA",
      "kid": "2026-07-primary",
      "use": "sig",
      "alg": "RS256",
      "n": "...",
      "e": "AQAB"
    }
  ]
}
```

Use `RS256` initially because it is supported by the current data plane and is
widely interoperable.

Key rotation:

1. create a new key in KMS;
2. publish its public key alongside the old public key;
3. start signing new tokens with the new `kid`;
4. wait longer than the maximum token lifetime plus JWKS cache lifetime;
5. stop publishing the old key; and
6. disable, then schedule deletion of, the old private key.

Emergency rotation follows the same sequence but may accept temporary
authentication failures to reduce the exposure window.

### 7.8 Profile and administration applications

Current: both applications are server-rendered HTML. Profile lets an owner edit
workspace name, slug, database URL, and SSL behavior. Admin access is granted
when the signed-in email appears in `PLATFORM_ADMIN_EMAILS`; the page lists users
and workspaces but does not mutate them.

The profile application allows a user to:

- view and update profile information;
- list workspaces;
- select the active workspace;
- create a workspace;
- invite and remove members, subject to role;
- leave a workspace;
- configure security settings; and
- view active sessions.

The administration application is for platform operators. It allows:

- locating a user or workspace;
- viewing provisioning and deployment health;
- suspending and restoring a workspace;
- revoking user sessions;
- initiating safe credential rotation;
- inspecting audit events; and
- starting a time-limited, explicitly approved support session.

Platform administration is not a workspace role. It should use a separate
`platform_role` claim and dedicated authorization middleware. The current
NuvoPic UI checks whether `role === "admin"` to show an Admin link; that is a
temporary compatibility behavior and should be replaced with a separate
`platformRole` field.

## 8. Control-plane data model

Current: Better Auth owns its user, session, account, and verification tables.
The NuvoPic-specific schema adds only this workspace record:

| Current field | Notes |
| --- | --- |
| `id` | Random UUID stored as text |
| `owner_user_id` | Unique foreign key to the Better Auth user |
| `name` | User-facing workspace name |
| `slug` | Unique normalized display slug |
| `database_url` | Optional raw NuvoPic database connection string |
| `database_ssl` | Whether the data plane should enable database SSL |
| `status` | `active` or `disabled` |
| timestamps | Creation and update times |

The unique `owner_user_id` constraint encodes the current one-user,
one-workspace model.

The target control database should contain at least the following entities.

### 8.1 Users

| Field | Notes |
| --- | --- |
| `id` | Stable opaque identifier, for example `usr_...` |
| `identity_provider` | OIDC issuer or provider name |
| `identity_subject` | Provider subject; unique with issuer |
| `email` | Normalized display and contact address |
| `email_verified` | Copied from a trusted provider claim |
| `status` | `active`, `suspended`, or `deleted` |
| `platform_role` | `none`, `support`, or `admin` |
| timestamps | Creation and update times |

### 8.2 Sessions

| Field | Notes |
| --- | --- |
| `id` | Internal session identifier |
| `user_id` | Owning user |
| `token_hash` | Hash of opaque cookie value |
| `active_workspace_id` | Optional convenience selection |
| `auth_time` | Most recent primary authentication |
| `mfa_time` | Most recent MFA verification |
| `last_seen_at` | Idle-expiry input |
| `expires_at` | Absolute expiry |
| `revoked_at` | Null while active |
| client metadata | Coarsened IP and user-agent data |

### 8.3 Workspaces

| Field | Notes |
| --- | --- |
| `id` | Stable opaque identifier, for example `ws_...` |
| `slug` | Human-readable unique name |
| `display_name` | User-facing name |
| `status` | Lifecycle state described below |
| `region` | Placement region |
| `deployment_id` | Current data-plane deployment record |
| `created_by` | Initial owner |
| timestamps | Creation, suspension, and deletion times |

### 8.4 Memberships

Use a composite uniqueness constraint on `(workspace_id, user_id)`.

| Field | Notes |
| --- | --- |
| `workspace_id` | Workspace |
| `user_id` | User |
| `role` | `owner`, `editor`, or `viewer` |
| `status` | `active` or `suspended` |
| timestamps | Creation and update times |

### 8.5 Invitations

Invitations contain a one-time token hash, destination email, intended role,
expiry time, inviter, and acceptance time. Accepting an invitation is
transactional and idempotent.

### 8.6 Deployments

| Field | Notes |
| --- | --- |
| `id` | Deployment identifier |
| `workspace_id` | Owning workspace |
| `region` | Data region |
| `database_host` and `database_name` | Non-secret routing metadata |
| `database_secret_ref` | Secret-manager reference, never the credential itself |
| `database_ssl` | Required in hosted environments |
| `schema_version` | Applied NuvoPic schema version |
| `status` | Provisioning and health state |

### 8.7 Audit events

Audit events are append-only and include:

- actor type and ID;
- workspace ID when applicable;
- action and target;
- timestamp;
- request and correlation IDs;
- coarse source address;
- success or failure;
- structured, redacted metadata; and
- support-session or impersonation context.

Secrets, access tokens, session values, and database URLs must never appear in
audit metadata.

## 9. Workspace lifecycle

Recommended lifecycle:

```mermaid
stateDiagram-v2
    [*] --> provisioning
    provisioning --> active: resources ready
    provisioning --> provisioning_failed: terminal retry failure
    provisioning_failed --> provisioning: operator retry
    active --> suspended: policy, billing, or operator action
    suspended --> active: restored
    active --> deletion_pending: owner confirms deletion
    suspended --> deletion_pending: owner or operator confirms
    deletion_pending --> deleted: retention period expires
    deleted --> [*]
```

Token issuance is allowed only for `active` workspaces. The workspace-directory
service resolves only active workspaces for normal traffic.

Suspension should:

1. reject new token issuance immediately;
2. make directory resolution return a disabled state;
3. revoke relevant browser sessions or their active-workspace selection;
4. wait for the data-plane cache window;
5. optionally revoke database credentials for urgent security suspension; and
6. preserve data until deletion policy permits removal.

Deletion must be a recoverable two-step workflow with an explicit retention
period. Destructive removal of the database and storage references happens only
after that period.

## 10. Authentication and authorization flows

### 10.1 Login

Current login uses Better Auth email/password forms. The following sequence is
the target OIDC flow:

```mermaid
sequenceDiagram
    participant B as Browser
    participant CP as Control plane
    participant I as Identity provider
    participant DB as Control database

    B->>CP: GET /auth/login
    CP->>I: OIDC authorization request with PKCE and state
    I-->>B: Authentication UI
    B->>CP: GET /auth/callback?code=...
    CP->>I: Exchange code and validate ID token
    CP->>DB: Upsert user and create opaque session
    CP-->>B: Secure HttpOnly session cookie; redirect /profile
```

OIDC validation must verify issuer, audience, signature, nonce, state, and PKCE.
Return URLs must be allowlisted to prevent open redirects.

### 10.2 Workspace selection

Current: workspace selection does not exist; each user owns exactly one
workspace.

Target: the user chooses a workspace in the profile application.

The control plane checks membership and stores `active_workspace_id` in the
server-side session.
The browser cannot select a workspace merely by modifying a cookie or token
payload.

The token endpoint may also accept a workspace ID in the request body for
multi-tab support, but it must perform the same membership check on every call.

### 10.3 Token exchange

Current: the endpoint relies on the Better Auth session cookie and uses
credentialed CORS for configured origins. It does not accept a workspace
selection or require an application-level CSRF token. The target flow adds
explicit workspace membership, Origin, and CSRF checks:

```mermaid
sequenceDiagram
    participant B as Browser
    participant CP as Control plane
    participant DB as Control database
    participant KMS as KMS

    B->>CP: POST /managed/session/token + session cookie
    CP->>CP: Verify Origin and CSRF protection
    CP->>DB: Load session, user, workspace, membership
    DB-->>CP: Active membership and role
    CP->>KMS: Sign workspace JWT
    KMS-->>CP: Signature
    CP-->>B: 200 {"token":"ey..."}
```

Request:

```http
POST /managed/session/token HTTP/1.1
Origin: https://app.nuvopic.example
Cookie: __Host-nuvopic_session=...
X-CSRF-Token: ...
Accept: application/json
```

Response:

```http
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json
```

```json
{
  "token": "eyJ...",
  "expiresIn": 300
}
```

The endpoint should enforce an exact Origin allowlist and CSRF token. It should
also use `Cache-Control: no-store` and rate limits per user and session.

### 10.4 Data-plane request

```mermaid
sequenceDiagram
    participant B as Browser
    participant DP as Data plane
    participant CP as Control plane
    participant WDB as Workspace database

    B->>DP: GET /api/v1/photos + Bearer JWT
    DP->>CP: Fetch JWKS on cache miss
    CP-->>DP: Public keys
    DP->>DP: Validate signature and claims
    DP->>CP: Resolve workspace_id on cache miss
    CP-->>DP: Workspace database entry
    DP->>WDB: Query inside request-scoped DB context
    WDB-->>DP: Workspace data
    DP-->>B: 200 response
```

The data plane must complete authentication and workspace resolution before any
database access. The existing `AsyncLocalStorage` database context is the
enforcement mechanism for that invariant.

### 10.5 Logout

Current logout delegates session invalidation and cookie deletion to Better
Auth, then redirects to `/login`.

Previously issued access tokens may remain valid for up to five minutes.
Emergency revocation in the target architecture uses workspace suspension, user
suspension, database credential revocation, or a short-lived denylist for
specific token IDs.

## 11. Access-token contract

The current token already includes `iss`, `aud`, `sub`, `workspace_id`, `role`,
`iat`, and `exp`. It does not include `nbf`, `jti`, or `platform_role`. The
examples and requirements below define the target contract.

### 11.1 Header

```json
{
  "alg": "RS256",
  "kid": "2026-07-primary",
  "typ": "JWT"
}
```

### 11.2 Claims

```json
{
  "iss": "https://app.nuvopic.example",
  "aud": "nuvopic",
  "sub": "usr_01J...",
  "workspace_id": "ws_01J...",
  "role": "owner",
  "platform_role": "none",
  "iat": 1785171000,
  "nbf": 1785170995,
  "exp": 1785171300,
  "jti": "tok_01J..."
}
```

Requirements:

- maximum lifetime: 5 minutes;
- clock skew: at most 30 seconds;
- `iss`, `aud`, `sub`, `workspace_id`, `role`, `iat`, `exp`, and `jti` required;
- `role` must be one of `owner`, `editor`, or `viewer`;
- `platform_role` must not grant workspace data access by itself;
- algorithms must be allowlisted; and
- tokens are accepted only over HTTPS.

Do not include email, database credentials, storage credentials, billing data,
or other personal data in the token.

### 11.3 Error behavior

| Situation | Response |
| --- | --- |
| Missing, invalid, or expired data-plane token | `401 Unauthorized` |
| Valid identity without permission for an operation | `403 Forbidden` |
| Unknown or unavailable workspace | `503 Service Unavailable` for transient failure |
| Suspended workspace | `403 Forbidden` or a stable workspace-suspended error |
| No authenticated browser session at token endpoint | `401 Unauthorized` |
| Authenticated user without workspace membership | `403 Forbidden` |

Error responses should use stable machine-readable codes in addition to a safe
message.

## 12. Authorization model

Authentication answers who the user is and which workspace the request targets.
Authorization must be enforced by data-plane route middleware, not only by the
UI.

Initial workspace-role matrix:

| Capability | Viewer | Editor | Owner |
| --- | :---: | :---: | :---: |
| View photos, faces, persons, and tags | Yes | Yes | Yes |
| Search and browse storage | Yes | Yes | Yes |
| Edit tags, persons, and face assignments | No | Yes | Yes |
| Import or reprocess photos | No | Yes | Yes |
| Change processing settings | No | Yes | Yes |
| Change storage credentials | No | No | Yes |
| Manage workspace members | No | No | Yes |
| Delete or suspend workspace | No | No | Yes |

Sensitive control-plane operations should additionally require recent MFA.

The current data plane records the token role but does not enforce this matrix.
Role-based middleware and route-level tests are required before non-owner roles
are issued.

## 13. Webhook architecture

Managed S3 webhooks use:

```text
POST /webhook/s3/{workspaceId}
```

The workspace ID selects the database only for this special machine-to-machine
flow. Every managed workspace must have a webhook secret. The data plane must
fail closed if the secret is absent.

Preferred verification order:

1. provider-native signed webhook validation when available;
2. otherwise a high-entropy secret in a header;
3. replay protection using provider event IDs or a timestamp and nonce; and
4. idempotent photo processing.

Secrets in URL query parameters should be supported only for compatibility,
because URLs are commonly logged. Webhook secrets should be generated during
workspace storage setup, encrypted at rest, rotatable with an overlap window,
and never returned after initial creation.

## 14. Tenant isolation

The initial deployment uses a database-per-workspace model. This is a strong and
simple boundary, provided routing remains correct.

Required invariants:

- a data-plane API request cannot access a database before authentication;
- only the validated JWT `workspace_id` can select the workspace;
- the directory response workspace ID must equal the requested workspace ID;
- connection pools must be keyed by workspace and credential identity;
- a background job must carry an explicit trusted workspace context;
- logs and metrics must carry workspace IDs but not credentials;
- cache entries cannot be reused across workspace IDs; and
- tests must attempt cross-workspace access for every route category.

Data-plane database users should be least-privilege runtime users. Migration and
provisioning credentials must be separate and unavailable to the data-plane
process.

## 15. Security requirements

### 15.1 Mandatory controls

- TLS 1.2 or newer for all traffic.
- Asymmetric JWT signing with private keys in KMS or HSM.
- Exact issuer, audience, algorithm, key ID, expiry, and not-before validation.
- Required token expiry and a maximum accepted token lifetime.
- Server-side membership lookup during every token exchange.
- Secure, HttpOnly, SameSite session cookies.
- CSRF and Origin validation on cookie-authenticated state-changing endpoints.
- Rate limiting for login, callback, token, invitation, and administrative
  endpoints.
- MFA for platform administrators and destructive workspace operations.
- Encryption at rest for all databases and secret-manager values.
- Redaction of cookies, tokens, connection strings, and storage credentials.
- Append-only audit logs for security-sensitive actions.
- Dependency, container, and secret scanning in CI.

### 15.2 Current data-plane gaps

Before production managed-mode rollout:

1. require `MANAGED_JWT_ISSUER`;
2. require the `exp` claim and enforce a maximum token lifetime;
3. validate `role` against an enum rather than defaulting a missing role to
   `owner`;
4. enforce route-level RBAC;
5. replace permissive CORS with an explicit origin policy;
6. make managed webhook secrets mandatory;
7. add authentication, authorization, tenant-isolation, and key-rotation tests;
8. distinguish suspended, unknown, and transiently unavailable workspaces;
9. validate that a directory response cannot substitute a different workspace
   ID; and
10. define pool eviction during database credential rotation.

### 15.3 Current control-plane gaps

Before production rollout:

1. move the RSA private key from an environment variable to KMS or a secret
   manager and support overlapping JWKS keys during rotation;
2. encrypt existing database URLs or replace them with secret-manager
   references;
3. replace the static workspace-directory bearer token with rotated workload
   identity, preferably combined with mTLS;
4. add `jti` and `nbf`, constrain configurable token lifetime, and separate
   workspace role from platform role;
5. remove email-address-based platform authorization in favor of stored,
   audited role assignments with MFA;
6. add explicit membership and invitation models before supporting shared
   workspaces;
7. add email verification, recovery, MFA, and session-management policy;
8. provision and migrate workspace databases instead of accepting arbitrary
   owner-entered connection strings;
9. add append-only security audit events and structured request IDs;
10. add tests; the current project has no test suite;
11. validate production configuration at startup, including allowed origins,
    issuer, key type, token lifetime, and TLS expectations; and
12. define suspension, credential rotation, backup, and deletion procedures.

## 16. Availability and failure behavior

The control plane and data plane should fail independently where safe.

| Failure | Expected behavior |
| --- | --- |
| Identity provider unavailable | Existing browser sessions continue; new logins fail clearly |
| Control database unavailable | Token issuance and profile operations fail; already-issued tokens continue briefly |
| JWKS endpoint unavailable | Data plane uses cached keys until cache expiry |
| Workspace directory unavailable | Cached workspace mappings continue briefly; uncached requests return `503` |
| KMS signing unavailable | Token issuance returns `503`; no unsigned fallback |
| Workspace database unavailable | Only that workspace is affected |
| Provisioning worker unavailable | New workspace remains pending; existing workspaces continue |

No failure mode may fall back to anonymous access, a default workspace, a
default database, or an unsigned token.

The workspace-directory cache duration trades availability for suspension and
rotation latency. Start with 60 seconds, as the current data plane does, and
measure before changing it.

## 17. Observability

Every request should have a correlation ID propagated through gateway, control
plane, data plane, provisioning worker, and audit events.

Metrics should include:

- login and callback success rates;
- active and revoked sessions;
- token-issuance latency and failure count by safe reason code;
- JWKS fetch and cache behavior;
- workspace-directory latency, failures, and cache hit rate;
- active database pools per data-plane instance;
- provisioning duration and retry count;
- authorization denials by route and role;
- suspended-workspace access attempts; and
- cross-workspace invariant violations, which should page immediately.

Do not use raw user IDs, emails, tokens, session IDs, database URLs, or storage
keys as metric labels.

Recommended service-level indicators:

- token issuance availability and p95 latency;
- workspace-directory availability and p95 latency;
- successful authenticated data-plane request rate;
- workspace provisioning completion time; and
- tenant-isolation security events, with a target of zero.

## 18. Deployment and secrets

Recommended initial deployment:

- one control-plane web service;
- one provisioning worker;
- one shared, highly available control database;
- one managed KMS signing key;
- one secret-manager namespace per environment;
- a horizontally scalable NuvoPic data-plane fleet;
- database-per-workspace within one or more managed PostgreSQL clusters; and
- one edge gateway exposing a single application origin.

Production, staging, and development must use distinct:

- identity-provider applications;
- issuers and audiences;
- signing keys and JWKS;
- control databases;
- service credentials;
- workspace databases; and
- object-storage resources.

Never allow a non-production issuer or signing key in production.

## 19. Internal and public API surface

Minimum control-plane endpoints:

| Method and path | Audience | Purpose |
| --- | --- | --- |
| `GET /auth/login` | Browser | Start login |
| `GET /auth/callback` | Browser | Complete OIDC login |
| `POST /auth/logout` | Browser | Revoke session |
| `GET /managed/session` | Browser | Return user and workspace-selection state |
| `POST /managed/session/token` | Browser | Issue workspace access token |
| `POST /managed/session/workspace` | Browser | Select active workspace |
| `GET /.well-known/jwks.json` | Data plane/public | Publish signing keys |
| `GET /profile/api/workspaces` | Browser | List memberships |
| `POST /profile/api/workspaces` | Browser | Create workspace |
| `POST /profile/api/workspaces/:id/invitations` | Browser | Invite member |
| `GET /internal/workspaces/resolve` | Data plane only | Resolve database context |
| `POST /internal/workspaces/:id/rotate-database` | Operator/worker | Rotate credentials |
| `POST /admin/api/workspaces/:id/suspend` | Platform operator | Suspend workspace |

Public APIs should use a consistent error envelope:

```json
{
  "error": {
    "code": "workspace_suspended",
    "message": "This workspace is suspended.",
    "requestId": "req_01J..."
  }
}
```

Internal endpoints may include more diagnostic detail, but never secrets.

## 20. Compatibility with the current repository

The architecture deliberately retains the contracts already implemented between
`gphoto` and `nuvopic-saas`:

- `DEPLOY_MODE=managed` enables bearer-token authentication;
- the default audience is `nuvopic`;
- `MANAGED_TOKEN_ENDPOINT` defaults to `/managed/session/token`;
- `MANAGED_PROFILE_PATH` defaults to `/profile`;
- `MANAGED_ADMIN_PATH` defaults to `/admin`;
- JWKS may be loaded from JSON, a file, or a URL;
- the workspace directory may be static JSON or a remote endpoint;
- the remote directory accepts `workspaceId` as a query parameter;
- the data plane accepts `databaseUrl`, `connectionString`, and an optional
  nested `workspace` object; and
- the browser expects either `token` or `accessToken` in the token response;
- `nuvopic-saas` currently responds with `token`, `workspaceId`, `role`, and
  `expiresAt`; and
- both projects default the JWT lifetime/cache behavior to five minutes where
  applicable.

New control-plane work should standardize on the examples in this document while
retaining those aliases only where they simplify migration.

## 21. Implementation plan

### Phase 0: Harden the data-plane contract

- Implement the security changes listed in section 15.2.
- Add unit tests for managed JWT validation.
- Add integration tests with two workspaces and two databases.
- Add RBAC middleware and a documented route-permission map.
- Add explicit managed-mode startup validation.

Exit criterion: the data plane safely rejects invalid, expired, cross-tenant,
and underprivileged requests.

### Phase 1: Identity, sessions, and token issuance

- Productionize the existing `nuvopic-saas` Better Auth deployment.
- Add verified identity, account recovery, MFA, and session-management policy.
- Move signing to KMS and implement overlapping-key JWKS rotation.
- Add the target token claims and strict configuration validation.
- Encrypt or externalize the manually configured workspace database credential.
- Add integration tests covering token issuance through data-plane acceptance.

Exit criterion: the existing five-minute token flow is tested, rotatable,
observable, and suitable for production secrets.

### Phase 2: Workspaces and provisioning

- Replace the one-owner workspace constraint with membership and invitation
  models.
- Implement the idempotent provisioning worker.
- Evolve the existing authenticated directory toward secret references or
  short-lived database credentials.
- Implement suspension and database credential rotation.

Exit criterion: creating a workspace provisions a database and produces an
isolated, usable NuvoPic environment without manual configuration.

### Phase 3: User and operator interfaces

- Expand the existing profile UI with workspace selection and member
  management.
- Expand the read-only admin UI with audited operational actions.
- Add audited support-session workflows.

Exit criterion: routine user and operator workflows require no direct database
edits.

### Phase 4: Production operations

- Add quotas and billing if required.
- Add regional placement and capacity management.
- Add backup restoration drills and deletion workflows.
- Complete threat modeling and external security review.
- Establish SLOs, alerts, dashboards, and on-call runbooks.

Exit criterion: the managed service meets the agreed operational and security
readiness bar.

## 22. Test strategy

Required automated test groups:

### Authentication

- valid login, logout, session expiry, and session revocation;
- OIDC state, nonce, issuer, audience, and PKCE failures;
- valid and invalid JWT signatures;
- missing and invalid required claims;
- expired, not-yet-valid, and excessively long-lived tokens; and
- key rotation while old tokens remain valid.

### Authorization

- every role against every protected route category;
- suspended user, membership, and workspace;
- removed membership with an existing browser session; and
- platform administrator without a workspace membership.

### Tenant isolation

- token for workspace A cannot query workspace B;
- browser-supplied workspace IDs cannot override JWT routing;
- directory response mismatch is rejected;
- concurrent requests do not leak `AsyncLocalStorage` context;
- background processing uses the correct workspace; and
- connection pools are not reused with the wrong credentials.

### Provisioning and lifecycle

- idempotent retries at every provisioning step;
- partial resource cleanup;
- schema migration failure and retry;
- suspension propagation through caches;
- database credential rotation with active pools; and
- recoverable deletion followed by final deletion.

### Security and operations

- CSRF and Origin enforcement;
- rate-limit behavior;
- secret and token redaction;
- audit-event completeness;
- control-plane dependency outages; and
- backup restoration into an isolated environment.

## 23. Decisions to confirm before implementation

1. Which OIDC provider will be used initially?
2. Which cloud KMS and secret manager will hold signing and database secrets?
3. Is database-per-workspace the long-term isolation model or only the initial
   model?
4. Which regions are required at launch?
5. What are the exact session, retention, backup, and deletion policies?
6. Are `viewer` and `editor` roles needed at launch, or should all initial
   memberships be owners until data-plane RBAC is complete?
7. Is billing in the first release or a later control-plane capability?
8. What emergency suspension latency is required?

Until these decisions are made, the defaults in this document are reasonable
implementation assumptions, not finalized product policy.
