# Shared operations implementation

Parent: ../OPERATIONS.md and ops#6. This is source implementation, not a claim of
live deployment or of fully measured product resource budgets.

The existing manifest is the registration authority. Stable owner IDs, target
and controller environments, capability names, timeouts, cadence, continuation
policy, and dispatch allowances are checked by `npm run check:boundaries`.
Default/staging/retired configurations have no clock or product service binding.
Only the existing production scheduler may execute the current six registrations.
New enrollment requires named capabilities and fully accounted resource budgets.
The six existing legacy cost exemptions are explicit, not invented measurements.

`RunStore` and additive migration 0002 replace whole-fleet read/modify/write with
indexed per-run claims. A claim and its start record/reservation are atomic. At
most four runs are in flight across overlapping ticks, one unresolved run per
target, and four dispatches may start per tick. Per-target and 2,000/day fleet
attempt allowances are atomic and cannot be silently refunded after ambiguity.
These enforce dispatch counts, NOT all account-wide KV/D1/CPU usage. Product cost
instrumentation and current Cloudflare analytics remain necessary before growth.

Each result is recorded independently. Source revisions and attempts do not alter
logical idempotency identity. Queued ownership/resource/contract provenance cannot
be silently retargeted by changing a manifest. Expired/uncertain/accepted work
retains the target lock until product-owner reconciliation; no timeout is assumed
to mean that no business effect occurred. Legacy product handlers still own their
external effect deduplication. A dispatcher claim is not an exactly-once guarantee.

The legacy scheduler_state object is maintained only as an atomic witness
projection. Public health is storage-free; status reads a known key; bookends are
paged. No public request can enqueue, execute, reconfigure or deploy work.
No existing product queue, historical bookend, or recovery table is deleted.

## Release

All deployment logic is in this owner's `scripts/release.py`, read-only by
default. It requires an exact source SHA, known source repository, exact previous
live module identity, live bindings, one production clock, the existing D1
identity, and legacy credential presence. Unknown drift refuses the write. Apply
requires both `--apply` and `OPS_APPLY_SOURCE` equal to the accepted source SHA.
Use an existing authorized runner; never put a provider token in artifacts.

The additive install preserves old evidence. A strict-inheritance upload changes
only the existing scheduler Worker, preserving product bindings and its clock.
The replacement queues work during a 16-minute grace for previous cron lifetimes;
it then drains spare bounded capacity rather than retaining permanent catch-up
lag. The grace is not a completed cutover receipt. Read back deployed source,
bindings, admitted source, and actual run starts/completions after activation.
A failed ambiguous upload is not silently retried; admission is restored only
when the previous source can still be verified exactly.

Do not retire the existing incident witness before independent v2 evidence works.
Source CI, live preflight, deployment, actual execution, full-day resource use,
product backlog/freshness and remaining legacy capability migration are separate
acceptance gates. Existing UCC/VulnPulse failures stay open until real success.

Verification: `npm run typecheck`; `npm run check:boundaries`; `npm test`;
`npm run test:isolated`; `python3 -m unittest discover -s scripts -p 'test_*.py' -v`;
`npm run build`; `node scripts/verify-boundaries.mjs --emit`.
