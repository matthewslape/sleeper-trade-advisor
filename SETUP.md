# Setup & running notes

The skill is already configured for this league in `config.json`:

```json
"username": "slapebeboomin",
"league_id": "1311998246557609984"
```

Nothing else needs configuring. The one thing that determines whether it
runs is **outbound network access** — see below.

## The one requirement: outbound access to two hosts

The skill has no server and no API keys. It fetches everything live from two
free, public, no-auth endpoints. Whatever machine actually runs the Python
must be able to reach **both**:

| Host | Provides |
|---|---|
| `api.sleeper.app` | Your league, rosters, starters, standings, matchups, trending adds/drops. |
| `api.fantasycalc.com` | Objective market trade values (Sleeper has none of its own). |

If either is blocked, the scripts print a clear network/proxy error instead of
advice. If only FantasyCalc is blocked, you still get need/depth/trend analysis
but trade *values* come back `0`.

## Where the code actually runs (this matters on mobile)

When you use Claude Code from the **phone or web app**, your device is only the
screen. The code runs on a **cloud container** Anthropic starts for the
session. So the host that must reach the two sites above is *that container*,
not your phone:

```
Your phone/browser  →  Claude cloud container  →  api.sleeper.app / api.fantasycalc.com
   (just the screen)     (this is what must have network access)
```

A container whose network policy blocks those hosts returns `403 Forbidden` on
connect — which is exactly what happened when this file was created. Your
phone's own internet is irrelevant to that.

## Two ways to get it working

### A. Allow the hosts for the cloud environment (works from your phone)

Edit the environment's **network access** policy so outbound HTTPS to
`api.sleeper.app` and `api.fantasycalc.com` is permitted, then re-run. This is
configured on the environment, not in this repo — see the Claude Code on the
web docs: https://code.claude.com/docs/en/claude-code-on-the-web . Once allowed,
ask Claude for advice (or run the commands below) entirely from your phone.

### B. Run it on any computer with normal internet

Home machines have unrestricted internet, so the skill just works:

```bash
git clone <this repo>
cd sleeper-trade-advisor/scripts
python3 trade_advisor.py team
```

Requires only Python 3.8+ — no `pip install`.

## Commands

Run from `scripts/`:

```bash
python3 trade_advisor.py team                                   # roster, values, needs, surplus
python3 trade_advisor.py evaluate --give "Player A, Player B" --get "Player C"
python3 trade_advisor.py targets                                # value-balanced trade partners
python3 trade_advisor.py league                                 # the whole trade market
python3 sleeper.py trending add --limit 25                      # waiver/trending signals
```

Add `--json` to any `trade_advisor.py` command for the raw numbers. To point at
a different league without editing `config.json`, pass `--league <id>`.

## Quick self-check

To confirm a machine can reach both hosts before running the full analysis:

```bash
curl -sS -o /dev/null -w "sleeper: %{http_code}\n"     https://api.sleeper.app/v1/state/nfl
curl -sS -o /dev/null -w "fantasycalc: %{http_code}\n" "https://api.fantasycalc.com/values/current?isDynasty=false&numQbs=1&numTeams=12&ppr=1"
```

Two `200`s means you're good to go. A `403`/`000` on either means that host is
blocked on that network.
