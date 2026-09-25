# Existing invocation compatibility is not a new authorization grant

The owner preflight on September 25 confirmed that the production scheduler has
no OP_SA_TOKEN binding. Its old invoker unconditionally constructed a bearer from
that absent field. Requiring a newly invented fleet credential would not preserve
the deployed contract and would reintroduce a shared-secret rollout requirement.

The five existing default-Service-Binding registrations therefore explicitly use
`legacy-default`, not a falsely claimed authenticated shared-bearer contract. If
an existing bearer is configured, preserve it; otherwise omit the header rather
than send `Bearer undefined`. Each target's existing authorization still decides
whether the invocation is accepted. An authorization rejection remains a failed
job; no response is rewritten to success and no product auth code is changed.
The named UCC staging capability receives no fleet bearer and keeps its own
product credential handling. All new registrations must use named capabilities.

This is temporary compatibility, not proof that legacy public endpoints are
properly isolated. Product owners still must migrate those capabilities through
owning source/release paths, verify downstream effect idempotence and account
resource budgets, then retire default legacy registration. No new secret is
minted, copied, exported or distributed by this change.
