# Release integrity overnight: the return (2026-10-17)

**Scope:** source engineering only, with fictional data.

- **Not done:** no SQL applied; no AWS, Fly, Cognito, provider or SES write; no PHI; no real patient data; no paid EAS
  build; no force-push; no merge to `main`.
- **Not observed:** the hosted, device and human cases. This session's network refuses `*.fly.dev`, and I hold no AWS
  credentials.
- **What this is:** a trustworthy candidate that is still blocked. It is not a readiness figure.

## Heads

| Repository | Branch | Code commit (the pair) | Final head | Exact-head CI |
| --- | --- | --- | --- | --- |
| Desktop | `claude/desktop-campaign-account-safety-20261017` | `8bfe2349af869cbc0d93712fe6050300bb4ce4ab` | this document's commit (a document cannot name its own); docs only above `8bfe2349` | `8bfe2349`: [39007672640](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/39007672640) **success** |
| V2 | `claude/v2-release-integrity-20261017` | `dd704abf820de5556c5e6da9dcb39495c138fa87` | `1fb659aa00e8189ad8bede83f3276701fe8a7992` (kit rebind; `expo/release/` and `expo/docs/` only) | `dd704abf`: [39007636227](https://github.com/HolisticDrBright/AI_LONGEVITY_PRO_V2/actions/runs/39007636227) **success**; `1fb659aa`: [39008569020](https://github.com/HolisticDrBright/AI_LONGEVITY_PRO_V2/actions/runs/39008569020) **success** |

**Contributing branches** (pushed and left as they are):

| Branch | Head | Exact-head CI |
| --- | --- | --- |
| Desktop `claude/desktop-fullscript-ownership-20261017` | `d0933f19` | [39005920946](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/39005920946) success (was red at its parent: [39005014395](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/39005014395)) |
| V2 `claude/v2-account-isolation-20261017` | `23de11b9` | [39004466203](https://github.com/HolisticDrBright/AI_LONGEVITY_PRO_V2/actions/runs/39004466203) success |
| V2 `claude/v2-core-continuity-matrix-20261017` | `16078e2c` | [39006710883](https://github.com/HolisticDrBright/AI_LONGEVITY_PRO_V2/actions/runs/39006710883) success |
| V2 `claude/v2-dependency-advisories-r2-20261017` | `de698e14` | [39007445721](https://github.com/HolisticDrBright/AI_LONGEVITY_PRO_V2/actions/runs/39007445721) success |
| V2 `claude/v2-dependency-advisories-20261017` | `f79ed573` | [39006714028](https://github.com/HolisticDrBright/AI_LONGEVITY_PRO_V2/actions/runs/39006714028) success. **Superseded, not integrated.** It was built on a stale base; Codex's `bb00bc1` had already pinned Bun 1.4.3 and fixed `brace-expansion`. |

**Codex's work:**

- V2 `3185d3df` (CI [39004967434](https://github.com/HolisticDrBright/AI_LONGEVITY_PRO_V2/actions/runs/39004967434)
  success) is merged as the base of the V2 line.
- Desktop `agent/production-cognito-live-drift-20261017` (`f913e643`) is review-only and was still moving. It is not
  integrated; it is cited in the packet.
- Nothing of Codex's was overwritten.

## Per package

### R0: the three branches

**Fullscript red CI.**

- Run 39005014395 failed with a single error: `route.ts(36,57)` TS2322. `typeof outbox` in the queued item's annotation
  read the variable's narrowed type (`null`), so tsc refused the item.
- The fix names the outbox type once (`RevocationOutbox`) and uses it for both. It was applied to the Fullscript branch
  (`d0933f19`) and to the integration line (`1c0790cc`).
- Passing after: [39005920946](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/39005920946) and
  [39005270305](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/39005270305).
- `8bfe2349` merges `d0933f19` for ancestry. Its tree (`7420c88c`) is byte-identical to `1c0790cc`'s.

**The three behaviours, verified by their tests on the pair:**

| Behaviour | Tests | Result here | Failing before |
| --- | --- | --- | --- |
| A compromised-login campaign send pauses for review by a different, authorized staff member | `src/campaigns/send-authority.test.ts` | 22/22 | the first 20 failed on the unchanged engine (`docs/campaign-send-authority-2026-10-17.md` §1) |
| A Fullscript practitioner belongs to one Desktop account | `practitioner-ownership.test.ts`, `practitioner-ownership-callback.test.ts`, `revocation-reconciler.test.ts` | pass | against `a269552f`, a second account, a colleague and a racing pair were all installed, and the callback answered `connected` (`docs/fullscript-practitioner-ownership-2026-10-17.md` §1) |
| The revocation signal's timing | `src/integration/revocation-signal-timing.database.test.ts` | pass, with **3 expected failures**: the three OPEN races, kept as `it.fails` | `docs/revocation-signal-timing-2026-10-17.md` |
| Fictional labs and plans on a shared phone stay with the signed-in account | V2 `synthetic-account-isolation-journey` and six other failing-before suites | in the full V2 suite below | `expo/docs/claude-v2-account-isolation-2026-10-17.md` |

The five Desktop files above, run together on the pair: 75 passed, 3 expected failures, 0 failed.

### R1: release identity

**Source defect: the Fly synthetic image could not say what it was.**

- **Failing before:** a root laid out like the image's `/app`, with a valid `fly-synthetic-release/1`, gave
  `{"flyImageRecordPresent":true,"healthReleaseBefore":null}`. `/health` read only `patient-release.json`.
- **After:**
  - `readRuntimeRelease` reports whichever record the image carries, verified against the running bytes, and refuses
    otherwise.
  - `verify-live-release.mjs` (`release-verification/1`) is the credential-free judge.
  - CI now runs the built image with no network and reads its `/health`. The step is green at `dd704abf` in
    [39007636227](https://github.com/HolisticDrBright/AI_LONGEVITY_PRO_V2/actions/runs/39007636227/job/117323304139).
    That was the first real run; every earlier push was cancelled by the next.
- **Tests:** `__tests__/runtime-release-identity.test.ts`, 18.

**Deployment, which is Codex's:**

- The Fly API was reported answering `release:null`.
- The Desktop synthetic API it calls (`wxv734oi12`) is pinned in source to Desktop `5b6f8aa4`. The identity bundle
  `5b6f8aa4`'s source builds (`93dd1c70…`) differs from the pair's (`24a65189…`), built here without credentials.
  **Correction:** both digests depend on the build root through a symlinked `node_modules`. The comparison holds,
  since both came from the same layout, but neither digest is a pin (packet §2).
- That stack already advertises its source in `LambdaCodeKey`, so there is no source change there, only the hand-back.

Details: `expo/docs/claude-release-identity-2026-10-17.md` and the packet §3.

### R2: the five high advisories

- One is fixed: `http-cache-semantics` 4.2.0 → 4.3.0 by Codex's override-and-floor convention. Failing before: the floor
  gate refuses on `3185d3df`.
- Four are residual and pinned by `dependency-advisory-residuals.test.mjs`. None is in the patient API bundle or either
  JS export; they reach build hosts and the Fly image's disk.
  - `braces` 3.0.3 has no fixed release.
  - `image-size` 1.2.1 is patched; the fix is only in 2.x, which Metro does not accept.
  - `node-forge` 1.4.0 has no fixed release and no app caller.
- **Exact lock:** `de052f06…` → `ec9c5beb…`.
- No exception was approved and no major upgrade was made. Report: `expo/docs/claude-v2-dependency-advisories-2026-10-17.md`.

### R3: the Core continuity matrix

Run on the integrated V2 source (two accounts on one phone, background and return, offline and online, expired Core,
lost reply, second-device refresh; across labs, plans, meals, courses, export and erasure):

- **31 cells are coverage.** The behaviour was already correct, and is labelled as coverage.
- **5 are defects fixed:**
  - the defect: an unreachable session was told to sign in again, at 12 call sites;
  - the repair: `signInOrOffline`;
  - failing before: 4/4 in `offline-session-not-sign-in`.
- **1 is held:** `held-content-export-pin`, which is the person's own data under their privacy right; it is a draft for
  Brandon and counsel.

Doc: `expo/docs/claude-v2-core-continuity-matrix-2026-10-17.md`.

### R4: the hosted runners and Codex's packet

**V2:**

- The hosted guard runs before any authenticated request.
- `run-hosted-governed-recommendations.ps1` requires `-ExpectedSource` and refuses skipped or pending tests. PowerShell
  was not run here; it is reviewable text.
- The kit refuses hosted rows that do not name the exact observed source and qualification execution.
- Failing before: three new kit tests.

**Desktop:**

- The clinic-records runner and the shared-manifest acceptance CLIs already refuse stale source, skipped steps and
  unmarked answers. They are cited, not changed.
- The synthetic smoke scripts are listed as **inadmissible** evidence, with their lines.

Packet: `docs/codex-hosted-qualification-packet-2026-10-17.md`.

### R5: the kit rebind

- **The pair:** `index.json` and `release/preflight/manifest.json` name Desktop `8bfe2349` and V2 `dd704abf`.
- **The predecessor:** preserved as `index-2026-10-17-release-integrity-predecessor.json`, LF-byte SHA-256
  `98eaf5161030e8ce4697e6cfa6d2c079ae1ecb799bf8c536990d9d63f5b86867`.
- **Hashes:** the 25 candidate and 6 mirror hashes are carried unchanged. Each matches its file at the pair.
- **Withheld:** the nine external cases, the 51 preflight values and the store blockers.

## Verification

**Desktop at the pair:**

- **CI:**
  - `8bfe2349`: [39007672640](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/39007672640) **success**.
  - `1c0790cc`, the same tree: [39005270305](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/39005270305)
    success.
  - CI runs the full unit suite, typecheck, lint and the clinical build.
  - The packet commit `d57dce01` (docs and `CLAUDE.md` only) was still running when this was written:
    [39008586381](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/39008586381).
- **The browser battery:**
  - Run here on the tree both code commits share (`7420c88c`), with
    `env -u NODE_OPTIONS -u CLINICAL_SUPABASE_ANON_KEY E2E_DEV_HEAP_MB=6144 PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e:order`.
  - **PASS:** the same 328 tests passed in the forward and reverse orders, 0 failed or did not run.
  - 121 were skipped in each order by declaration. They are listed with their reasons and not counted.
  - 42 specs; no worker restarts; maximum heap 2,775 MiB.
- **`npm run check:stub-reset`:** PASS, 142 mutable bindings, every one covered.
- **The five behaviour suites in R0:** 75 passed and 3 expected failures.
- **The identity bundle builds:**
  - `8bfe2349`: `24a65189…`, 1,980,414 bytes.
  - `5b6f8aa4`: `93dd1c70…`, 1,878,599 bytes.
  - Both were built from the same scratch layout; they are layout-dependent and not pins (packet §2 correction).

**V2 at `dd704abf`** (the code pair):

- Full suite: 358 files passed, 1 skipped; 3,981 tests passed, 1 skipped.
- Typecheck and lint are clean.
- Launch acceptance 25/25 and release preflight 10/10. They are unchanged after the rebind at `1fb659aa`.
- Dependency floors pass; floors and residual tests 9/9.
- CI [39007636227](https://github.com/HolisticDrBright/AI_LONGEVITY_PRO_V2/actions/runs/39007636227) **success**. That
  run includes HIPAA baseline, capabilities, TestFlight checks, the production container, the exact-source Fly image
  run, the patient API bundle boundary and smoke, billing candidates, store readiness, both JS export inventories and
  `expo-doctor`.

## Unresolved, and what stays unobserved

- **The four hosted cases are unobserved and blocked on deployed drift** (packet §3):
  - `j1-hosted-registration-reset-mfa`
  - `j2-hosted-lab-analysis-delivery`
  - `j3-hosted-ask-alp-marker-fidelity`
  - `j5-hosted-program-and-message-round-trip`
- **The four device cases** and **the human case** are unobserved.
- **51 preflight values are unfilled.** The store blockers stand.
- **Four residual high advisories remain.** They are decisions, not approved exceptions.
- **Three OPEN revocation-signal races remain**, reproduced with `it.fails`.
- **The held device-export item remains**: `held-content-export-pin`.
- **The admissible Desktop runners have residuals:** no dirty-tree check in the shared CLIs, and the target is observed
  once.
- **The billing harness takes "observed" Lambda digests from an operator file.**
- **Production Cognito email auto-verification drift on both pools**, which is Codex's finding and not repaired.

## Hand-back

Codex: `docs/codex-hosted-qualification-packet-2026-10-17.md`, steps 1 to 10, from the code commits, with the rollback
checkpoints F0, D0 and Q0 recorded first.
