# ADR 0003: Metadata-first automatic event tags

- Status: Proposed
- Date: 2026-08-12
- Owners: NuvoPic maintainers

## Context

NuvoPic needs automatic event groupings: named sets of photos for a holiday,
wedding, birthday, day out, or similar event. A photo may belong to more than
one grouping, and a delay of up to one week between importing a photo and
detecting the grouping is acceptable.

"Automatic album" can mean several different products:

1. Preserve a source folder or mobile-device album. No inference is required;
   the source has already supplied the membership.
2. Maintain a rule-based album, such as every photo containing a selected
   person. Membership is a saved query and may span many unrelated events.
3. Discover an event: infer that a group of otherwise unorganized photos was
   captured as part of the same occasion or trip.

This ADR decides the third behavior. NuvoPic will expose it through one unified
tag abstraction rather than adding albums or preserving separate "tag" and
"smart tag" product concepts. A tag may have explicit, query-computed, or
detector-computed membership. In particular, "all photos of Alice" is a
query-computed tag and must not be treated as one inferred event.

NuvoPic already stores several useful signals:

- capture time and its precision and source;
- GPS coordinates and a reverse-geocoded location name when available;
- the source object path;
- BLIP-generated descriptions;
- face clusters and named people;
- image dimensions and processing-model versions.

It does not currently store a general image embedding, perceptual hash,
camera/device identity, or detected-event membership. The existing Modal and
Vast.ai GPU abstraction can expose more output from the current caption model
or run a replacement open-weight vision model, but the result still needs a
deterministic clustering and persistence layer in NuvoPic.

False merges are more damaging than false splits. A user can merge two
suggestions easily, but finding unrelated photos hidden inside a large
automatically created grouping erodes trust. The first release will therefore
optimize for precision and present generated event tags as reviewable
suggestions.

### Relevant behavior in Ente and Immich

As of 2026-08-12, neither project provides a complete precedent for general
event-album creation, but both provide useful components.

| Product | Current behavior | Lesson for NuvoPic |
| --- | --- | --- |
| Ente | Face detection and grouping run on device. A user can choose named people for a Smart Album, after which matching photos are added automatically. Ente also computes curated trip memories on the client with explicit time, location, home/base, duration, and minimum-photo rules. | Keep people albums distinct from event discovery. Time and location rules are strong enough to generate useful trip candidates without asking a generative model to reason over an entire library. Ente's end-to-end encryption explains its client-side execution; NuvoPic can perform the equivalent work in its workspace data plane. |
| Immich | Mobile album sync and the CLI preserve device albums or folder names. Facial recognition uses embedding clustering derived from DBSCAN, with incremental assignment and a nightly pass for unassigned faces. Contextual search uses CLIP-family embeddings. | Preserve explicit source structure rather than re-infer it, store reusable embeddings, and make recurring clustering an idempotent background job. Face clustering and semantic search do not by themselves create event albums. |
| Immich roadmap | Rule-based Smart Albums and event/location/people Smart Memories are still listed as future work. | Do not describe Immich's folder mirroring, face groups, or search results as automatic event detection. |

The useful common pattern is specialized extraction followed by deterministic
product logic. Neither system sends the whole library to an LLM and accepts its
event memberships as authoritative.

## Decision drivers

- Event membership must be explainable from observable photo signals.
- Incorrect cross-event merges must be rare and reversible.
- A weekly run must survive restarts and be safe to retry.
- New imports with old capture dates must be compared with the appropriate old
  photos, not only with photos imported during the last week.
- Explicit tag membership, saved queries, and user corrections must never be
  overwritten by a detector.
- The system must still produce useful results when GPS, faces, captions, or
  image embeddings are missing.
- GPU work should be performed once per photo and reused, rather than sending
  every possible photo pair through a model on every run.
- The design must remain provider-neutral even when Modal is the first inference
  provider.
- Model, feature, scoring, and detector versions must be recorded so results
  can be reproduced and migrated deliberately.
- Private photos and derived biometric or semantic data must stay inside the
  workspace and its explicitly configured processing providers.

## Decision

NuvoPic will create **suggested event tags** once per week using a
metadata-first, constrained clustering pipeline.

The detector will combine capture-time continuity, location, source path,
recognized people, and visual-semantic similarity. Time is the primary event
boundary. The remaining signals can strengthen or weaken a link, but neither a
shared person nor similar visual content can bridge a large time gap by itself.

NuvoPic will initially avoid adding a third learned-model family. It will
benchmark an image representation from the existing BLIP vision encoder, then
benchmark replacing BLIP with a joint caption-and-contrastive model such as
CoCa. A dedicated image encoder such as DINOv2 is added only if it materially
improves event retrieval over both shared-model options. A generative LLM or
vision-language model will not decide which photos belong together. It may
later propose a short label from a few representative photos after membership
has been fixed.

```text
Imported photos
      |
      v
Reusable per-photo features
(time, GPS, path, people, pHash, visual embedding)
      |
      v
Candidate-pair generation ------> explicit must-link/cannot-link feedback
      |                                      |
      v                                      v
Explainable pair scoring ---> constrained event clustering
                                      |
                                      v
                       stable suggested event tags
                                      |
                       +--------------+-------------+
                       v                            v
            accept/edit with                   dismiss
         persistent constraints          and suppress repeats
```

### Unified tag semantics and lifecycle

NuvoPic will not add a separate `albums` domain model, and it will converge the
current `tags` and `smart_tags` into one logical `tags` model. They all name a
set of photo IDs and otherwise duplicate labels, counts, filtering,
permissions, URLs, and navigation. "Smart" describes how membership is
computed; it is not a separate object type or a separate user-facing feature.

The unified tag supports three membership strategies:

- `explicit`: membership rows chosen by a user or copied exactly from a source
  folder or device album;
- `query`: a dynamic typed expression from ADR 0004, such as all photos of a
  person or all photos matching a saved filter;
- `detector`: materialized, versioned membership maintained by the automatic
  event detector.

Classic tags therefore remain useful as the `explicit` capability, especially
for arbitrary curation that no query or detector can infer. They do not remain
as a separate product feature. Existing `tags`/`photo_tags` and `smart_tags`
records will be migrated behind the unified API instead of introducing a third
kind of collection.

An automatic-event tag begins in `suggested` state and is displayed in an
**Automatic tags** review surface. It is not mixed into the user's accepted tag
list until accepted. Suggested and accepted tags may gain or lose
detector-owned members in a later weekly run.

User edits become durable constraints instead of disabling the smart behavior:

- accepting changes visibility, not membership semantics;
- changing the label or cover marks that field as user-owned so the detector
  cannot overwrite it;
- adding a photo records `must_link` evidence;
- removing a photo records `cannot_link` or an event-specific exclusion;
- merging or splitting records the corresponding pair or boundary feedback.

An explicit **Stop automatic updates** action sets `auto_update = false` and
turns the current membership into a snapshot. The detector may then offer a
separate "new matching photos" suggestion but must not modify the snapshot. A
dismissed suggestion retains only the membership fingerprint and detector
version required to suppress the same or a near-identical suggestion;
dismissal does not delete photos.

Explicit, query-computed, source, and event-snapshot tags are never candidates
for detector rewrites. A detector version will assign a photo to at most one
automatic event tag. This prevents several near-duplicate event suggestions.
Future detector profiles, such as trips or celebrations, may intentionally
introduce a separate overlapping namespace.

### Evidence for linking photos

The detector interprets each signal according to its reliability:

| Signal | Use | Important guardrail |
| --- | --- | --- |
| Capture time | Primary boundary and strongest continuity evidence | Only `exact` and suitable `day` precision values may seed an event. Unknown, year-only, and month-only dates do not establish chronology. |
| GPS coordinates | Strong evidence for the same place or a plausible journey | Distance is evaluated together with elapsed time. GPS is optional and one photo with bad coordinates must not split an otherwise strong session. |
| Location name | Coarse fallback and useful label input | A shared city or country alone is too broad to link distant dates. |
| Source path | Strong prior when photos share a meaningful, non-generic parent folder | Generic camera, upload, screenshots, year, and month folders are ignored or down-weighted. Folder mirroring remains a separate exact feature. |
| Recognized people | Supporting evidence and useful label input | The same person can appear over decades and cannot bridge a hard temporal boundary. Unknown face clusters may contribute without exposing a name. |
| Visual embedding | Supporting evidence for a coherent activity, scene, or occasion; useful when GPS is missing | Similar sunsets, meals, receipts, or screenshots are common. Semantic similarity is never a global must-link rule. |
| Generated description | Textual supporting evidence and deterministic label input | Captions may be generic or wrong and are versioned with the caption model. |
| Perceptual hash and capture sequence | Collapses near duplicates and strengthens bursts | A burst is not necessarily a complete event and still needs temporal context. |
| Camera/device metadata | Optional future supporting feature | Shared hardware is common and never sufficient by itself. |

Hard negative evidence overrides weak positive evidence. Examples include a
large temporal discontinuity, mutually incompatible precise locations for the
elapsed time, an explicit user `cannot_link` correction, or an accepted event
boundary. Conversely, a user merge records `must_link` feedback that future
versions should honor unless the source photos are deleted.

### Detection algorithm

The detector will use five stages.

#### 1. Prepare reusable features

Feature extraction is incremental and versioned. Ordinary metadata remains in
the `photos` table; model-derived or replaceable event features are stored
separately. New photos should receive these features during normal processing.
The weekly job queues missing or stale features before clustering and can fall
back to the available metadata when inference fails.

NuvoPic will select the first learned image feature with a staged benchmark,
not by adding a model before measuring the two-model pipeline already in use:

1. **Existing BLIP baseline.** The current
   `Salesforce/blip-image-captioning-base` checkpoint contains a vision encoder.
   NuvoPic will expose a documented, L2-normalized whole-image representation
   from that encoder in the same versioned inference contract as the caption.
   A caption-fine-tuned checkpoint is not assumed to produce a good retrieval
   metric; this is a low-cost benchmark that must pass event-neighbor recall and
   false-match tests before use. Salesforce archived the upstream BLIP
   repository in March 2026 and explicitly marks it deprecated, so this is a
   migration baseline rather than the preferred long-term dependency.
2. **Preferred unified replacement candidate: CoCa.** OpenCLIP's CoCa models
   are trained with both contrastive and captioning objectives and expose both
   image encoding and caption generation. If an appropriately licensed CoCa
   checkpoint matches or improves BLIP caption quality and the event-retrieval
   benchmark within the serving budget, it will replace BLIP and emit both
   `caption` and `image_embedding`. This keeps NuvoPic at two learned-model
   families: CoCa plus the face pipeline.
3. **Dedicated fallback: DINOv2.** If both shared-model representations are
   inadequate, NuvoPic may add `facebook/dinov2-small` as a specialized
   image-to-image encoder. Its 22-million-parameter, 384-dimensional ViT-S/14
   representation and Apache-2.0 terms make it a reasonable fallback, not the
   default third model.

SigLIP2 remains a candidate if natural-language image search becomes more
important than caption generation, but it does not itself replace the caption
decoder. Qwen3-VL-Embedding is an Apache-2.0 multimodal retrieval model that
accepts images, text, and video, but its embedding checkpoint does not generate
captions and its 2B/8B sizes are unnecessarily large for the first weekly
event-neighbor pass. It is a retrieval benchmark, not a way to consolidate
captioning and embedding into one checkpoint. DINOv3 is not a default because
its custom model license is less straightforward for a hosted product than
DINOv2's Apache-2.0 terms.

The benchmark compares caption usefulness, same-event neighbor recall,
false-positive rate on repeated scenes, GPU time, peak memory, vector size, and
backfill cost on the same representative library. The active model, embedding
dimension, exact preprocessing, pooling, normalization, inference provider,
and feature version are persisted. Vectors from different feature versions are
never compared.

#### Similar and near-duplicate photos

One embedding is not sufficient for every meaning of "similar." NuvoPic will
use a three-level cascade:

1. A source content checksum detects byte-identical files exactly.
2. A CPU-cheap perceptual hash, initially pHash plus a crop-resistant fallback,
   detects the same image after resize, JPEG recompression, mild color changes,
   or cropping by Hamming distance.
3. Versioned visual-embedding cosine similarity retrieves visually related
   photos, including burst frames and alternate compositions of the same scene.

The event detector keeps near duplicates in the event tag but collapses them
when enforcing minimum distinct-photo counts and selecting a cover. It does not
delete or stack them. An embedding match alone is not labeled a duplicate: two
different sunsets, portraits, or receipts can have close embeddings. Likewise,
pHash thresholds are calibrated on NuvoPic photos rather than copied as a
universal constant. Candidate pairs are validated with capture time, image
dimensions, aspect ratio, and, when needed, a direct pixel-difference check.

#### Face analysis remains specialized

NuvoPic will not use a whole-image caption or contrastive embedding as a person
identity embedding. Face recognition needs face detection and alignment plus a
separate embedding for each detected face, calibrated across pose, lighting,
age, and background changes. A general multimodal model may caption "three
people" but does not provide the reliable boxes and persistent identity metric
required by the people feature.

The target pipeline therefore has two learned-model families, not one universal
model and not three independent models:

```text
CoCa (or the existing BLIP baseline) -> caption + whole-image embedding
specialized face pipeline           -> face boxes + per-face embeddings
CPU deterministic features          -> checksum + perceptual hashes
```

NuvoPic currently loads InsightFace `buffalo_l`. InsightFace's code is MIT, but
its distributed pretrained model packs are documented as non-commercial
research only unless separately licensed. Before a hosted or commercial
release, NuvoPic must either obtain and record suitable rights for the exact
weights or replace them. OpenCV Zoo's YuNet detector and SFace recognizer have
permissive model licenses and are the first commercially clearer pair to
benchmark; this ADR does not assume that their quality equals `buffalo_l`.

#### 2. Generate plausible candidate pairs

NuvoPic will not compare every photo with every other photo. Candidate pairs
are generated through bounded indexes:

- neighbors inside a configurable capture-time window;
- photos in the same meaningful source parent;
- time-nearby photos within a plausible geographic radius or travel path;
- the top semantic neighbors, restricted to an already plausible time or path
  block;
- photos sharing one or more face clusters, again restricted by time.

This blocking makes the cost close to linear in the library size and prevents
a global semantic neighbor from linking visually similar events years apart.
On the initial backfill all eligible photos are considered. Incremental runs
start with photos imported or materially changed since the previous successful
run and retrieve old neighbors around each photo's **capture time**, path,
location, and accepted candidate blocks.

#### 3. Score `same_event` evidence

Each candidate pair receives a feature vector and an explainable score similar
to:

```text
same_event_score = f(
  elapsed_time,
  capture_density_between_photos,
  geographic_distance_and_travel_speed,
  meaningful_path_match,
  people_overlap,
  visual_similarity,
  caption_similarity,
  duplicate_or_burst_relation,
  negative_and_user_constraints
)
```

The first release will use reviewed, versioned weights and thresholds. Once
NuvoPic has consented feedback and a representative evaluation set, the scorer
may become a calibrated logistic-regression or small gradient-boosted model.
It must still consume the same named features and emit per-feature
contributions. A generative model response is not an acceptable score.

Thresholds are library-policy values rather than constants hidden in code. The
bootstrap policy for the first shadow evaluation will be:

| Rule | Initial value | Rationale |
| --- | --- | --- |
| Short-event seed | Consecutive exact-time photos no more than 6 hours apart | Covers meals, parties, ceremonies, and day outings without spanning an ordinary overnight gap. |
| Supported extension | Up to 24 hours when at least two of precise location, meaningful path, people overlap, or strong visual similarity agree | Keeps a sparse day event together without trusting one weak signal. |
| Short-event hard boundary | 72 hours between any adjacent sessions and 7 days total | Prevents recurring people or scenes from chaining weeks together. This profile is not used for trips. |
| Same-area evidence | Within 25 km, evaluated with elapsed time | Tolerates movement inside a city or venue region; a smaller learned distance feature still gives closer photos more weight. |
| Minimum suggestion | 5 distinct photos after perceptual near-duplicate collapse | Avoids flooding the UI with tiny bursts while retaining common small events. |
| Semantic neighbors | At most the 20 nearest vectors inside an already valid time block | Bounds work and prevents visually similar photos from linking globally. The similarity cutoff is model-specific. |
| Cluster cohesion | Every photo must have one strong link, and the cluster must pass a minimum internal-link-density check | Prevents single bridge photos from merging two otherwise separate groups. |

These numbers are starting hypotheses, not compatibility promises. The policy
will use adaptive capture gaps: dense shooting can justify a shorter boundary,
while sparse capture requires stronger independent evidence. Shadow-mode
evaluation may tighten the values before user-visible rollout. Changes after
rollout require a new policy version and must not mutate frozen event tags.

#### 4. Form constrained clusters

High-scoring pairs are assembled with constrained agglomerative clustering,
not plain graph connected components. Before adding a photo or merging two
sets, the complete candidate set must continue to satisfy cluster-level rules:

- no hard `cannot_link` pair;
- an acceptable maximum internal time gap and total duration for its event
  profile;
- geographically plausible movement when precise GPS is present;
- sufficient internal link density, so a chain of weak edges cannot join two
  unrelated groups;
- a minimum number of distinct photos after near-duplicate collapse;
- size and duration caps that prevent a whole camera roll, year, city, or
  recurring person from becoming one tag.

This intentionally permits a false split at an ambiguous boundary. Adjacent
high-confidence sets may be shown with a merge affordance, and that correction
becomes future `must_link` evidence.

The detector can apply event profiles without changing the unified tag
abstraction.
A short occasion expects hours of continuity; a trip may span days, but needs
coherent away-from-home location or meaningful path evidence. Trip detection
will follow the same staged pipeline and can be enabled only after the short
event profile is validated.

#### 5. Rank, label, and reconcile

Clusters below the display-confidence or minimum-size policy are retained only
as run diagnostics and do not create suggestions. A surfaced cluster receives:

- a stable detector key derived from its detector version, temporal bounds,
  coarse location, and stable member sample;
- a confidence and the strongest human-readable reasons;
- a deterministic default label from the best available location, date range,
  named people, and caption keywords;
- a cover selected for quality, faces, semantic centrality, and duplicate
  diversity.

Reconciliation matches a newly detected set with an existing auto-updating
event tag using member overlap plus compatible time and location bounds. It
updates the existing ID when there is one clear match. Splits and merges retain
the most-overlapping ID and record superseded IDs so links do not silently
change meaning. All changes are staged and committed only after a complete run.

### Weekly scheduling and durability

Automatic detection runs once every seven days per workspace with jitter, so
all workspaces do not begin at the same instant. A manual **Detect events now**
action may enqueue an early run but cannot create a concurrent run.

The NuvoPic scheduler, not Modal, owns the weekly schedule. It creates a durable
`event_detection` job in the workspace PostgreSQL queue described by ADR 0001.
Hosted deployments may use the control plane to enqueue jobs; self-hosted
deployments may use a data-plane scheduler protected by a PostgreSQL lease.
Both execute the same worker contract.

Modal supports cron schedules, but using a provider schedule as the authority
would couple workspace discovery, enable/disable state, retries, and audit
records to one GPU provider. Modal is therefore an inference executor only.
The worker may send missing feature batches to Modal or Vast.ai through the
existing `GpuClient`, then performs candidate generation, scoring, clustering,
and database reconciliation in the NuvoPic data plane.

Every run records its input watermark, policy and model versions, counts,
duration, cost, warnings, and terminal status. Only one run may hold the
workspace lease. Repeating a completed job with the same input snapshot and
versions must yield the same memberships and must not create duplicate smart
tags.
A failed or partial run publishes no membership changes and can be retried.

### Role of a generative LLM or cluster-level vision-language model

A shared vision-language encoder may emit captions and reusable embeddings, but
its outputs remain input features to deterministic event scoring. A general
generative LLM is the wrong primitive for membership because it would require a
large and changing library context, produce nondeterministic answers, obscure
why two photos were linked, and repeatedly charge for facts already captured
in embeddings and metadata.

An optional open-weight vision-language model on Modal may be evaluated for
**labeling only**. It receives a bounded sample of representative thumbnails and
sanitized metadata from one completed cluster and must return schema-validated
JSON containing a short label and optional summary. It cannot add or remove
members, cannot overwrite a user label, and has a deterministic metadata-only
fallback. This call is disabled by default until its privacy, latency, label
quality, and cost are measured.

### Data model

An indicative schema is:

```text
tags                        # unifies current tags and smart_tags
- id
- label
- membership_kind           # explicit, query, detector
- origin                    # user, source, automatic_event
- expression                # only for query membership
- expression_version
- state                     # active, suggested, accepted, dismissed
- auto_update
- detector_version
- detector_key
- confidence
- explanation
- cover_photo_id
- label_source              # user, deterministic, vlm
- cover_source              # user, deterministic
- snapshotted_at
- created_at
- updated_at

tag_photos                  # explicit and detector membership; query tags use AST
- tag_id
- photo_id
- membership_origin         # user, source, detector
- confidence
- reasons
- created_at
- PRIMARY KEY (tag_id, photo_id)

detected_events             # detector metadata; exactly one associated tag
- tag_id                    # primary key and foreign key to tags
- detector_version
- detector_key
- started_at
- ended_at
- coarse_location
- membership_fingerprint
- created_at
- updated_at

photo_event_features
- photo_id
- feature_kind              # visual_embedding, perceptual_hash, ...
- model_id
- model_version
- value or vector
- created_at
- PRIMARY KEY (photo_id, feature_kind, model_id, model_version)

event_detection_runs
- id
- status
- input_watermark
- detector_version
- policy_version
- feature_versions
- photos_considered
- candidates_scored
- suggestions_created
- suggestions_updated
- error
- started_at
- completed_at

event_detection_feedback
- id
- relation                  # must_link, cannot_link, dismissed_set
- left_photo_id
- right_photo_id
- membership_fingerprint
- created_at
```

Large vectors and detailed diagnostic contributions need not be returned by the
ordinary tag API. Explanations should be compact product strings such as
"34 photos taken in Lisbon over 3 days" and may list supporting named people
only when the current user is authorized to view them.

### Privacy and security

- Feature extraction follows the workspace's existing processing-provider
  consent and configuration. Enabling automatic event tags does not silently
  enable a new external GPU provider.
- The inference request contains the minimum image derivative and identifiers;
  it does not contain object-storage credentials or an entire event manifest.
- Face embeddings, image embeddings, pair features, and tag explanations are
  workspace-scoped private data.
- Logs contain counts, versions, timings, and opaque IDs, not image data,
  captions, coordinates, person names, or signed object URLs.
- Disabling automatic event tags stops new runs. Derived event features and
  dismissed fingerprints follow a documented deletion and retention policy.
- User feedback is not pooled across workspaces for training without a separate
  explicit consent and anonymization decision.

## Consequences

### Positive

- Weekly work is predictable, retryable, and inexpensive compared with
  repeatedly prompting a large model.
- Time and location provide understandable boundaries while embeddings improve
  results for libraries with incomplete GPS or weak folder organization.
- The same feature vectors can later support visual search, duplicate review,
  cover selection, and memories.
- Reviewable suggestions, user-owned fields, and durable membership constraints
  prevent detector churn from undoing curation.
- Provider-neutral scheduling keeps Modal optional and allows batch inference
  on Vast.ai or future providers.
- Versioned features and policies allow controlled backfills and reproducible
  evaluations.

### Negative

- There is no universal definition of an event, so thresholds require a real
  evaluation corpus and ongoing tuning.
- A stored image embedding adds storage, indexing, inference work, and
  historical backfill costs even when it comes from the caption model.
- Missing or imprecise timestamps substantially reduce detection quality.
- Unifying the existing tag tables requires a compatibility migration, and
  suggested/accepted states plus materialized detector membership add schema
  complexity.
- Stable reconciliation across cluster splits and merges is more complex than
  recreating every suggestion on each run.
- A one-week cadence means automatic event tags are not immediately available.

### Risks and mitigations

- **Two events are merged through a chain of photos:** use hard time
  boundaries, complete-cluster validation, internal-density requirements, and
  a high display threshold.
- **One event is split:** show temporally adjacent suggestions together, make
  merge easy, and retain the resulting `must_link` feedback.
- **Recurring people or scenes create giant tags:** prohibit people or
  semantic similarity from crossing hard time boundaries and cap cluster span.
- **Bad EXIF dates poison chronology:** respect `taken_at_precision` and
  `taken_at_source`, detect implausible outliers, and let users correct dates.
- **A model upgrade reshuffles old tags:** pin each tag to its detector and
  feature versions, run replacements in shadow mode, preserve user constraints,
  and require a deliberate version migration.
- **Weekly jobs overload the database or GPU:** add workspace jitter, bounded
  batches, leases, candidate blocking, concurrency limits, and resumable
  feature extraction.
- **Suggestions become spam:** require minimum size and confidence, rank them,
  cap new suggestions per run, and remember dismissals.
- **LLM labels hallucinate sensitive or wrong details:** keep VLM labeling
  optional, sample narrowly, validate output, show label provenance, and never
  let it affect membership.

## Alternatives considered

### Ask an OSS multimodal LLM on Modal to form every event tag

Rejected for membership. The model would need too many images and metadata in
one context, pairwise or chunked prompts would be costly and inconsistent, and
the result would be difficult to reproduce or explain. Modal remains suitable
for batched embeddings and optional bounded label generation.

### Group only by time gaps

Rejected as the final detector. It is a valuable baseline and the primary
boundary signal, but it merges unrelated activities on photo-heavy days and
splits sparse holidays or events. It also cannot use the strong path, location,
people, and visual evidence NuvoPic already has or can extract cheaply.

### Run DBSCAN or HDBSCAN over one combined vector

Rejected as the public semantics. Encoding time, kilometers, people sets,
paths, and visual vectors into one distance makes units and missing values hard
to calibrate. Density-based clustering can also join events through a chain of
border points. Specialized candidate generation and constrained cluster rules
make the evidence and failure modes clearer. Density clustering may still be
used inside a single feature extractor, as it is for face recognition.

### Create accepted event tags silently with no review state

Rejected for the initial release because false positives would pollute a user's
curated collection and later detector versions could change membership without
clear ownership. Acceptance can become automatic for very-high-confidence
workspace policies after measured production results.

### Recompute the entire library every week

Rejected for steady state because it repeats expensive feature extraction and
pair scoring. A full versioned backfill remains available for the first run,
model migrations, policy evaluation, or explicit administrative repair.

### Treat folders, people, and events as one detector rule

Rejected because their membership semantics differ. A folder is explicit
source truth, a people tag is a dynamic query across time, and an event tag is
an inferred bounded set. They share one tag model and UI without sharing the
same membership implementation or detection rules.

## Implementation outline

This ADR does not authorize or include implementation. The intended sequence is:

1. Complete ADR 0004's versioned filter expression model and design the
   compatibility migration from `tags`/`photo_tags` and `smart_tags` to one tag
   API with `explicit`, `query`, and `detector` membership strategies.
2. Add the `automatic_event` origin and lifecycle fields, materialized tag
   membership, event records, run records, feedback constraints, stable
   fingerprints, and the review surface.
3. Build a deterministic time-gap baseline and a labeled evaluation harness
   using curated event sets; run it without surfacing suggestions.
4. Add path normalization, GPS distance and travel features, face-set overlap,
   perceptual hashes, and cluster-level constraints one at a time, measuring
   their effect on false merges and splits.
5. Extend the inference contract with a versioned whole-image embedding from
   the current BLIP encoder and benchmark it. In parallel benchmark a CoCa
   replacement that emits caption plus embedding. Add DINOv2 only if both fail
   the retrieval target, then backfill the selected feature in bounded batches
   through Modal or Vast.ai.
6. Implement durable weekly enqueueing, per-workspace leases, jitter,
   incremental neighbor retrieval by capture time, and transactional
   reconciliation.
7. Run at least one detector version in production shadow mode, recording
   aggregate diagnostics but creating no user-visible tags.
8. Release suggested event tags with accept, dismiss, merge, split, add, remove,
   explanation, and "detect now" controls.
9. Tune thresholds from opt-in feedback while preserving user labels, covers,
   and membership constraints and replaying a fixed benchmark on every change.
10. Evaluate trip profiles and optional Modal VLM naming as separate follow-up
    changes.

## Acceptance criteria

- Given the same photo snapshot, feature versions, policy, and feedback, two
  runs produce the same event memberships and stable suggestion IDs.
- A weekly job is durably recorded, mutually exclusive per workspace, safe to
  retry, and publishes no partial membership changes on failure.
- A newly imported old photo is evaluated against neighbors around its capture
  time and can update an existing auto-updating event tag.
- Explicit, query, source, and snapshotted event tags are never modified by a
  detection run.
- Every suggested event tag exposes concise time/location/path/people/semantic
  reasons without leaking inaccessible metadata.
- A shared person or high visual similarity alone cannot link photos across the
  configured hard temporal boundary.
- Dismissing, splitting, or merging a suggestion prevents the unchanged
  detector from immediately recreating the rejected result.
- Missing GPU features degrade to metadata-only detection rather than failing
  the whole weekly run.
- Membership precision, false-merge rate, suggestion acceptance rate, and
  compute cost meet agreed release thresholds on representative small, medium,
  and large libraries before suggestions are enabled by default.
- No LLM or VLM response can directly mutate event membership.

## Open questions

- What minimum photo count and confidence should surface a suggestion for the
  first evaluation cohort?
- What representative library sizes and maximum weekly CPU, database, GPU, and
  wall-clock budgets define the release benchmark?
- Should exact source-folder tags be implemented before event suggestions,
  and which generic path segments should be excluded by default?
- Should detector-version migrations update accepted auto-updating tags after a
  preview, or create parallel replacement suggestions?
- Does the existing BLIP vision representation meet the retrieval target, or
  does CoCa improve caption-plus-embedding quality enough to justify replacing
  BLIP? Only if both fail: does DINOv2 justify a third learned model?
- How long should dismissed-set fingerprints, pair explanations, and obsolete
  feature versions be retained?
- Should precise GPS be rounded or omitted in user-visible explanations even
  though it remains available to the workspace detector?

## References

- [Ente Photos product features: on-device face recognition, curated memories, and Smart Albums](https://ente.io/)
- [Ente Smart Album people synchronization source](https://github.com/ente-io/ente/blob/dbe29ebb7d175c7e7ae1250eee66cb6f6a191c48/mobile/apps/photos/lib/services/smart_albums_service.dart)
- [Ente trip-memory detector source](https://github.com/ente-io/ente/blob/dbe29ebb7d175c7e7ae1250eee66cb6f6a191c48/mobile/apps/photos/lib/services/smart_memories_trip_calculator_v2.dart)
- [Immich mobile backup album synchronization](https://docs.immich.app/features/mobile-backup/)
- [Immich CLI folder-to-album creation](https://immich.app/docs/features/command-line-interface)
- [Immich facial-recognition clustering](https://immich.app/docs/features/facial-recognition)
- [Immich contextual CLIP search](https://docs.immich.app/features/searching/)
- [Immich roadmap: Smart Albums and Smart Memories](https://immich.app/roadmap)
- [BLIP official repository and feature-extraction architecture](https://github.com/salesforce/BLIP)
- [NuvoPic's current BLIP caption checkpoint](https://huggingface.co/Salesforce/blip-image-captioning-base)
- [OpenCLIP CoCa image encoding and caption generation](https://github.com/mlfoundations/open_clip)
- [CoCa: Contrastive Captioners are Image-Text Foundation Models](https://arxiv.org/abs/2205.01917)
- [LAION CoCa ViT-B/32 checkpoint](https://huggingface.co/laion/CoCa-ViT-B-32-laion2B-s13B-b90k)
- [DINOv2 model card, retrieval use, and Apache-2.0 license](https://github.com/facebookresearch/dinov2/blob/main/MODEL_CARD.md)
- [DINOv2 ViT-S/14 model](https://huggingface.co/facebook/dinov2-small)
- [SigLIP2 base model and Apache-2.0 license](https://huggingface.co/google/siglip2-base-patch16-224)
- [Qwen3-VL-Embedding model family and Apache-2.0 license](https://huggingface.co/Qwen/Qwen3-VL-Embedding-8B)
- [DINOv3 custom model license](https://github.com/facebookresearch/dinov3/blob/main/LICENSE.md)
- [InsightFace code and pretrained-model licensing notice](https://github.com/deepinsightface/insightface)
- [OpenCV Zoo models and licensing](https://github.com/opencv/opencv_zoo)
- [OpenCV SFace model license](https://github.com/opencv/opencv_zoo/blob/main/models/face_recognition_sface/LICENSE)
- [OpenCV YuNet model documentation and license](https://github.com/opencv/opencv_zoo/blob/main/models/face_detection_yunet/README.md)
- [ImageHash perceptual and crop-resistant hashing](https://github.com/JohannesBuchner/imagehash)
- [Modal batch processing](https://modal.com/docs/guide/batch-processing)
- [Modal scheduled functions](https://modal.com/docs/guide/cron)
