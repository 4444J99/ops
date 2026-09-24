# Shared operations: small core, independent products

Status: target architecture and agent boundary, recorded 2026-09-24. Runtime
migration remains OPEN in [ops#6](https://github.com/4444J99/ops/issues/6).
This document changes no live schedule, resource, credential or deployment.
It extends the GitHub-carrier-specific README to the shared Cloudflare domain.

## Ideal form

Share implementation; isolate authority. Many repositories may request work;
each resource has one authoritative owner, one normal deployment path, and one
truthful completion record. The system should permit independent progress and
make accidental cross-product mutation difficult, not merely discouraged.

Repository count is not the capacity unit. A product family may have many repos
but one operational boundary. Modules do not require new repositories, Workers,
queues or governance systems. Reuse the existing ops scheduler, product runtimes,
D1 stores, Limen, ops-witness and CLAVIS. Introduce another component only when a
measured capacity or security requirement cannot be met within those boundaries.

## Ownership

| Owner | Owns | Must not become |
| --- | --- | --- |
| `4444J99/ops` | Shared schedule/admission policy, binding declarations, dispatcher code, its execution leases and operational receipts, account budget allocation | A product runtime, business-data writer, universal secret store, or deployer of every product |
| Product operator, including `4444J99/prds-ops` | Product runtime, private queue/checkpoints, business data, migrations, resource configuration, product credentials and deployment | A second fleet scheduler or writer into another product |
| `4444J99/limen` | Engineering work coordination, scoped repair requests, evidence aggregation and its own runtime | A competing permanent scheduler/deployer for these same jobs |
| Existing `ops-witness` | Independent verification of expected runs, receipts, missing progress and observation gaps | A hidden retry scheduler or product-state writer |
| Existing CLAVIS implementation | Reusable credential-lifecycle software | One identity with authority over every product's secrets |

A production-hosted control plane may explicitly operate a staging product.
That does NOT authorize a staging/test controller to invoke production products.
Keep controller environment and target environment as separate contract fields.
No new product needs a dedicated `*-ops` repo merely to satisfy this table;
use its existing owner and keep private operational material private.

## Three interfaces, not a fleet-wide administrative API

1. Registration: the product owner declares a bounded capability and requests
   schedule/capacity. Ops accepts or rejects admission. Registration cannot
   create a Worker, grant credentials or choose arbitrary target URLs.
2. Invocation: ops invokes the admitted product capability. The product validates
   the contract, fences its own effects, and performs a bounded unit of work.
3. Receipt: the product reports an actual outcome. Ops records dispatch state;
   witnesses consume a safe projection without acquiring business-data authority.

Deployment is deliberately outside that runtime flow. Build/test/deploy remains
in the resource owner's release path. An engineering request from another repo
is handled through that owner's existing PR/runner, not by sending source code
or a Cloudflare administration token to the runtime scheduler.

### One contract record

Extend `cloudflare/src/manifest.ts` and its owning types rather than introduce a
second hand-maintained fleet manifest. Each admitted target needs:

- stable product/job identity; stable owning repository ID plus its current
  readable name; target environment; exact Worker and named capability;
- schedule or event eligibility, freshness deadline, enabled/lifecycle state;
- per-invocation work/CPU/request bounds, concurrency, retry/backoff and backlog
  policy; per-day allocation and the resource account it consumes;
- supported contract version, owner deployment workflow/environment, immutable
  release provenance, and completion/continuation evidence requirements.

Do not copy private account IDs, secret references or product internals into a
public manifest. Public records hold safe opaque references; the owning private
configuration resolves them. Generated provider configuration is a projection
with provenance, not another editable authority. Do not build a general plugin
framework or allow products to submit executable scheduler plugins.

New registrations fail closed for missing ownership, incompatible contracts or
unknown budgets. Existing traffic is not silently canceled by adopting this
design; unknown usage becomes an explicitly bounded migration item.

## Boundaries that must be executable

### Resource/deployment ownership

Identify a live resource by provider account, resource type, resource ID and
environment, not by an unqualified name. Its owner releases an immutable artifact
through one normal workflow/runner. Independent products deploy independently.
A release preflight checks current version, intended resource set, bindings,
triggers, migrations and authorization before publishing, then reads them back.

GitHub concurrency groups serialize within a repository; giving two repos the
same group name does not create a cross-repository deployment lock [G1]. Prefer
removing the second deployer over adding a distributed lock around two deployers.
If an incident exception is unavoidable, use the existing broker/lease authority
and one exclusive resource-scoped release actor, suspend only the competing
writer, record exact before/after versions, and reconcile the repair into owning
source before releasing that authority. A lease is not effective if another
writer can ignore it; provider writes must traverse the validating actor.

Do not assume Cloudflare API credentials can be narrowed to any arbitrarily
chosen Worker. Verify provider scope. Where credentials remain account-wide,
keep them in the approved release boundary, do not distribute them to product
runtimes, and report the residual administrative blast radius honestly.

### Invocation authority and environment isolation

Prefer a named Service Binding capability exposing only scheduled work. A
Service Binding can target a named WorkerEntrypoint and avoid public URLs [C1,
C2]. It does not justify an unauthenticated scheduling path on the default
public API. A path containing `/internal`, a hostname string, or a correlation
header is not authentication. Do not assume the caller's Cloudflare Access
context propagates downstream [C1].

A product cannot supply another product's binding or resource identity in a
payload. It cannot raise its allocation or grant itself a production role.
Capability upgrades require the owner/admission path. Contract changes use an
expand-then-contract rollout: product supports the new version, caller moves,
compatibility is verified, then the obsolete version is retired. Keep current
entrypoint names compatible until every consumer has migrated.

The dispatcher has its own operational D1 binding and only admitted invocation
bindings, not every product's DB/KV bindings, CRM keys, or deploy token. Product
operators resolve their own credentials using shared CLAVIS software with
isolated identities/destinations. A shared account remains a shared quota/failure
domain even when namespaces and repository names differ.

### Execution ownership and honest retries

One logical job has one schedule authority. Multiple providers/agents may request
it, but request identity does not create another clock. Start with the current
canonical runtime rather than provision a replacement. Any future replicas must
share the same authoritative claim/fencing system; replicas are not independent
schedulers.

Use indexed per-job/per-run D1 records with atomic conditional claims, owner,
lease deadline and fencing generation. Do not load and overwrite one whole-fleet
JSON object. A stale or timed-out invocation cannot acknowledge a newer lease.
Use the already-established broker for engineering/deployment leases; runtime
job claims belong to ops/product execution and do not create a competing agent
work board. Workers KV is eventually consistent and unsuitable for atomic
read-modify-write locks [C3].

A stable idempotency key identifies product + target environment + logical task
+ scheduled slot/event + business unit. Keep code SHA and retry attempt in
provenance, not the logical key: an ordinary deploy must not replay completed
business work under a new identity. Preserve cursor/checkpoint and all remaining
work across bounded continuations. Coalesce only tasks declared replaceable
(such as refresh-current-status), never distinct deliveries or financial events.

Retries are at-least-once attempts, not an exactly-once claim. A timeout means an
unknown outcome until reconciled, not proof that the target did nothing. The
product owns effect deduplication and downstream idempotency/outbox behavior.
The dispatcher may retry dispatch under the same key; it must not independently
retry the product's individual business effects. Await Service Binding calls;
fire-and-forget can terminate downstream work [C1]. An early `accepted` response
is valid only after durable queueing, and is never recorded as `completed`.

### Capacity without starving useful work

Admission reserves capacity before execution. A product's internal counter is
not an account-wide guard. For every constrained resource, require:

    sum(product allocations) + ops/witness overhead + reserve <= account allowance

Measure KV read/write/list/delete, D1 rows scanned/written (not merely query
count), invocation requests/CPU, concurrency, storage and retry costs. Include
all consumers, not just jobs known to the scheduler. KV bulk writes still count
per key; D1 batch statements still consume rows and index writes [C4,C5].

Allocate a conservative initial 20% reserve, then tune from actual evidence.
This is an engineering policy, not a provider guarantee. Unknown/uninstrumented
writers prevent a claim of hard global enforcement. Stale telemetry cannot
authorize spending fresh capacity. Avoid a central write on every DB query:
reserve a bounded allowance per job or small batch, enforce it locally, then
settle it with the receipt. Do not refund ambiguous in-flight reservations until
reconciled; charge retries to the same product allocation.

Use bounded fair dispatch across eligible products, with explicit priority and
freshness deadlines. Schedule by indexed next-due work rather than having every
repository poll every minute. A failed CVE feed must not consume the UCC retry
allocation or hold every other product's receipt behind a global Promise.all.
Defer work explicitly, record why and when it may resume, and expose queue age.
No silent disablement and no automatic paid upgrade.

The emergency one-record-per-pass setting is containment, not the ideal target.
Tune batch size from measured cost, reserve and completion latency. Verify that
sustained useful completion capacity exceeds incoming work; if it does not,
backlog grows even when every invocation is green. Low quota usage plus a stopped
pipeline is not success. New capacity must fit measured headroom; arbitrary
numbers of busy products cannot run indefinitely inside a fixed free allowance.

### Evidence and observability

Ops owns dispatch/claim evidence; products own business completion; ops-witness
checks independently. Emit a real start before effects and a terminal receipt
after them. Do not manufacture both bookends after all jobs have returned.
Retain logical key, attempt, owner/resource, contract version, source/deployed
version, timestamps, consumed budget, completed count, pending count/cursor,
and a sanitized error category. Private data and raw secrets never enter public
receipts.

Keep liveness (no storage), readiness, last successful work, current quota
pressure, data freshness and full-window verification distinct. Dashboards read
bounded snapshots; they never trigger ingestion, enumerate namespaces or write
heartbeat state. No-work ticks need not rewrite every product's status.
Record changes and bounded rollups; archive historical evidence before any
separately approved retention change. Monitoring must have a budget too.

## Migration from the inspected source

Baseline: ops `28bbc20ecee44ad3706b8a203ff05a0b3aa554e0`, inspected September 24.
These are source findings, not a new assertion that all three schedulers are
currently active in Cloudflare:

- `cloudflare/wrangler.toml` declares minute triggers for default, staging and
  production and binds staging to the same product Workers, including production
  UCC. The earlier live incident containment is not yet protected by this source.
- `cloudflare/src/types.ts` and `manifest.ts` lack the owner/environment/budget
  registration fields above. UCC's manifest entrypoint label is `runScheduled`;
  the incident integration uses a named capability. Reconcile actual bindings.
- `cloudflare/src/monitoring.ts` reads and overwrites one `scheduler:state` JSON
  record. Overlapping ticks can overwrite each other's target updates.
- `index.ts` records bookends only after `invokeAllTargets` returns; monitoring
  synthesizes start/end timestamps at that point. A crash can erase evidence
  that work started. `invoker.ts` fans out to every due target without an explicit
  fleet concurrency bound and uses one shared token field.
- The UCC repair was moved into its product owner in prds-ops#12. Do not replace
  that newer owning source with an old captured bundle. Existing temporary
  Limen recovery modules are transition artifacts, not a second permanent owner.

Execute four bounded tranches through existing owners. Do not use this document
as authorization for an immediate blind redeployment:

| Tranche | Owner | Acceptance |
| --- | --- | --- |
| 1. Source/live ownership reconciliation | ops for scheduler; each product operator for its Worker | Inventory existing live resources/versions; port outstanding incident behavior into owning source; normal and incident release paths cannot overwrite each other; default/staging cannot reactivate duplicate production clocks. Preserve jobs, data and bindings. |
| 2. Contract and isolation gates | ops plus existing product entrypoints | New registration, unauthorized target, duplicate resource owner, environment crossing and incompatible deployment tests fail closed. Additive rollout leaves current consumers working. |
| 3. Runtime claims, budgets and fairness | ops dispatcher; products for local queue/effects | Duplicate ticks produce one effect, stale completions are fenced, timeouts reconcile, one product cannot spend another's allocation, all job receipts persist independently. Test queue stability, not just invocation counts. |
| 4. Cutover, witness and retirement | owner release actor; ops-witness independently | Canary at unchanged intended workload; compare immutable artifact/deployment/receipt; demonstrate real completions and full UTC headroom; disable redundant writers with rollback and archive evidence. Retire temporary incident write paths only after replacement works. |

Use the existing incident as the parent and link narrowly scoped PRs. Do not add
a new scheduler, witness, credentials repository, standing automation, or parallel
registry to manage this migration. Do not touch active PRDS/engine work branches.

## Sources

[C1] https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/
[C2] https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/
[C3] https://developers.cloudflare.com/kv/concepts/how-kv-works/
[C4] https://developers.cloudflare.com/kv/platform/pricing/
[C5] https://developers.cloudflare.com/d1/platform/pricing/
[G1] https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency

Source inspection: the ops paths and immutable commit above; existing incident
https://github.com/4444J99/ops/issues/6. Provider docs checked September 24, 2026.
