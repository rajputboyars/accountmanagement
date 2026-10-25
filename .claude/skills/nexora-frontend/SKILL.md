---
name: nexora-frontend
description: Build or change Nexora screens and components so they match the approved prototype, stay responsive at 1440/1024/390 px in light and dark mode, and never calculate saved money values in the browser. Use for any work under src/app (pages, layouts) or src/components.
---

# Nexora frontend

The project rules live in `CLAUDE.md` (Design system, Architecture) and `docs/implementation-handoff.md` (§2.1 C1, §4, §10 UI shell). Read them; this skill is the working checklist.

## Before writing UI

1. Read the Next.js guide for the APIs you'll use in `node_modules/next/dist/docs/` (see `AGENTS.md`). This Next.js version differs from older training data.
2. Find the screen in the UI prototype (link in CLAUDE.md) and list its parts, states and actions. If you can't open the prototype, ask for a screenshot rather than guessing the layout.
3. Name the spec scenarios the screen supports (for example B1–B10 for Billing).

## Rules

- **Components:** use shadcn/ui from `src/components/ui`. Put Nexora pieces (KPI card, money cell, status pill, collection dial, sync pill) in `src/components/nexora`, and reuse them before creating new ones.
- **Colours:** Tailwind tokens only, defined once in `globals.css` for light and dark mode. No raw hex values in components.
- **Money:**
  - Display only: format with `src/shared/money.ts` (₹, Indian grouping, `tabular-nums`).
  - Saved totals, balances and profit come from the API.
  - Offline or live previews may use `src/shared/pricing-engine.ts`, never hand-written maths.
- **Profit:** when the API says `reliable: false`, show "Profit not available" with the missing-cost items. Never show an estimate as the headline.
- **Data and permissions:** server components fetch data. Client components only where interaction needs them. Hide actions the role can't perform, but never treat hiding as security.
- **Forms:**
  - Validate with the shared Zod schema, shown inline and on the server.
  - Every input has a visible label.
  - Errors say what to do next.
  - Submit buttons send an `Idempotency-Key` and are disabled while pending.
- **States:** every data view designs loading (skeleton), empty (with the next action), error (with retry), offline (from Phase 10) and access denied.
- **Motion:** Motion for small transitions, GSAP only for scroll or complex sequences, and honour `prefers-reduced-motion`. No decorative animation on counter screens.
- **Accessibility:**
  - Real `<button>`, `<a>` and `<label>` elements.
  - Focus is always visible.
  - Contrast at least 4.5:1, including small grey labels.
  - Touch targets at least 44 px on phone and tablet.
- **Layout:**
  - Icon rail on desktop and tablet, bottom bar under 768 px.
  - Wide tables scroll inside their own container; the page never scrolls sideways.
  - Cards in a row share the same height.

## Verify before reporting done

1. `npm run lint`, plus `npm run typecheck` once it exists.
2. Run `npm run dev` and look at the screen at 1440, 1024 and 390 px in light and dark mode. Use the built-in browser pane, or Playwright if it is connected in this session; check that first instead of assuming.
3. Walk each state: loading, empty, error, access denied.
4. Report what you checked and what you couldn't (for example "dark mode not checked: no browser available").

For extra visual guidance, the `ui-ux-pro-max` and `frontend-design` skills may help, but the rules in CLAUDE.md win.
