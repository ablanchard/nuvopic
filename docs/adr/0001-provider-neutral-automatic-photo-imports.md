# ADR 0001: Provider-neutral automatic photo imports

- Status: Proposed
- Date: 2026-08-10
- Owners: NuvoPic maintainers

## Context

NuvoPic connects to user-owned object-storage buckets and imports supported
images into a dedicated workspace. Users expect newly uploaded images to
appear automatically without manually browsing the bucket and starting an
import.

The first hosted setup uses Scaleway Object Storage, but NuvoPic must also
support Amazon S3, Google Cloud Storage, Cloudflare R2, Backblaze B2, and other
S3-compatible services.

The providers expose broadly compatible object APIs, but they do not expose a
common notification protocol:

| Provider | Object access | Native change notification |
| --- | --- | --- |
| Amazon S3 | S3 API | SQS, SNS, Lambda, or EventBridge |
| Google Cloud Storage | Native API or S3-interoperable XML API | Pub/Sub notifications |
| Cloudflare R2 | S3-compatible API | R2 event notification delivered through Cloudflare Queues |
| Backblaze B2 | Native or S3-compatible API | HMAC-signed HTTP webhook |
| Scaleway Object Storage | S3-compatible API | S3 bucket-notification operations are currently unavailable |

Notifications from these systems are generally asynchronous, may be duplicated,
may arrive out of order, and can be lost through configuration or delivery
failures. Provider events alone therefore cannot be the source of truth for a
user's bucket.

NuvoPic already has a workspace-scoped AWS-shaped S3 webhook endpoint. It
starts processing in memory after returning `202 Accepted`. This is useful as a
prototype, but it is not a durable multi-provider import system: a restart can
lose accepted work, processing is coupled to the HTTP request process, and
Scaleway cannot send the expected event directly.

## Decision drivers

- Correctness must not depend on a provider supporting notifications.
- The same import pipeline must work for every provider.
- Native events should provide low latency when available.
- Missed, duplicated, and out-of-order events must be harmless.
- A restart or deployment must not lose accepted imports.
- Existing bucket credentials and their least-privilege scope should be reused
  wherever possible.
- Bucket scans should also supply folder counts and object inventory instead of
  repeating the same expensive listings for separate features.
- Each managed workspace must retain its data isolation.

## Decision

NuvoPic will implement automatic imports as a provider-neutral, inventory-backed
pipeline.

The persistent bucket inventory and its periodic reconciliation are the source
of truth. Provider-native notifications are optional accelerators that reduce
the delay between an upload and its import. Every notification adapter converts
its provider payload into one canonical object-change event and enqueues it in
the same durable PostgreSQL job queue used by reconciliation.

```text
Object-storage provider
    |                         |
    | native notification     | scheduled inventory scan
    v                         v
Provider event adapter   Object inventory reconciliation
    |                         |
    +----------+--------------+
               v
       Canonical object event
               v
    Durable PostgreSQL import queue
               v
      Batched photo import workers
               v
   Photos, thumbnails, metadata, counts
```

### Storage access and event delivery are separate capabilities

NuvoPic will not model a provider as a single large integration. It will use two
separate interfaces:

1. An object-storage driver for listing, reading, and inspecting objects.
2. An event adapter for configuring, receiving, or polling provider-specific
   notifications.

Most providers can use a common S3-compatible object driver with a custom
endpoint, region, credentials, and path-style setting. Google Cloud Storage may
use either its S3-interoperable XML API with HMAC credentials or a future native
driver. Event adapters remain provider-specific even when object access uses the
common S3 driver.

An indicative object driver contract is:

```ts
interface ObjectStorageDriver {
  validateConnection(): Promise<void>;
  listObjects(prefix?: string): AsyncIterable<StorageObject>;
  headObject(key: string): Promise<StorageObject>;
  getObject(key: string): Promise<ReadableStream>;
}
```

### Canonical object-change event

All event adapters will normalize their input before it reaches import logic:

```ts
interface ObjectChangeEvent {
  connectionId: string;
  provider: string;
  providerEventId?: string;
  type: "created" | "updated" | "deleted";
  bucket: string;
  key: string;
  etag?: string;
  versionId?: string;
  size?: number;
  occurredAt?: Date;
}
```

Raw provider payloads may be retained temporarily for diagnosis, subject to a
size limit and retention policy, but business logic must use the canonical
event only.

### Provider adapters

The initial adapters are expected to use these transports:

- Amazon S3: prefer S3 ObjectCreated notifications delivered to an SQS queue
  that NuvoPic polls. SQS gives buffering and retry behavior without exposing a
  public provider-specific webhook.
- Google Cloud Storage: consume Pub/Sub `OBJECT_FINALIZE` messages using a push
  or pull subscription.
- Cloudflare R2: consume R2 object-create notifications from a Cloudflare Queue,
  either through HTTP pull or a small relay Worker.
- Backblaze B2: receive native event-notification webhooks and verify the raw
  request body with `X-Bz-Event-Notification-Signature` before parsing it.
- Scaleway Object Storage: use inventory reconciliation by default. A later
  adapter may consume filtered Object Storage logs from Scaleway Cockpit, but
  correctness will continue to rely on reconciliation.

Adapters must acknowledge delivery only after the event is durably recorded.
They must not download or process an image inside the webhook or queue-consumer
request.

### Persistent object inventory

Each workspace database will maintain an inventory similar to:

```text
storage_objects
- connection_id
- object_key
- etag
- version_id
- size
- last_modified
- first_seen_at
- last_seen_at
- imported_at
- missing_since
```

The natural identity is the storage connection plus object key. Version or ETag
data determines whether an existing key has changed and requires reprocessing.

An inventory run will:

1. Stream the configured bucket or selected prefixes page by page.
2. Upsert the observed object metadata.
3. Enqueue supported objects that are new or changed.
4. Mark previously known objects that were not observed as potentially missing.
5. Calculate recursive folder totals during the same pass.
6. Record its completion, duration, page count, object count, and errors.

Missing objects will not be deleted from NuvoPic immediately. Deletion behavior
will be a separate product policy and must tolerate temporary provider errors or
incomplete scans.

Only one inventory run may be active for a storage connection. A failed or
partial run must not mark unseen objects as deleted.

### Reconciliation schedule

- Connections without native notifications: scan approximately every 5 to 10
  minutes, configurable according to bucket size and provider limits.
- Connections with healthy native notifications: perform a slower safety scan,
  initially every 6 to 24 hours.
- Manual refresh: request a reconciliation without starting a duplicate
  concurrent scan.

Schedules will include jitter so that all workspaces do not scan simultaneously.
Large buckets may receive an adaptive interval based on the previous scan's
duration and request count.

### Durable import queue

Automatic imports will use a PostgreSQL-backed queue in each workspace database:

```text
photo_import_jobs
- id
- connection_id
- object_key
- etag
- version_id
- status
- attempts
- next_attempt_at
- last_error
- created_at
- started_at
- completed_at
```

A uniqueness rule based on the connection, object key, and object version or
ETag will make repeated delivery idempotent. The existing uniqueness of
`photos.s3_path` remains a final safeguard but is not sufficient to distinguish
an overwrite from a duplicate event.

Workers will claim jobs using PostgreSQL locking, process them outside HTTP
requests, retry transient failures with exponential backoff, and retain failed
jobs for inspection. Workers may coalesce a short burst of jobs so caption and
face-processing providers can operate on efficient batches.

Before processing, a worker will verify that:

- the event bucket matches the configured connection;
- the key is inside an allowed import prefix;
- the object still exists and its current metadata matches the queued version;
- the extension or content type is supported;
- the workspace and storage connection are active.

### Delivery semantics

The system will explicitly provide at-least-once ingestion with idempotent
processing, not exactly-once delivery.

It must tolerate:

- duplicate provider events;
- events arriving out of order;
- notification delivery before an object is readable;
- multipart-upload completion events;
- a key being overwritten;
- events missed while credentials, queues, or webhooks are misconfigured;
- NuvoPic restarting between accepting and processing an event.

The inventory reconciler repairs divergence between notifications and actual
bucket state.

### Onboarding and product behavior

Every provider will support a common baseline flow:

1. Connect and validate the bucket.
2. Select optional import prefixes.
3. Enable automatic import.
4. Choose one of:
   - import only objects added after the initial inventory baseline;
   - import all existing supported objects that are not already present.
5. Start provider-neutral scheduled synchronization.

When a native adapter is available, the UI may additionally offer **Instant
notifications** and guide the user through provider-specific provisioning.
Automatic import must continue through reconciliation if the native adapter is
disabled or unhealthy.

The UI will report:

- connection and notification status;
- last received event;
- last successful reconciliation;
- queued, processing, failed, and completed import counts;
- the next scheduled scan;
- actionable configuration or permission errors.

### Provisioning native notifications

Provider authorization will be used only to create or connect the minimum
required notification resources. It is distinct from the read-only credentials
used to retrieve images.

Possible provisioning mechanisms include:

- AWS CloudFormation plus an IAM role with an external ID;
- Google OAuth or a narrowly scoped service account for Pub/Sub setup;
- Cloudflare OAuth or a scoped API token for Queue and R2 notification setup;
- a Backblaze application key with bucket-notification capabilities;
- manual instructions when safe automated provisioning is unavailable.

NuvoPic should prefer short-lived authorization or delegated roles over storing
broad, long-lived cloud-management credentials.

### Security requirements

- Keep object and provider-management credentials logically separate.
- Encrypt all stored secrets using the existing workspace envelope-encryption
  mechanism.
- Use a distinct notification secret or signing configuration per connection.
- Verify provider signatures against the exact raw request body where the
  provider supports signing.
- Do not place webhook secrets in query strings.
- Validate the configured bucket and allowed prefixes after authentication.
- Apply request size limits and rate limits to public event endpoints.
- Do not trust an event as proof that an object is safe or readable.
- Avoid logging credentials, signatures, full event payloads, or private object
  keys unnecessarily.

## Consequences

### Positive

- Automatic import works for providers without native notifications.
- Native integrations improve latency without creating provider lock-in.
- A single inventory scan serves automatic import, overwrite detection, and
  recursive folder counts.
- Durable jobs survive deployments and process crashes.
- Provider duplication and ordering differences are isolated in adapters.
- Reconciliation provides a clear recovery path for missed events.
- The model extends to additional S3-compatible providers without changing the
  import pipeline.

### Negative

- Persistent inventory and job tables add database and worker complexity.
- Provider-native setup requires separate documentation and test coverage.
- Full reconciliation incurs LIST requests and can be slow for very large
  buckets.
- Near-real-time behavior depends on optional provider services and their cost.
- Correct overwrite and deletion behavior requires explicit product policies.

### Risks and mitigations

- Scan cost or throttling: use prefix selection, streaming pagination, jitter,
  adaptive schedules, and provider-specific request metrics.
- Event storms: acknowledge after durable enqueueing, deduplicate, batch work,
  and cap worker concurrency.
- Poison objects: bound retry attempts and retain a failed-job record.
- Misconfigured notification source: continuously report health and rely on the
  scheduled safety scan.
- Credential expansion: keep native notification setup optional and request the
  narrowest provider permissions possible.

## Alternatives considered

### Use only native provider notifications

Rejected because notification capabilities and transports differ, Scaleway does
not currently expose S3 bucket notifications, and no provider event system
eliminates the need to recover from missed or misconfigured delivery.

### Use only periodic bucket scans

Rejected as the final architecture because it cannot provide low-latency imports
without frequent LIST operations. It remains the universal baseline and
correctness mechanism.

### Standardize every provider on an AWS-shaped webhook

Rejected because several providers deliver through queues or Pub/Sub rather
than HTTP, payloads and signatures differ, and translating them outside NuvoPic
would move complexity to every user.

### Process images directly inside notification handlers

Rejected because provider acknowledgement deadlines are short, processing can
take much longer, and accepted work would be lost during process termination.

## Implementation outline

This ADR does not authorize or include implementation. The intended sequence is:

1. Add storage-connection, inventory, sync-run, and durable import-job models.
2. Build the provider-neutral inventory reconciler and reuse it for folder
   counts.
3. Add queue workers, retries, batching, observability, and administrative
   controls.
4. Add automatic-import onboarding with the initial-baseline choice.
5. Convert the existing AWS-shaped webhook to a normalizing enqueue-only
   adapter.
6. Add adapters in this order: Backblaze webhook, Amazon SQS, Google Pub/Sub,
   Cloudflare Queue, then the optional Scaleway Cockpit integration.
7. Add periodic reconciliation and failure-injection tests for every adapter.

## Open questions

- What should happen in NuvoPic when a source object is deleted?
- Should overwriting a key preserve prior photo metadata or create a new logical
  photo version?
- Which caption and face-processing defaults should automatic imports use?
- What scan interval and request budget should apply at each bucket-size tier?
- Should native-notification provisioning be managed by NuvoPic, supplied as
  infrastructure templates, or both?
- How long should processed event records and failed jobs be retained?

## References

- [Amazon S3 event notification types and destinations](https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-how-to-event-types-and-destinations.html)
- [Google Cloud Storage Pub/Sub notifications](https://docs.cloud.google.com/storage/docs/pubsub-notifications)
- [Google Cloud Storage interoperability](https://docs.cloud.google.com/storage/docs/interoperability)
- [Cloudflare R2 event notifications](https://developers.cloudflare.com/r2/buckets/event-notifications/)
- [Cloudflare R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
- [Backblaze B2 event-notification reference](https://www.backblaze.com/docs/cloud-storage-event-notifications-reference-guide)
- [Backblaze B2 S3-compatible API](https://www.backblaze.com/docs/en/cloud-storage-call-the-s3-compatible-api)
- [Scaleway supported Object Storage API calls](https://www.scaleway.com/en/docs/object-storage/api-cli/using-api-call-list/)
- [Scaleway Object Storage logs collected by Cockpit](https://www.scaleway.com/en/docs/object-storage/reference-content/logs-metrics-collection-cockpit/)
