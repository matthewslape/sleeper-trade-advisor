# Sleeper Trade Advisor — a Claude skill

A [Claude](https://claude.com/claude-code) skill that gives **fantasy football
trade recommendations, roster analysis, and waiver/lineup insights** for your
own [Sleeper](https://sleeper.com) league — grounded in real NFL data and
objective, market-based trade values.

Ask Claude things like:

- *"Should I trade Bijan Robinson and my WR3 for CeeDee Lamb?"*
- *"Analyze my team — what do I actually need?"*
- *"Find me a realistic trade with someone in my league."*
- *"Who's a good buy-low right now?"*

Claude pulls your **live** league, rosters, and standings, layers in objective
trade values, and gives a decisive recommendation with reasoning — not just a
table of numbers.

## How it works

No MCP server, no API keys, no `pip install`. The skill uses only the Python
standard library and two free, public, no-auth data sources:

| Source | Provides |
|---|---|
| [Sleeper API](https://docs.sleeper.com) | Your league, rosters, starters, standings, matchups, and league-wide trending adds/drops. |
| [FantasyCalc](https://fantasycalc.com) | Objective trade values, tuned to your league's exact shape (superflex/1QB, team count, PPR, redraft/dynasty). Sleeper has no trade values of its own. |
| Sleeper player index | Position, NFL team, age, and injury status for real-world context. |

## Install

Copy this repo's contents into a skill folder Claude can see:

```bash
# Project-scoped (this repo/project only):
mkdir -p .claude/skills/sleeper-trade-advisor
cp -r SKILL.md config.json scripts references .claude/skills/sleeper-trade-advisor/

# …or user-scoped (available in all your projects):
mkdir -p ~/.claude/skills/sleeper-trade-advisor
cp -r SKILL.md config.json scripts references ~/.claude/skills/sleeper-trade-advisor/
```

## Configure

Edit `config.json` and set your **Sleeper username** (case-sensitive):

```json
{
  "username": "your_sleeper_username",
  "league_id": "",
  "season": ""
}
```

`league_id` is optional — if you're in one NFL league it's auto-detected; if
you're in several, the skill lists them so you can paste the right id. Find it
in your league URL: `sleeper.com/leagues/<league_id>/team`.

## Use

Just talk to Claude naturally about your team and trades — the skill triggers on
its own. Under the hood it runs:

```bash
cd scripts
python3 trade_advisor.py team                                  # roster, values, needs, surplus
python3 trade_advisor.py evaluate --give "Player A, Player B" --get "Player C"
python3 trade_advisor.py targets                               # value-balanced trade partners
python3 trade_advisor.py league                                # the whole trade market
python3 sleeper.py trending add --limit 25                     # waiver/trending signals
```

## Requirements

- Python 3.8+
- Outbound network access to `api.sleeper.app` and `api.fantasycalc.com`.

## Notes

Trade values are a market snapshot, not gospel — treat sub-5% value gaps as
coin flips, and read `references/trade_strategy.md` for how the skill reasons
about value vs. roster fit. No secrets or credentials are stored anywhere.
