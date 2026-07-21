---
name: sleeper-trade-advisor
description: >
  Give fantasy football trade advice, roster analysis, and waiver/lineup insights
  for the user's own Sleeper league, grounded in real NFL data and objective
  market trade values. Use this skill whenever the user asks about a fantasy
  football trade ("should I trade X for Y", "is this a good deal", "who should I
  target", "find me a trade"), wants their Sleeper team or league analyzed,
  wants to know their roster's strengths/weaknesses or needs, asks about buy-low
  / sell-high or trending players, or mentions their Sleeper league at all in a
  fantasy-decision context. Prefer this skill over answering from memory for any
  Sleeper/fantasy-football roster or trade question — it pulls the user's live
  league data, so generic advice would be worse.
---

# Sleeper Trade Advisor

This skill turns the user's **live Sleeper league data** into concrete,
defensible fantasy football advice: whether a trade is fair, what their roster
actually needs, and which league-mates make good trade partners. It combines
three data sources so recommendations reflect reality, not vibes:

1. **Sleeper API** (public, no auth) — the user's league, rosters, starters,
   standings, matchups, and league-wide trending adds/drops.
2. **FantasyCalc API** (free) — objective, market-based **trade values** tuned
   to the league's exact shape (superflex vs 1QB, team count, PPR, redraft vs
   dynasty). Sleeper itself has no trade values; this is where "is it fair"
   comes from.
3. **Real NFL context** — player position, team, age, and injury status from
   the Sleeper player index.

## Setup (do this first, once)

Everything keys off `config.json` in this skill's folder. Before running
analysis, confirm it has the user's `username`. If `username` is empty:

- Ask the user for their **Sleeper username** (case-sensitive) and, if they
  know it, their **league_id** (the number in `sleeper.com/leagues/<id>/team`).
- Write those into `config.json`.

If `username` is set but `league_id` is empty and the user is in multiple
leagues, the scripts will print the list of leagues with their ids — ask the
user which one and save it to `config.json` so future calls are one step.

## How to use it

All commands run from this skill's `scripts/` directory with plain `python3`
(standard library only — no installs). Each prints a readable summary; add
`--json` when you want the raw numbers to reason over.

**Start almost every request by getting the lay of the land:**

```bash
cd <skill>/scripts
python3 trade_advisor.py team        # the user's roster, values, needs, surplus
```

Then pick the command that matches the ask:

| User asks… | Run |
|---|---|
| "Analyze my team / what do I need?" | `trade_advisor.py team` |
| "Is trading A and B for C a good deal?" | `trade_advisor.py evaluate --give "A, B" --get "C"` |
| "Who should I target / find me a trade" | `trade_advisor.py targets` |
| "What's the trade market look like?" | `trade_advisor.py league` |
| "Who's trending / waiver adds?" | `sleeper.py trending add --limit 25` |

`--league <id>` overrides the configured league on any command (handy if the
user plays in several). The lower-level `sleeper.py` exposes raw endpoints
(`state`, `rosters`, `matchups`, `values`, …) for anything the advisor doesn't
cover directly.

## Turning output into advice

The scripts do the fetching and the math; **your job is the judgment.** Don't
just relay numbers — read `references/trade_strategy.md` and:

- **Lead with a recommendation**, then justify it. "Yes, do this trade" or
  "I'd counter" beats a table of values. The `verdict` and `value_delta_pct`
  from `evaluate` are the backbone, but temper them with need/surplus fit —
  a slight value loss that fixes a real starting hole is often correct, and a
  value "win" that adds to a position you're already deep at may not be.
- **Respect the league's format.** The scripts already tune values to the
  league (the header line shows dynasty/redraft, QB count, PPR). In dynasty,
  weigh age and picks; in redraft, weigh this season's starting lineup and the
  playoff schedule. If the format materially changes the answer, say so.
- **Name real players and real reasons.** Tie recommendations to the injury
  status, age, bye weeks, and trending data the scripts surface. If someone
  the user is buying is trending as a league-wide drop, or is injured, flag it.
- **Be honest about uncertainty.** FantasyCalc values are a market snapshot,
  not gospel; a value gap under ~5% is a coin flip. Rookies, injured players,
  and defenses/kickers may have thin or missing values (shown as `0`) — call
  that out instead of treating 0 as "worthless."

## Failure handling

- If a script prints a network/proxy error, the environment is likely blocking
  `api.sleeper.app` or `api.fantasycalc.com`. Tell the user plainly; the skill
  needs outbound access to those hosts.
- If FantasyCalc is unreachable but Sleeper works, values come back `0`. You
  can still give need/depth/trend-based advice — just note that hard trade
  values are unavailable this run.
- A "user not found" error almost always means a username typo or wrong case.

## Reference material

- `references/trade_strategy.md` — how to reason about fairness, need vs value,
  buy-low/sell-high, and format-specific weighting. Read it before giving a
  recommendation.
- `references/sleeper_api.md` — the underlying endpoints, data shapes, and
  caching behavior, for when you need data the advisor doesn't expose.
