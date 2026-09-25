# Dormant scheduler containment

The live September 25 preflight found that staging had both a reactivated minute
clock and a newly changed compiled module. The owner release does not whitelist
that unknown module for execution or overwrite it with the new production code.
It narrows the operation instead: read the exact dormant module/settings, verify
that its Service Bindings address only already-registered product capabilities,
clear only the dormant scheduler trigger, and PATCH the dormant Worker's settings
without uploading code. Non-service bindings retain their provider-held values.
Readback must prove unchanged source bytes, retained non-service bindings, no
product Service Bindings and no cron. Extra unregistered capabilities and any
prewrite source/settings drift fail closed.

Production remains under the original exact known-module/artifact guard. Its
clock cannot be paused and its product bindings cannot be removed by the dormant
containment methods. This supersedes the dormant-code replacement procedure in
PR #14; it is an authority reduction, not acceptance of another agent's source.
Normal owning configuration has no dormant clocks/bindings. An external actor
with account-wide administrative credentials could still reintroduce them; that
residual authority must remain explicit, and live witness must detect recurrence.

Official settings API, checked September 25, 2026:
https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/edit/
The PATCH uses multipart form field `settings` and retained `inherit` bindings.
