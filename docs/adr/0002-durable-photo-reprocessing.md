# ADR 0002: Durable photo reprocessing

- Status: Accepted
- Date: 2026-08-12
- Owners: NuvoPic maintainers

## Context

User-triggered reprocessing previously ran synchronously inside the HTTP
request. Restarting the data plane terminated the batch, left its log and GPU
metering reservation running, and lost the original selection. The import
workers could not recover it because reprocessing had no persistent queue.

Reprocessing may be forced, path-scoped, or based on a filtered photo
selection. Re-evaluating the filter after a restart is not sufficient: the
underlying collection may have changed, and forced work cannot use model
versions to distinguish completed items from unfinished ones.

## Decision

NuvoPic will snapshot each accepted reprocess selection into PostgreSQL as one
`reprocess_jobs` row and one `reprocess_job_items` row per photo. The HTTP API
returns `202 Accepted` after that transaction commits. A workspace-aware worker
claims jobs using row locks and processes their pending items in bounded
batches.

Workers hold a renewable lease. When a process disappears, an expired lease
moves its in-flight items back to pending, subject to the retry limit. Completed
item rows are never selected again; an item interrupted before its result is
committed may be processed again, so the photo write path remains idempotent.

Each queue job owns the top-level reprocess log shown in Logs. The log moves
through queued, running, and completed states and includes aggregate successes
and failures. A separate status endpoint lets the initiating UI monitor the job
without keeping the original request open.

GPU metering uses a unique external identifier for every claimed batch. If a
worker lease expires, recovery settles or cancels the interrupted batch's
reservation through the existing idempotent metering outbox before retrying the
remaining work.

## Consequences

- Deployments and local restarts no longer lose accepted reprocessing work.
- The exact selected photo set survives changes to filters or collection state.
- Forced reprocessing resumes from persisted item state rather than restarting
  the entire selection.
- Processing is at-least-once for an item that was in flight at the instant of
  process failure; database photo updates must remain idempotent.
- Reprocess progress is available through Logs and the job status API.
- The queue and item tables add workspace database storage proportional to the
  number of accepted reprocess selections.
