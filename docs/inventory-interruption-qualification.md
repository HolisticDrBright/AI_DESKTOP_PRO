# Inventory interruption qualification

The fictional AWS database recovered safely in two controlled interruption cases on October 9, 2026. These qualify the instrumented inventory core and native ports before write and before commit. They do not qualify post-commit receipt loss, disk power loss, the public operator end to end, the whole candidate fleet, or production activation. All six commercial-readiness phases remain incomplete.

## Source and tests

Engineering commit `41775fbd729e298ac6eb16569abc94cf613f9a19` pins AWS endpoints, credentials profile, region, target, single-attempt dispatch and request deadlines, and adds the real-core interruption worker. Its committed-source targeted suite passed 92 tests across eight files. Typecheck and lint passed.

The first hosted before-write attempt refused `exact_child_stop`: the child exited after sending its checkpoint, before the parent's deliberate stop. An unresolved Promise does not keep Node's default-unreferenced IPC channel alive. The existing compiled worker then recovered the original custody after the actual database fence settled; no write was retried. The journal and operator archive remain retained, and this failed attempt is not relabeled as passed.

Repair `0fb91307c30235288be25df68dafe4f1c3c18a79` retains the IPC channel until the parent stops the child and rejects the transaction callback if the parent disconnects. Two real-child regression cases prove it stays alive after the checkpoint and exits without admitting completion after parent loss. The final four-file suite passed 19 tests, with typecheck and focused lint passing. Both authorized engineering branches are remote-verified at that commit; its CI was still running at the evidence checkpoint. Dependencies use the existing junction, not a new clean lockfile installation.

[Node's documented IPC lifetime behavior](https://nodejs.org/api/child_process.html#optionsstdio) explains why an open IPC channel alone did not retain the original process.

## Hosted results

Both runs used member profile `ai-synthetic-member`, account `588966314750`, Ohio region, `clinical_core_qualification`, and the original shared custody namespace. Worker SHA-256: `4fb904eed7c2c71fd9541443768d227a30a0c58c1f23d0828949a88c554c9975`.

| Case | Durable run ID | Checkpoint | Recovery |
| --- | --- | --- | --- |
| Before write | `b0bde41c7795a71376992d6529adb338` | 106 migrations, commit not admitted | Preserved predecessor, passed |
| Before commit | `cb1d18875ac226fe427aba2b33181d6f` | Real 107-migration SQL and preservation checks inside an uncommitted transaction | Preserved predecessor at 106, passed |

Each run refused recovery while its exact child was alive and immediately after its deliberate stop. After server settlement, recovery acquired the real operator fence and migration/table locks, verified repeated readbacks, preserved original journal bytes, and retired only owned lock files. Time alone did not establish settlement. Archives were not deleted, and the original admitted write outcome remains recorded as unknown.

Both readbacks preserved 46 fictional rows across the 209 historical tables. Data digest: `cbd17d4480be6ca45d6e20dfce06fdd49a374cb7bdcb27883d31cd110b4b14a4`. Historical schema digest: `f038481492c2d628411e31fb5d484815b16e9a7be82adeb064fab16eb2444a14`. The permanent 107 upgrade was not applied; no candidate was deployed, provider activated, or PHI enabled.

## Remaining work

Post-commit receipt-loss qualification and public-operator acceptance remain separate checks. Then complete the preserving upgrade, database identity/role/connection isolation and non-human retention authority, matched twelve-candidate fleet, and hosted positive and negative journeys. Same-target clinical/catalog releases, Fullscript cart delivery, commerce and provider acceptance, matched mobile/Desktop releases and physical iOS/Android testing remain owed. Real reviews, executed agreement coverage and owner approvals cannot be replaced by these fictional-test results. PHI remains off and paid mobile builds remain held.
