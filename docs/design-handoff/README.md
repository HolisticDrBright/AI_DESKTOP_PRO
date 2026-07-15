# Handoff: AI Longevity Pro — Clinical Intelligence (Desktop Web App)

## Overview
Desktop-first practitioner platform for a premium longevity / functional-medicine clinic. It combines patient health intelligence (labs, biomarkers, sleep/wearables, supplements, N-of-1 experiments) with practice operations (review queue, tasks, appointments, team workload) and a differentiated AI layer (clinical reasoning snapshot, evidence for/against, contextual AI assistant, command palette).

This handoff covers **Phase 1**: the desktop shell, the flagship Patient Overview (Summary) screen, the Practice Dashboard, the ⌘K command palette, and the AI assistant drawer. The full product spec (all 15+ screens) is included as `product-spec.txt` — later phases should follow it.

## About the Design Files
The files in this bundle are **design references created in HTML** — interactive prototypes showing intended look and behavior, **not production code to copy directly**. The task is to **recreate these designs in the target codebase** — the user intends a **React + TypeScript** front end (backend to be added later; where data is needed, use clearly isolated typed mock adapters that can later be replaced with tRPC queries).

The `.dc.html` files use a custom prototype runtime: the markup between `<x-dc>` tags is the template (inline styles = the exact intended CSS), and the `class Component` script holds all mock data and interaction logic. Read them as the source of truth for styling values and data shapes.

- `Clinical Intelligence v2.dc.html` — **PRIMARY reference.** Matches the approved visual direction.
- `Clinical Intelligence.dc.html` — earlier v1 (glassier shell, patient header variant, sectioned/collapsible sidebar). Reference only; where v1 and v2 differ, **v2 wins**.
- `product-spec.txt` — the user's full written product spec (information architecture, all screens, accessibility, AI guardrails). Implement future screens from this.

## Fidelity
**High-fidelity.** Recreate pixel-perfectly: exact hex colors, px sizes, radii, and copy below. Use the codebase's component library conventions but match this rendering.

## App Shell

### Layout
- Min supported width 1280 px; primary viewport 1440×900. Root: `display:flex; height:100vh`, font `Inter` (fallback ui-sans-serif / SF Pro), base 14px, color `#182A3D`, background `#F1F4F8`, `font-variant-numeric: tabular-nums` globally (biomarkers, scores, dates all tabular).
- Subtle atmospheric background on content area only: `radial-gradient(1100px 560px at 72% -12%, rgba(37,99,199,0.05), transparent 65%), radial-gradient(900px 520px at 6% 108%, rgba(13,92,99,0.04), transparent 60%)`.
- **Material tweak**: surfaces support a `solid | glass` mode. Glass mode adds `backdrop-filter: blur(22px) saturate(1.5)` to sidebar/top bar/patient-header-card. Default: solid. (User currently prefers **glass**.)

### Sidebar (236 px, fixed)
- Background `rgba(248,250,252,0.9)`, right border `1px #E4EAF1`.
- macOS traffic lights (11px dots: `#F5655B`, `#F6BD3B`, `#43C64C`) at top.
- Brand: 36px rounded-10px tile, gradient `linear-gradient(135deg,#0D5C63,#1A7A82)` (brand teal), white activity-pulse icon; "AI Longevity Pro" 14/700 + "Clinical Intelligence Platform" 10.5px `#7288A1`.
- Flat nav list (17 items, in order): Overview, Clients, Health Twin, Timeline, Labs & Biomarkers, Clinical Reasoning, Supplements, N-of-1 Lab, Protocols, Wearables, Assessments, Quantum Mind, Reports, Tasks (badge 8), Messages (badge 3), Integrations, Settings.
- Item: 13px, padding 8px 10px, radius 9px, icon 17px Lucide-style stroke 1.75. Idle: `#44586E` w500. Active: bg `#E9F0FB`, border `1px #D7E3F5`, text `#1B4FA5` w600. Hover: `rgba(37,99,199,0.06)`. Count badges: pill, `rgba(90,107,126,0.12)` bg, `#5C6F82` text 11/600.
- Bottom (above border-top `#E9EFF5`): "Viewing as / Practitioner" white card (teal user icon tile `rgba(13,92,99,0.1)`, chevron) + "Help Center" ghost row.
- Icons: **Lucide** (the design system mandates lucide; the prototype embeds equivalent hand-paths — in production use the real `lucide-react` icons: Home, Users, Activity, Clock, FlaskConical, GitBranch/Network, Pill, TestTube, ClipboardList, Watch, FileText, Sparkles, BarChart3, CheckSquare, MessageCircle, Link, SlidersVertical).

### Top bar (58 px)
- Bg `rgba(250,252,253,0.85)`, bottom border `#E4EAF1`.
- Search: 400×36 pill (radius 99), white, border `#E4EAF1`, placeholder "Search patients, labs, reports, protocols…" `#8A9BAC`, trailing `⌘K` kbd chip. Opens command palette.
- Right cluster: "Assistant" violet pill button (border `rgba(116,97,201,0.3)`, bg `rgba(116,97,201,0.07)`, text `#5D4BB5`, sparkles icon) · bell (36px circle) · messages circle with red dot `#D6544A` · profile pill (32px avatar circle gradient `#2563C7→#5B8AD9` initials "SM", "Dr. Sarah Mitchell" 12.5/600 + "Functional Medicine" 10.5 `#7288A1`, chevron).

## Screens

### 1. Patient Overview / Summary (default screen — flagship)
Route suggestion: `/patients/:id/summary` (also the app's "Overview").

**Patient header card** (full content width, white `rgba(255,255,255,0.92)`, border `#E4EAF1`, radius 16, padding 18px 22px):
- 56px avatar circle, gradient `#0E8388→#3BA5A5`, initials "AM".
- "Alexandra Morgan" 17/700 + small blue venus glyph; "34 y/o · Female · 04/12/1992"; "Patient ID: P-78435" (12.5px `#5C6F82`).
- Vertical divider, then 3 columns (label 11.5/600 `#7288A1`, value 12.5px `#33475C`):
  - **Primary Goals**: "Improve energy, sleep quality, hormone balance, reduce inflammation"
  - **Care Team**: "Dr. Sarah Mitchell (You)" / "Holistic Health Coach · Registered Dietitian"
  - **Last Visit** May 10, 2026 · **Next Visit** Jul 21, 2026
- Right: primary button **"New Appointment"** (36px, radius 9, bg `#2563C7`, hover `#1B4FA5`) + 36px "…" icon button.

**Body grid**: `minmax(0,1fr) 296px`, gap 18. Left column starts with a tab bar; right column is a persistent rail.

**Patient tabs** (underline style, border-bottom `#E4EAF1`): Summary · Health Twin · Timeline · Labs · Clinical Reasoning · Supplements · N-of-1 Lab · Protocols · Reports. Active: `#1B4FA5` w650 with 2px `#2563C7` underline. Others currently show a designed "next design phase" placeholder card.

**Row 1** — grid `210px 1.15fr 1fr 1fr`, gap 16. All cards: white, border `#E4EAF1`, radius 14, padding 14px 16px, header 13/700 (some with a small info icon `#B9C9D9`).
1. **Health Score**: SVG ring (r=52, stroke 10; track `#EDF2F6`, progress `#22B573` at 78%), "78" 32/700 + "Good" 12.5/600 centered; footer "↑ 6 pts vs last month" in `#1F9D63`.
2. **System Balance**: octagonal radar chart, 8 axes: Metabolic .78, Hormonal .55, Inflammation .45, Detox .70, Sleep & Recovery .60, Energy .50, Gut Health .72, Stress .52. Fill `rgba(34,181,115,0.14)`, stroke `#22B573` 1.75, dots r2.2, ring/spoke grid `#E4EAF1`/`#EDF2F6`, labels 9.5/600 `#7288A1`.
3. **Top Priorities**: numbered list (19px circle `#EEF3FC`, number `#5C6F82`): Support sleep quality / Reduce systemic inflammation / Balance cortisol rhythm / Optimize mitochondrial function. Footer: full-width outline button **"View All Priorities"** (32px, border `#DCE5EE`, text `#2563C7` 12/600).
4. **Risk Flags**: rows with 24px warning-triangle tile (amber `#C77E14` on `#FBF3E4`; coral `#D6544A` on `#FBEDEC`): "Low Vitamin D (24 ng/mL) — Monitor", "Elevated hs-CRP (2.8 mg/L) — Review", "High Cortisol (AM) — Monitor". Footer button **"View All Risks"**.

**Row 2** — grid `1.25fr 1.1fr 1fr`, gap 16.
1. **Biomarker Trends**: segmented control (track `#F1F5F9`, active white chip w/ shadow): "Key Biomarkers" | "All Biomarkers". Rows (name 12/600 + unit 10px; fluid sparkline; value 12.5/700 + status 10/600 colored):
   - hs-CRP mg/L → 2.8 **High** (coral, declining line)
   - Vitamin D ng/mL → 24 **Low** (amber, rising)
   - Ferritin ng/mL → 45 **Optimal** (green, flat)
   - Cortisol (AM) µg/dL → 21.3 **High** (coral)
   - Omega-3 Index % → 6.2 **Optimal** (green, rising)
   - Footer link "View All Biomarkers".
2. **Sleep & Recovery**: segmented "7 Days" | "30 Days". Inner tile (border `#EDF2F7`, radius 12): "Sleep Score" label, **72** 30/700, "Good" green, plus green trend polyline. Stat grid 4×(bg `#F7FAFC`, radius 10): Avg Sleep 7h 12m · HRV (Avg) 68 ms · Resting HR 54 bpm · Recovery 78%. Footer "View Sleep Details".
3. **N-of-1 Experiments**: violet pill "Active Experiments" (`#5D4BB5` on `rgba(116,97,201,0.1)`). Two experiment tiles (border `#EDF2F7`, radius 12): name + "Day 7 of 14" / "Day 5 of 21"; goal line; blue progress bar (`#2563C7` on `#EDF2F6`) with % ; "Primary Outcome / Deep Sleep ↑ 18%" and "Muscle Tension ↓ 22%" — direction pill green (`#1F9D63` on `#E9F6EF`). Footer "View All Experiments".

**Row 3 — Clinical Reasoning Snapshot** (full-width card): header "Clinical Reasoning Snapshot" 14/700 + gray chip "Updated Jul 12, 2026" + right amber chip "Awaiting practitioner review". 4 columns (`1.15fr 1fr 1fr 1fr`, hairline dividers `#F1F5F9`):
- **Top Hypotheses**: numbered rows w/ violet strength chips (82, 74, 68 — `#5D4BB5` on `rgba(116,97,201,0.1)`): "Inflammatory burden — Contributing to fatigue, poor sleep" / "Cortisol dysregulation — Contributing to sleep disruption" / "Mitochondrial dysfunction — Contributing to low energy". Footnote 9.5px `#8A9BAC`: "Strength reflects internal evidence weighting — not a medical probability." **(Regulatory guardrail: never present these as medical probabilities.)**
- **Key Evidence For** (green circled checks `#22B573`): Elevated hs-CRP (2.8 mg/L) / High AM cortisol (21.3 µg/dL) / Poor sleep efficiency (72%) / Low vitamin D (24 ng/mL).
- **Key Evidence Against** (coral circled X `#D6544A`): Normal TSH, Free T3, Free T4 / No anemia or iron deficiency / Normal fasting glucose / Good HRV trend.
- **Recommended Next Steps** (bullets): Optimize sleep environment / Support cortisol rhythm / Reduce inflammatory triggers / Recheck Vitamin D in 8 weeks. Footer link "View Full Analysis" → Clinical Reasoning tab.

**Footer strip**: "● All systems operational" (green dot `#22B573`) left; "Data updated: 2 min ago ⟳" right; 11.5px `#8A9BAC`.

**Right rail (296 px, persistent)** — three white cards:
1. **Alerts & Notifications** — rows with 30px circular icon tiles: flask/violet "New lab results available — Jul 11, 2026"; clipboard/coral "3 items await your review — Clinical reasoning updated"; moon/blue "Sleep experiment ready for review — 7-day analysis complete"; sun/amber "Vitamin D recheck recommended — Based on last labs". Link "View All Notifications".
2. **Tasks** — header with small blue "+ New Task" button. Checkbox rows (15px, border `#B9C9D9`) with patient name + priority chip: Review new lab results / Alexandra Morgan / **High** (coral); Approve sleep protocol / Alexandra Morgan / **High**; Update supplement plan / Michael Johnson / **Medium** (amber); Review assessment / Jessica Parker / **Low** (slate). Link "View All Tasks (8)".
3. **Upcoming Appointments** — 30px avatar initials (AM teal `#0E8388`, MJ blue `#2563C7`, JP violet `#7461C9`) + name + "Jul 21, 2026 · 10:00 AM / 11:00 AM / 2:00 PM". Link "View Calendar".

### 2. Practice Dashboard (via sidebar "Clients")
Header "Practice dashboard" 20/700 + date line; status "All integrations connected · synced 2 min ago".
- **Stat row** (6 clickable cards, each routes to a filtered view): Active clients 48 (+3 this month) · Needing review 7 (2 urgent) · New lab results 5 (3 abnormal) · Active programs 12 (86% engaged) · Overdue tasks 4 (oldest 6 d) · Appointments 6 (today). Card: label 12/600 `#5C6F82`, value 24/700, colored 26px icon tile.
- **Review queue** (main card): rows = type chip + title + patient/time + priority pill + chevron. Types: Safety alert (coral) / Lab extraction (`#3D5A80` on `#E8EEF5`) / Reasoning update (violet) / Protocol approval (blue) / Experiment approval (teal). Sample rows in prototype.
- **New abnormal biomarkers** & **Experiments completed** cards (2-col). Experiment conclusions use cautious vocabulary chips: "Likely beneficial" (green), "Inconclusive"/"No measurable effect" (slate).
- Right rail: **Risk changes this week** (avatar + "Moderate → High" colored words), **Low adherence** (name + % + colored bar + detail), **Team workload** (avatar + blue bar + "N open").

### 3. Command Palette (⌘K / Ctrl+K, Esc closes, backdrop click closes)
Centered 620px dialog on `rgba(24,42,61,0.32)` blurred backdrop; panel `rgba(255,255,255,0.94)` + `backdrop-filter: blur(28px) saturate(1.6)`, radius 16, shadow `0 24px 64px rgba(24,42,61,0.22)`. Search input row + "esc" chip. Groups: **Actions** (Add note N, Upload lab report U, Start N-of-1 experiment E), **Patients** (initials tiles), **Go to** (Overview G O, Practice dashboard G P, Clinical Reasoning G R). Footer hint bar: ↑↓ navigate · ↵ open · tab ask assistant.

### 4. AI Assistant Drawer (top-bar "Assistant" button)
Fixed right panel 392px, inset 12px, radius 20, glass (`blur(28px) saturate(1.6)`), 3px violet gradient top edge (`#7461C9→#9D8DE8`).
- Header: sparkles tile, "Clinical Assistant", context "Alexandra Morgan · data through Jul 12, 2026", close ×.
- Suggestion chips (violet outline pills): "Why is her sleep score declining?" / "Summarize labs since April" / "Draft a follow-up note".
- Answer block (violet-tinted `rgba(116,97,201,0.04)`): each statement carries a **provenance badge** — Measured (`#3D5A80` on `#E8EEF5`), Patient-reported (teal), AI inference (violet). **Every AI output must show fact-vs-inference labels, sources used, date range, missing information, and review status.**
- "Sources used" chips: Oura wearable · 30 d / Labs · May 13 / Daily check-ins · 14 d / Visit notes · 2. "Missing information" paragraph.
- Footer: amber notice "Not reviewed — assistant output requires practitioner review."; buttons "Insert into note" + "Explain reasoning"; input "Ask about this patient…".

## Interactions & Behavior
- Sidebar items and patient tabs switch views client-side (SPA routing). Stat cards / queue rows / risk rows navigate to relevant views.
- Keyboard: ⌘K/Ctrl+K toggles palette; Esc closes palette + drawer. Palette input autofocuses.
- Hover: cards lift border to `#C9D6E3` (+ soft shadow on clickable stat cards); rows tint `#F7FAFC`; nav rows tint blue 6%.
- Focus: visible 2px `#2563C7` outline on all interactive elements (violet `#7461C9` for assistant controls).
- Overlays animate `fadeUp` 180ms ease-out (opacity 0→1, translateY 6px→0). Respect `prefers-reduced-motion` (disable all animation/transitions).
- Unbuilt sections render a designed placeholder (icon tile, title "<Section> — next design phase", body copy, "Back to Overview" button) — replace with real screens per `product-spec.txt`.

## State Management (prototype shape)
- `screen: 'patient' | 'practice' | 'placeholder'`, `patientTab: 'summary' | …`, `cmdOpen`, `aiOpen`, `placeholderLabel`.
- Data currently lives in the prototype logic class — port to typed mock adapters (e.g. `adapters/mockPatients.ts`) with interfaces for Patient, Biomarker (name/unit/value/status/series), Experiment, Hypothesis, Evidence, Alert, Task, Appointment, QueueItem. Replace with tRPC later.

## Design Tokens
Colors:
- Background `#F1F4F8` · card white `#FFFFFF` · sunken `#F7FAFC` / `#F1F5F9`
- Borders: `#E4EAF1` (cards), `#EDF2F7` / `#F1F5F9` (hairlines/dividers), `#DCE5EE` (outline buttons)
- Ink: primary `#182A3D`, body `#33475C` / `#44586E`, secondary `#5C6F82`, tertiary `#7288A1`, faint `#8A9BAC`
- Primary action blue `#2563C7` (hover `#1B4FA5`); active-nav text `#1B4FA5` on `#E9F0FB`
- Brand teal `#0D5C63` (+gradient to `#1A7A82`); patient-reported teal `#0E8388`
- Positive `#1F9D63` / bright `#22B573`, tint `#E9F6EF`
- Warning `#C77E14` (text `#B45309`), tint `#FBF3E4`
- Critical coral `#D6544A`, tint `#FBEDEC`
- AI violet `#7461C9` (text `#5D4BB5`), tint `rgba(116,97,201,0.1)`
- Measured/provenance navy `#3D5A80` on `#E8EEF5`
- Semantics are binding: blue = action/practitioner-confirmed, teal = patient-reported, violet = AI/inference, green = positive/optimal, amber = warning, coral = critical.

Type: Inter 400/500/600/700. Scale: 10–11 micro/labels, 12–13 body, 14 card titles, 17 patient name, 20–21 page titles, 24–32 stat numerals. Tabular numerals everywhere numbers appear.

Spacing: 8-pt base; 16px card padding & grid gaps, 18–24px page padding. Radii: 6–8 chips/kbd, 9–10 buttons/inputs, 12 inner tiles, 14–16 cards, 16–20 major surfaces, 99px pills/avatars. Shadows: near-none on cards (`0 1px 2px rgba(24,42,61,0.04)`); overlays `0 24px 64px rgba(24,42,61,0.22)`.

## Accessibility (WCAG 2.2 AA target)
Semantic headings per card; `role="tablist"/"tab"` + `aria-selected` on patient tabs; `aria-label`s on icon-only buttons and dialogs; charts have `role="img"` + descriptive labels; status never conveyed by color alone (always paired text like "High"/"Low"); visible focus rings; reduced-motion support; ≥44px targets for primary controls.

## Assets
No raster assets. Icons: Lucide (see sidebar list). Avatars are initials circles. Brand logo tile is a CSS gradient + Lucide Activity glyph.

## Files
- `Clinical Intelligence v2.dc.html` — primary design reference (all Phase-1 screens/overlays + mock data)
- `Clinical Intelligence.dc.html` — v1 variant (reference only)
- `product-spec.txt` — full product spec for remaining screens (Health Twin, Clinical Reasoning 3-pane, Labs, Supplement Intelligence, N-of-1 Lab, Timeline, Program/Assessment Builders, Tasks & Review Queue, Client Directory, etc.)
