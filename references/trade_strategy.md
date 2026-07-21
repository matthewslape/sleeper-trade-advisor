# Trade strategy: turning data into a recommendation

The scripts give you values, positional ranks, needs, and surplus. This is how
to reason from those into advice a manager can act on.

## The core question: value AND fit

Two separate things determine whether a trade is good:

1. **Value** — does the total trade value roughly balance? `evaluate` reports
   `value_delta_pct`. Rough bands (from your side):
   - `> +15%` clear win — take it, maybe even sweeten to be fair.
   - `+5% to +15%` favorable — good deal.
   - `-5% to +5%` even — decide on fit, not value.
   - `-15% to -5%` you're paying up — only worth it to fill a real need with a
     clear upgrade.
   - `< -15%` overpay — decline or counter unless there's a strong non-value
     reason (contending team buying a difference-maker, selling an aging asset).

2. **Fit** — does it fix a *starting* problem? A player who upgrades a weekly
   starting slot is worth more to *this* roster than raw value suggests.
   Conversely, "winning" a trade that piles depth onto a position you already
   start comfortably is often a loss in practice — you can't start six RBs.

The best trades win on both. The most common *correct* trade that looks "bad"
on a value chart: giving up surplus depth (two good bench pieces) to
consolidate into one clear starter at a position of need. Roster spots and
starting slots are scarce; use that framing.

## Reading needs and surplus

`team` and `league` tag each roster with `needs` (bottom ~40% of the league at
that position) and `surplus` (top third *with* real depth beyond starting
slots). Trade *from* surplus *into* need. `targets` automates the match: it
looks for a partner who is strong where you're weak and weak where you're
strong, and proposes a value-balanced swap. Treat its suggestions as leads to
pitch, not finished deals — you'll usually adjust the exact pieces.

## Format changes the math

The scripts already pull values tuned to the league format, but your reasoning
should match it too:

- **Redraft (win-now):** Age barely matters. Weigh the current starting lineup,
  the playoff weeks' schedule/byes, and injury timelines. A hurt star returning
  in week 5 is worth less to a team that's 1-3 and fading.
- **Dynasty/keeper:** Age and draft picks carry real weight. Young ascending
  players and firsts hold value across seasons; aging stars are depreciating
  assets to sell a year early rather than a year late. Contenders buy win-now;
  rebuilders sell it.

## Buy-low / sell-high with trending data

`sleeper.py trending add|drop` shows league-wide adds/drops over a lookback
window. Use it as a sentiment signal:

- A quality player trending as a heavy **drop** (post-injury, slow start) is a
  classic **buy-low** — acquire before the market corrects if you believe in
  the talent/role.
- A player massively trending **add** after one big game is a **sell-high**
  candidate — market perception is peaking; consider moving them for a steadier
  asset.

Always sanity-check trend signals against role and injury, not just the box
score that caused the spike.

## Writing the recommendation

1. **State the call first** ("Yes, make this trade" / "I'd counter with…").
2. **Give the two or three reasons** grounded in the data: value delta, the
   need it fills, and the NFL context (age/injury/role/schedule).
3. **Flag the risk** honestly — the injury, the thin value, the coin-flip gap.
4. **Offer the next step** — a counter, a specific target from `targets`, or a
   waiver pickup that addresses the same need more cheaply.

Concrete, decisive, and honest beats a wall of numbers every time.
