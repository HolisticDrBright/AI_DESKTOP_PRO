# Inventory interruption qualification

The fictional AWS database recovered safely in three controlled interruption cases on October 9, 2026: before write, before commit, and controller-receipt loss after the native adapter acknowledged COMMIT. The last case committed migration 107 permanently and recovery recognized it without retrying the write. These do not qualify a lost provider COMMIT response, disk power loss, the public writer end to end, the whole candidate fleet, or production activation. All six commercial-readiness phases remain incomplete.

## Source and tests

Engineering commit `41775fbd729e298ac6eb16569abc94cf613f9a19` pins AWS endpoints, credentials profile, region, target, single-attempt dispatch and request deadlines, and adds the real-core interruption worker. Its committed-source targeted suite passed 92 tests across eight files. Typecheck and lint passed.

The first hosted before-write attempt refused `exact_child_stop`: the child exited after sending its checkpoint, before the parent's deliberate stop. An unresolved Promise does not keep Node's default-unreferenced IPC channel alive. The existing compiled worker then recovered the original custody after the actual database fence settled; no write was retried. The journal and operator archive remain retained, and this failed attempt is not relabeled as passed.

Repair `0fb91307c30235288be25df68dafe4f1c3c18a79` retains the IPC channel until the parent stops the child and rejects the transaction callback if the parent disconnects. Two real-child regression cases prove it stays alive after the checkpoint and exits without admitting completion after parent loss. Its four-file suite passed 19 tests, with typecheck and focused lint passing; CI runs 37996342700, 37996338593 and 37996338844 later completed successfully. Dependencies use the existing junction, not a new clean lockfile installation.

Postcommit qualification source `6ea36e4ad5b2ad130681bb18b146f49ca396d196` requires the distinct literal confirmation `--confirm-fictional-inventory-postcommit-upgrade`, validates the real applied receipt before the checkpoint, and distinguishes controller receipt loss from provider response loss. The clean committed-source four-file suite passed 21 tests; typecheck and focused lint passed. Full regression at the earlier frozen `e68d42971d2831af21c5fc0bc698b7272df92bfe` passed 5,115 tests across 389 files, with 11 skips; that is not a full-suite result for later source.

[Node's documented IPC lifetime behavior](https://nodejs.org/api/child_process.html#optionsstdio) explains why an open IPC channel alone did not retain the original process.

## Hosted results

All runs used member profile `ai-synthetic-member`, account `588966314750`, Ohio region, `clinical_core_qualification`, and the original shared custody namespace. The before-write/precommit worker SHA-256 was `4fb904eed7c2c71fd9541443768d227a30a0c58c1f23d0828949a88c554c9975`; the postcommit worker SHA-256 was `0f7c66984626ce18f60156b1ecff1317e6951cf3b8042b6002868126a24e4e85`.

| Case | Durable run ID | Checkpoint | Recovery |
| --- | --- | --- | --- |
| Before write | `b0bde41c7795a71376992d6529adb338` | 106 migrations, commit not admitted | Preserved predecessor, passed |
| Before commit | `cb1d18875ac226fe427aba2b33181d6f` | Real 107-migration SQL and preservation checks inside an uncommitted transaction | Preserved predecessor at 106, passed |
| After acknowledged commit, before controller receipt | `088ef519071c7b5dd36cf855ca362798` | Provider COMMIT acknowledged, 107 migrations and preserved data independently observed | Preserved successor at 107, passed |

Each run refused recovery while its exact child was alive and immediately after its deliberate stop. After server settlement, recovery acquired the real operator fence and migration/table locks, verified repeated readbacks, preserved original journal bytes, and retired only owned lock files. Time alone did not establish settlement. Archives were not deleted, and the original admitted write outcome remains recorded as unknown.

All three readbacks preserved 46 fictional rows across the 209 historical tables. Data digest: `cbd17d4480be6ca45d6e20dfce06fdd49a374cb7bdcb27883d31cd110b4b14a4`. Historical schema digest: `f038481492c2d628411e31fb5d484815b16e9a7be82adeb064fab16eb2444a14`. Independent public read-only inspection at 6ea confirmed 107 migrations and those fingerprints. No candidate was deployed, provider activated, or PHI enabled.

## Remaining work

Lost provider COMMIT-response qualification and public-writer acceptance remain separate checks. Next complete database identity/role/connection isolation and non-human retention authority, the matched twelve-candidate fleet, and hosted positive and negative journeys. The identity-only mapping operator deliberately does not use the older combined fixture installer, which also inserts consent/provider approvals. Same-target clinical/catalog releases, Fullscript cart delivery, commerce and provider acceptance, matched mobile/Desktop releases and physical iOS/Android testing remain owed. Real reviews, executed agreement coverage and owner approvals cannot be replaced by these fictional-test results. PHI remains off and paid mobile builds remain held.
