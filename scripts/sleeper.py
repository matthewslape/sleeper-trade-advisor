#!/usr/bin/env python3
"""
Sleeper API client + FantasyCalc trade-value client.

Standard-library only (urllib/json) so it runs anywhere Python 3.8+ is
available with no `pip install` step. Honors HTTP(S)_PROXY env vars
automatically via urllib.

This module is imported by trade_advisor.py and can also be run directly
for quick, raw data pulls:

    python sleeper.py state
    python sleeper.py user <username>
    python sleeper.py leagues <username> [season]
    python sleeper.py rosters <league_id>
    python sleeper.py trending add|drop [--hours 24] [--limit 25]
    python sleeper.py values --numQbs 1 --numTeams 12 --ppr 1 [--dynasty]

The heavy player index and value list are cached on disk (default: the OS
temp dir) so repeated calls in a session are fast and gentle on the API.
"""

import argparse
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

SLEEPER_BASE = "https://api.sleeper.app/v1"
FANTASYCALC_BASE = "https://api.fantasycalc.com"
CACHE_DIR = os.path.join(tempfile.gettempdir(), "sleeper_trade_advisor_cache")

# Cache lifetimes (seconds). Player index and values change slowly; keep them
# a while so a burst of analysis calls only fetches once.
PLAYERS_TTL = 24 * 3600
VALUES_TTL = 6 * 3600


def _log(msg):
    print(msg, file=sys.stderr)


def _http_get_json(url, timeout=30, retries=3):
    """GET a URL and parse JSON, with small exponential backoff on failure.

    Raises SleeperError with a human-readable message the skill can relay to
    the user rather than a raw stack trace.
    """
    last_err = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "sleeper-trade-advisor/1.0"}
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
            if not raw:
                return None
            return json.loads(raw)
        except urllib.error.HTTPError as e:
            # 404 is meaningful (bad id) — don't retry, surface it clearly.
            if e.code == 404:
                raise SleeperError(f"Not found (404): {url}")
            last_err = e
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last_err = e
        except json.JSONDecodeError as e:
            last_err = e
        if attempt < retries - 1:
            time.sleep(2 ** attempt)
    raise SleeperError(
        f"Could not reach {url} after {retries} tries: {last_err}. "
        "If you're on a restricted network, the Sleeper/FantasyCalc hosts may "
        "be blocked by an outbound proxy."
    )


class SleeperError(Exception):
    pass


def _cache_path(name):
    os.makedirs(CACHE_DIR, exist_ok=True)
    return os.path.join(CACHE_DIR, name)


def _read_cache(name, ttl):
    path = _cache_path(name)
    try:
        if time.time() - os.path.getmtime(path) < ttl:
            with open(path, "r") as f:
                return json.load(f)
    except (OSError, json.JSONDecodeError):
        pass
    return None


def _write_cache(name, data):
    try:
        with open(_cache_path(name), "w") as f:
            json.dump(data, f)
    except OSError:
        pass  # caching is best-effort; never fail the call over it


# --------------------------------------------------------------------------- #
# Sleeper endpoints
# --------------------------------------------------------------------------- #
def get_state():
    """Current NFL season + week context."""
    return _http_get_json(f"{SLEEPER_BASE}/state/nfl")


def get_user(username_or_id):
    """Resolve a username (or user_id) to a user object with user_id."""
    return _http_get_json(f"{SLEEPER_BASE}/user/{urllib.parse.quote(str(username_or_id))}")


def get_user_leagues(user_id, season):
    return _http_get_json(f"{SLEEPER_BASE}/user/{user_id}/leagues/nfl/{season}")


def get_league(league_id):
    return _http_get_json(f"{SLEEPER_BASE}/league/{league_id}")


def get_rosters(league_id):
    return _http_get_json(f"{SLEEPER_BASE}/league/{league_id}/rosters")


def get_league_users(league_id):
    return _http_get_json(f"{SLEEPER_BASE}/league/{league_id}/users")


def get_matchups(league_id, week):
    return _http_get_json(f"{SLEEPER_BASE}/league/{league_id}/matchups/{week}")


def get_transactions(league_id, week):
    return _http_get_json(f"{SLEEPER_BASE}/league/{league_id}/transactions/{week}")


def get_traded_picks(league_id):
    return _http_get_json(f"{SLEEPER_BASE}/league/{league_id}/traded_picks")


def get_trending(kind="add", lookback_hours=24, limit=25):
    """Most-added or most-dropped players across all of Sleeper.

    Returns a list of {player_id, count}. Join against the player index to get
    names — see load_players().
    """
    if kind not in ("add", "drop"):
        raise SleeperError("trending kind must be 'add' or 'drop'")
    q = urllib.parse.urlencode({"lookback_hours": lookback_hours, "limit": limit})
    return _http_get_json(f"{SLEEPER_BASE}/players/nfl/trending/{kind}?{q}")


def load_players(force=False):
    """The full NFL player index keyed by player_id.

    This payload is large (several MB) so it is cached on disk for a day.
    Each value has fields like full_name, position, team, age, injury_status,
    years_exp, fantasy_positions.
    """
    if not force:
        cached = _read_cache("players_nfl.json", PLAYERS_TTL)
        if cached is not None:
            return cached
    data = _http_get_json(f"{SLEEPER_BASE}/players/nfl")
    if data:
        _write_cache("players_nfl.json", data)
    return data


# --------------------------------------------------------------------------- #
# FantasyCalc trade values (objective, market-based)
# --------------------------------------------------------------------------- #
def load_values(num_qbs=1, num_teams=12, ppr=1, is_dynasty=False, force=False):
    """Current market trade values from FantasyCalc's free public API.

    Returns the raw list. Each entry looks like:
      {"player": {"name","position","maybeTeam","sleeperId",...},
       "value": <int>, "overallRank": <int>, "positionRank": <int>, ...}

    Values are tuned to league shape (superflex vs 1QB, team count, PPR,
    redraft vs dynasty), so pass the settings from get_league().
    """
    key = f"values_{num_qbs}q_{num_teams}t_{ppr}ppr_{'dyn' if is_dynasty else 'red'}.json"
    if not force:
        cached = _read_cache(key, VALUES_TTL)
        if cached is not None:
            return cached
    q = urllib.parse.urlencode({
        "isDynasty": str(bool(is_dynasty)).lower(),
        "numQbs": num_qbs,
        "numTeams": num_teams,
        "ppr": ppr,
    })
    data = _http_get_json(f"{FANTASYCALC_BASE}/values/current?{q}")
    if data:
        _write_cache(key, data)
    return data


# --------------------------------------------------------------------------- #
# CLI for raw pulls (mostly for debugging / spot checks)
# --------------------------------------------------------------------------- #
def _main(argv):
    p = argparse.ArgumentParser(description="Raw Sleeper/FantasyCalc data pulls")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("state")
    s = sub.add_parser("user"); s.add_argument("username")
    s = sub.add_parser("leagues"); s.add_argument("username"); s.add_argument("season", nargs="?")
    s = sub.add_parser("rosters"); s.add_argument("league_id")
    s = sub.add_parser("users"); s.add_argument("league_id")
    s = sub.add_parser("matchups"); s.add_argument("league_id"); s.add_argument("week")
    s = sub.add_parser("trending")
    s.add_argument("kind", choices=["add", "drop"])
    s.add_argument("--hours", type=int, default=24)
    s.add_argument("--limit", type=int, default=25)
    s = sub.add_parser("values")
    s.add_argument("--numQbs", type=int, default=1)
    s.add_argument("--numTeams", type=int, default=12)
    s.add_argument("--ppr", type=float, default=1)
    s.add_argument("--dynasty", action="store_true")
    args = p.parse_args(argv)

    try:
        if args.cmd == "state":
            out = get_state()
        elif args.cmd == "user":
            out = get_user(args.username)
        elif args.cmd == "leagues":
            season = args.season or (get_state() or {}).get("season")
            u = get_user(args.username)
            if not u:
                raise SleeperError(f"No Sleeper user named '{args.username}'")
            out = get_user_leagues(u["user_id"], season)
        elif args.cmd == "rosters":
            out = get_rosters(args.league_id)
        elif args.cmd == "users":
            out = get_league_users(args.league_id)
        elif args.cmd == "matchups":
            out = get_matchups(args.league_id, args.week)
        elif args.cmd == "trending":
            out = get_trending(args.kind, args.hours, args.limit)
        elif args.cmd == "values":
            out = load_values(args.numQbs, args.numTeams, args.ppr, args.dynasty)
        else:
            raise SleeperError(f"unknown command {args.cmd}")
    except SleeperError as e:
        _log(f"ERROR: {e}")
        return 1
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
