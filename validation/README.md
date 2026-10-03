# Validation: with vs without Qloo

This is validation material, not an in-app feature. Everything below can be re-run with `pnpm t10`; see [`scripts/t10-compare.ts`](../scripts/t10-compare.ts) and the checks in [`scripts/t10-checks.ts`](../scripts/t10-checks.ts).

## Method

- **Cases**: 5 hypothetical cases with public artists. They were frozen on 2026-10-03 before the first Qloo business call: D1 and D2 for development ([`cases-D1-D2.json`](cases-D1-D2.json)) and H1–H3 held out until their first run ([`runs/round1-H1-H3/cases.json`](runs/round1-H1-H3/cases.json)). Name problems were fixed and logged before any ranking of the affected case, never because of a result:
  - Altın Gün and Nilüfer Yanya were confirmed as Qloo's spellings of the same artists;
  - Wyatt Flores and Briscoe (H2) have no matching Qloo entity, so they were removed from **both** versions.
- **Same everything except Qloo**: same model (`deepseek-flash`), same instructions, and the same case text from one builder. The effective shortlist is also the same: the acts Qloo can resolve and rank, listed in the team's input order so Qloo's ordering does not leak. The Qloo version also receives the rank table, the rule's choice and the two audience comparisons. The model-only version receives no Qloo data and may use labeled general knowledge.
- **Same follow-up**: each version vetoes **its own** first pick with the frozen reason. The target references are then edited as frozen: the Qloo version re-queries for real and keeps its veto; the model-only version gets the same new references.
- **Two runs per version per step**. All outputs are kept, including failures.
- **Automated checks** cover only rules and sources:
  - the pick is from the effective list, or is an explicit no-selection;
  - vetoes are respected;
  - backups are valid;
  - the Qloo version kept the rule's pick;
  - the model-only version never cites Qloo;
  - there are no percentages;
  - the model-only version writes no numeric ranks without data.
- **Whether Qloo helped is the author's judgement**, written separately below. It is not user research, and Qloo's ranks are never used to score the model-only version.

## Rounds

| Round | Instructions | Outputs | Automated checks |
|---|---|---|---|
| [round1-D1-D2](runs/round1-D1-D2/), [round1-H1-H3](runs/round1-H1-H3/) | first version | 60 | 60/60 pass. Re-checked later with the added rank check: 3 model-only briefs wrote numeric ranks without data |
| [round2-final-instructions](runs/round2-final-instructions/) | final, as deployed: ≤ 8 evidence items, no ranks without data, tie wording | 60 | 56 pass, 3 malformed model outputs (before the single retry was added), 1 skipped because its first step failed. No rule or source violations, and 0 ranks without data |

## Results (round 2; the Qloo version's picks were identical in both rounds)

| Case | Step | With Qloo (2 runs) | Without Qloo (2 runs) |
|---|---|---|---|
| D1 Phoebe Bridgers → Olivia Rodrigo, 5 acts | first pick | Lucy Dacus ×2 | Gracie Abrams ×2 (round 1: Clairo ×2) |
| | veto own pick | → Clairo ×2 | → Clairo ×2 |
| | + Billie Eilish | Soccer Mommy ×2 (tied with Clairo) | Clairo ×2 |
| D2 Khruangbin → Tame Impala, Mac DeMarco, UMO, 9 acts | first pick | Crumb ×2 | Men I Trust / Crumb |
| | veto own pick | → Babe Rainbow ×2 | → Crumb / Altin Gün |
| | − Mac DeMarco | Babe Rainbow ×2 | Parcels ×2 |
| H1 Mitski → Lorde, 6 acts | first pick | beabadoobee ×2 (exact tie with Japanese Breakfast) | Japanese Breakfast (1 malformed) |
| | veto own pick | → Japanese Breakfast ×2 | (1 skipped, 1 malformed) |
| | + Lana Del Rey | Japanese Breakfast ×2 | Japanese Breakfast / Weyes Blood |
| H2 Zach Bryan → Noah Kahan, Hozier, 6 acts | first pick | Charles Wesley Godwin (1 malformed) | Sierra Ferrell ×2 |
| | veto own pick | → Caamp ×2 | → Caamp / Charles Wesley Godwin |
| | Noah Kahan only | Caamp ×2 | Caamp ×2 |
| H3 The National → boygenius, 6 acts | first pick | Sharon Van Etten ×2 | Bartees Strange ×2 |
| | veto own pick | → Bartees Strange ×2 | → Sharon Van Etten / Courtney Barnett |
| | + Big Thief | Bartees Strange ×2 | Courtney Barnett ×2 |

## Author's assessment

| Case | What Qloo added | Call | What it still cannot show |
|---|---|---|---|
| D1 | The question protects the headliner's fans. The model-only picks (Gracie Abrams, or Clairo in round 1) rank 5/5 and 4/5 on the headliner side. The rule's pick, Lucy Dacus, ranks #1 on that side and #3 for the target. Adding Billie Eilish changes the pick (Soccer Mommy, tied with Clairo). The model-only answer did not respond to the new reference. | **Changed my judgement.** Clairo was my own first guess. The model-only version's sense of the headliner side roughly matched Qloo's order; the difference is a checkable trade-off rule. | Whether #3 on the target side is close enough. Ticket demand. |
| D2 | L'Impératrice cannot be ranked, so she is flagged and removed. One-sided acts are traceable (Glass Beams #1 headliner / #7 target). The pick is stable while the model-only picks vary between runs. | **Kept the same first pick** (Crumb). Help was limited. Stability comes from a deterministic rule and is not evidence of quality. | Differences between the three references: Qloo compares them as one group, so only the model-only version answered that part. |
| H1 | My frozen guesses (Weyes Blood, Faye Webster) rank 4/4 and 5/6. The two leaders are an exact tie, and the brief says so. | **Changed my guess, not the model-only pick**, which fell in the same tie. | Which of the tied pair to choose. |
| H2 | The model-only pick, Sierra Ferrell, ranks last (6/6) for the target audience. The rule picks Charles Wesley Godwin (#2 / #3). After the veto, both versions converge on Caamp. Two of the eight acts are not in Qloo. | **Changed the first pick.** | Coverage of smaller country acts. |
| H3 | The rule picks Sharon Van Etten (#1 headliner, #4 target), but the team asked about younger listeners. The model-only pick, Bartees Strange, is the rule's #2 (4 / 3). | **Disagreement I cannot settle.** This exposes a limit of the rule: it optimizes the weaker side and cannot weight the target side. | Which is closer to real young-indie audiences. |

Summary: Qloo gave traceable evidence that contradicted the model-only pick in 2 of 5 cases (D1, H2), and it corrected the author's guesses in D1 and H1. It added little in D2, could not settle H3, and could not answer the three-reference question in D2. The model-only version's picks moved between runs and between rounds.
