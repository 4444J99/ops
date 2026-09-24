# Shared operations: agent boundary

Read [OPERATIONS.md](OPERATIONS.md) before changing shared scheduling, storage,
deployment, credentials, or cross-repository integrations. It extends the
GitHub-carrier-specific README; it does not claim that the target architecture
is already implemented or deployed.

## Authority

- `4444J99/ops` owns shared scheduling/admission and its own operational state.
- Product operators own their business logic, data, migrations, credentials,
  deployment artifacts and product completion receipts. `prds-ops` is the PRDS
  operator; it is not the fleet operator.
- Limen coordinates engineering work and routes repairs to the resource owner.
  It is not a second standing deployer for every product. `ops-witness` observes;
  it does not retry or deploy product work.
- Reuse existing CLAVIS implementation with product/environment-scoped authority.
  Never duplicate a vault or publish private configuration, data, or secret values.

## Change discipline

Use an isolated topic branch and the repository's existing PR/protection rail.
Do not overwrite another agent's active branch or deploy a sibling's resources.
A request for work is not permission to change its target's deployment or data.
One resource has one normal deployment owner; incident exceptions must be scoped,
exclusive, recorded, reconciled into owning source, and then retired.

Before any scheduler deployment, compare the plan with authenticated live
versions, bindings, triggers and state. Do not deploy current checked-in defaults
blindly: the September 24 source inspection found duplicate cron declarations and
source/live contract drift (OPERATIONS.md, migration section). This is a
resource-scoped preflight requirement, not an estate-wide implementation freeze.

Preserve legitimate jobs, queued work, data and historical evidence. No paid
upgrade, new service, credential enrollment, schedule cancellation or live cutover
is implied by this documentation. Extend the existing manifest rather than add a
parallel registry/controller. Record remaining work in ops#6; source tests,
deployment, actual execution and completed observation windows are separate gates.
