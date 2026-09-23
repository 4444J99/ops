# ops — Plane (i) of the Tri-Plane Scheduler

**Always-on operations scheduler — the GitHub Actions cron backbone.**

## Activation Status: Parked (Non-Shippable)

- **Classification:** `docs-only-shell` / infra source-only
- **Status:** Parked (`status: parked` in `seed.yaml`)
- **Reasons for Non-Shippable State:**
  - Lacks explicit runtime manifest and deployment proof declared in repository root.
  - Kept strictly as infra source-only until a production owner re-authorizes activation.

---

This repository is **plane (i)** of a three-plane scheduling model. It is the always-on,
cloud-resident layer: cron-triggered GitHub Actions workflows that run whether or not any
human or local machine is awake. It produces durable artifacts (hygiene reports, bookend
logs) committed back into this repo, so the record of every run survives the runner that
made it.

---

## The three-plane model

Scheduling responsibility is split across three independent planes so that no single
failure domain can silence the whole system. Each plane has different liveness guarantees,
different failure modes, and different recovery paths.

| Plane | Carrier | Liveness | What it is good at |
|-------|---------|----------|--------------------|
| **(i) GitHub cron** | GitHub Actions `schedule:` | Always-on (cloud) | Org-wide reports, keepalives, anything that must run without a local machine. **This repo.** |
| **(ii) Local dispatcher** | A machine-local cron / launchd / dispatcher | Awake-only (host) | Tasks needing local secrets, local filesystems, or a real shell on the workstation. |
| **(iii) claude.ai routines** | Scheduled claude.ai agent routines | Account-resident | Reasoning-heavy, judgement-bearing recurring work that benefits from a model in the loop. |

The planes are **redundant by design**, not by accident. A report that plane (i) emits can
be cross-checked by plane (iii); a local task that plane (ii) misses (host asleep) can be
caught by a plane (i) witness flag. The unified audit surface that reconciles all three
lives in the sibling repo [`ops-witness`](https://github.com/a-organvm/ops-witness).

---

## The bookend contract

**Every scheduled job writes two lines: a `start` line when it begins and an `end` line
when it finishes.** This is non-negotiable — it is how the witness plane detects a job that
fired but died mid-run (a `start` with no paired `end`) versus a job that never fired at all
(no lines for that day).

Bookend lines are appended to `bookends/YYYY-MM-DD.tsv`, one TSV row per event, in this
exact shape (tab-separated), matching the local audit-log format so the two are directly
diff-able:

```
ts<TAB>job<TAB>-<TAB>-<TAB>start|end<TAB>status
```

- `ts` — ISO-8601 UTC timestamp
- `job` — the workflow/job name
- columns 3 and 4 — reserved (`-` here; carry detail in the local plane)
- phase — `start` or `end`
- status — `running` on the start line; `success` / `failure` on the end line

A job with no bookends is invisible to the witness. **A silent gap is a failure**, not a
non-event — the hygiene workflow counts private-repo `403`s explicitly as
`private-skipped` rather than dropping them, for exactly this reason.

---

## The stagger rule

**Never schedule on the hour.** A cron of `0 * * * *` (or `0 0 * * *`) lands in GitHub's
most-congested dispatch window, where scheduled workflows are routinely delayed or dropped
under load. Every workflow here uses an off-peak minute offset — the house offsets are
**:11, :17, :23, :36, :49** — and no two workflows share a minute. Staggering both dodges
the congestion window and spreads our own load so concurrent runs don't contend.

Current schedule:

| Workflow | Cron | When (UTC) |
|----------|------|------------|
| `org-hygiene-report` | `36 13 * * *` | daily 13:36 |
| `keepalive` | `23 5 * * 1` | Mondays 05:23 |

---

## The 60-day auto-disable hazard

GitHub **automatically disables scheduled workflows in a repository that has had no commit
activity for 60 days.** A pure-report repo can trip this: if every run only writes to
`reports/` via `[skip ci]`, the disable clock is what GitHub watches, and a quiet stretch
silently kills the backbone.

**Countermeasure — the keepalive workflow.** `keepalive.yml` runs weekly and does two
things:

1. Commits a touch to `.keepalive` (with a `[skip ci]` message) so the repo always shows
   recent activity and the 60-day clock never reaches zero.
2. Enumerates this repo's workflows and **re-enables any that GitHub has already
   auto-disabled** (`gh api --method PUT .../enable`), so even if the clock did run out
   once, the next keepalive heals it automatically.

The keepalive is the dead-man's-switch reset. It is the single most important workflow in
this repo — if everything else is disabled but the keepalive survives, the keepalive brings
everything else back.

---

## Nothing here is deleted

**Workflows are disabled, never removed.** A retired workflow is disabled
(`gh api --method PUT .../disable` or via the Actions UI) and left in `.github/workflows/`
with a note explaining why. Deleting a workflow file destroys its history and its bookend
lineage; disabling preserves both and remains reversible. The keepalive's re-enable logic
respects intent — it re-enables workflows GitHub auto-disabled for inactivity, which is an
accident, not a deliberate disable. (If you intend a workflow to stay off, that is a human
decision recorded alongside it.)

This mirrors the broader rule across these planes: archive, disable, or rename-with-
breadcrumb — never delete.

---

## Layout

```
.
├── README.md                            # this charter
├── .keepalive                           # touched weekly by keepalive.yml
├── .github/workflows/
│   ├── keepalive.yml                    # weekly: touch + re-enable auto-disabled workflows
│   └── org-hygiene-report.yml           # daily: org repo hygiene report + bookends
├── reports/                             # YYYY-MM-DD-hygiene.md (committed with [skip ci])
└── bookends/                            # YYYY-MM-DD.tsv (start/end lines per job)
```

---

## Sibling

- [`ops-witness`](https://github.com/a-organvm/ops-witness) — the unified audit surface that
  reads this repo's `bookends/` and flags any day a scheduled job ran without a paired
  bookend (the cross-plane witness).
