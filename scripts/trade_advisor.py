#!/usr/bin/env python3
"""
Sleeper trade advisor — turns raw league data into roster analysis, trade
evaluations, and trade-target suggestions.

Reads identity (Sleeper username + optional league_id) from config.json in the
skill root, resolves the league and your team, enriches every roster with
objective FantasyCalc trade values, and reports structured JSON plus a
human-readable summary.

Commands:
    python trade_advisor.py team [--league LEAGUE_ID] [--json]
        Your roster with values, positional strengths, surplus, and needs.

    python trade_advisor.py league [--league LEAGUE_ID] [--json]
        Standings + every team's positional surplus/need (the trade market).

    python trade_advisor.py evaluate --give "A, B" --get "C" [--partner TEAM]
        Score a specific proposed trade from your side.

    python trade_advisor.py targets [--league LEAGUE_ID] [--json]
        Suggested trade partners and value-balanced packages that fix your
        needs using your surplus.

All commands print a readable summary to stdout by default; add --json to also
emit the structured data (useful when you want to reason over the raw numbers).
"""

import argparse
import json
import os
import re
import sys

import sleeper
from sleeper import SleeperError

CONFIG_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.json")

# Positions we analyze as core fantasy assets.
CORE_POS = ["QB", "RB", "WR", "TE"]
# Slots that draw from multiple positions.
FLEX_SLOTS = {"FLEX": ["RB", "WR", "TE"], "WRRB_FLEX": ["RB", "WR"],
              "REC_FLEX": ["WR", "TE"], "SUPER_FLEX": ["QB", "RB", "WR", "TE"]}


# --------------------------------------------------------------------------- #
# Config + league resolution
# --------------------------------------------------------------------------- #
def load_config():
    try:
        with open(CONFIG_PATH) as f:
            cfg = json.load(f)
    except FileNotFoundError:
        raise SleeperError(f"No config.json found at {CONFIG_PATH}. Add your Sleeper username.")
    except json.JSONDecodeError as e:
        raise SleeperError(f"config.json is not valid JSON: {e}")
    if not cfg.get("username"):
        raise SleeperError("config.json is missing 'username' (your Sleeper username, case-sensitive).")
    return cfg


def resolve_league(cfg, league_override=None):
    """Return (league_obj, user_obj). Uses config league_id when present,
    otherwise looks up the user's leagues for the current season."""
    user = sleeper.get_user(cfg["username"])
    if not user:
        raise SleeperError(f"No Sleeper user named '{cfg['username']}'. Check spelling/case.")

    league_id = league_override or cfg.get("league_id")
    if league_id:
        league = sleeper.get_league(league_id)
        if not league:
            raise SleeperError(f"League {league_id} not found.")
        return league, user

    season = cfg.get("season") or (sleeper.get_state() or {}).get("season")
    leagues = sleeper.get_user_leagues(user["user_id"], season) or []
    if not leagues:
        raise SleeperError(f"'{cfg['username']}' has no NFL leagues for {season}.")
    if len(leagues) == 1:
        return leagues[0], user
    listing = "\n".join(f"  - {lg['name']}  (league_id: {lg['league_id']})" for lg in leagues)
    raise SleeperError(
        f"'{cfg['username']}' is in {len(leagues)} leagues for {season}. "
        f"Add a 'league_id' to config.json (or pass --league):\n{listing}"
    )


# --------------------------------------------------------------------------- #
# Value matching
# --------------------------------------------------------------------------- #
def _norm_name(name):
    if not name:
        return ""
    name = name.lower()
    name = re.sub(r"[.'`]", "", name)
    name = re.sub(r"\s+(jr|sr|ii|iii|iv|v)\b", "", name)
    name = re.sub(r"[^a-z0-9 ]", " ", name)
    return re.sub(r"\s+", " ", name).strip()


def league_value_settings(league):
    """Derive FantasyCalc query params from the league's settings."""
    positions = league.get("roster_positions", []) or []
    num_qbs = sum(1 for p in positions if p == "QB") + sum(1 for p in positions if p == "SUPER_FLEX")
    num_qbs = max(1, num_qbs)
    num_teams = league.get("total_rosters") or 12
    ppr = (league.get("scoring_settings", {}) or {}).get("rec", 0) or 0
    # Sleeper league type: 0 redraft, 1 keeper, 2 dynasty.
    is_dynasty = league.get("settings", {}).get("type", 0) == 2
    return {"num_qbs": num_qbs, "num_teams": num_teams, "ppr": ppr, "is_dynasty": is_dynasty}


def build_value_index(league):
    """Return a function value_of(player_id, players) -> int trade value.

    Matches Sleeper players to FantasyCalc values by sleeperId first (exact),
    then by normalized name+position as a fallback.
    """
    s = league_value_settings(league)
    values = sleeper.load_values(s["num_qbs"], s["num_teams"], s["ppr"], s["is_dynasty"]) or []
    by_sleeper_id = {}
    by_name_pos = {}
    for row in values:
        pl = row.get("player", {}) or {}
        val = row.get("value", 0) or 0
        sid = pl.get("sleeperId")
        if sid is not None:
            by_sleeper_id[str(sid)] = val
        key = (_norm_name(pl.get("name")), (pl.get("position") or "").upper())
        by_name_pos[key] = val

    def value_of(player_id, players):
        pid = str(player_id)
        if pid in by_sleeper_id:
            return by_sleeper_id[pid]
        info = players.get(pid) or {}
        key = (_norm_name(info.get("full_name")), (info.get("position") or "").upper())
        return by_name_pos.get(key, 0)

    return value_of, by_name_pos, s


# --------------------------------------------------------------------------- #
# Roster enrichment
# --------------------------------------------------------------------------- #
def player_brief(pid, players):
    info = players.get(str(pid)) or {}
    name = info.get("full_name") or info.get("last_name") or str(pid)
    return {
        "player_id": str(pid),
        "name": name,
        "pos": (info.get("position") or "?").upper(),
        "team": info.get("team") or "FA",
        "age": info.get("age"),
        "injury": info.get("injury_status"),
    }


def enrich_roster(roster, players, value_of):
    starters = [str(p) for p in (roster.get("starters") or []) if p and p != "0"]
    all_players = [str(p) for p in (roster.get("players") or []) if p and p != "0"]
    reserve = set(str(p) for p in (roster.get("reserve") or []) if p)
    taxi = set(str(p) for p in (roster.get("taxi") or []) if p)
    bench = [p for p in all_players if p not in set(starters) and p not in reserve and p not in taxi]

    def decorate(pid):
        b = player_brief(pid, players)
        b["value"] = value_of(pid, players)
        return b

    enriched = {
        "roster_id": roster.get("roster_id"),
        "owner_id": roster.get("owner_id"),
        "starters": sorted([decorate(p) for p in starters], key=lambda x: -x["value"]),
        "bench": sorted([decorate(p) for p in bench], key=lambda x: -x["value"]),
        "settings": roster.get("settings", {}),
    }
    enriched["total_value"] = sum(p["value"] for p in enriched["starters"] + enriched["bench"])
    return enriched


def positional_value(enriched):
    """Sum of the top players' values per core position (starters + bench)."""
    buckets = {p: [] for p in CORE_POS}
    for p in enriched["starters"] + enriched["bench"]:
        if p["pos"] in buckets:
            buckets[p["pos"]].append(p["value"])
    return {pos: sorted(v, reverse=True) for pos, v in buckets.items()}


def starting_slots(league):
    """Count of dedicated + flex-eligible starting slots per core position."""
    positions = league.get("roster_positions", []) or []
    dedicated = {p: 0 for p in CORE_POS}
    flex_for = {p: 0 for p in CORE_POS}
    for slot in positions:
        if slot in dedicated:
            dedicated[slot] += 1
        elif slot in FLEX_SLOTS:
            for p in FLEX_SLOTS[slot]:
                if p in flex_for:
                    flex_for[p] += 1
    return dedicated, flex_for


# --------------------------------------------------------------------------- #
# Analysis
# --------------------------------------------------------------------------- #
def analyze_league(league):
    players = sleeper.load_players()
    if not players:
        raise SleeperError("Could not load the Sleeper player index.")
    value_of, by_name_pos, vsettings = build_value_index(league)
    rosters = sleeper.get_rosters(league["league_id"]) or []
    users = {u["user_id"]: u for u in (sleeper.get_league_users(league["league_id"]) or [])}

    teams = []
    for r in rosters:
        e = enrich_roster(r, players, value_of)
        u = users.get(r.get("owner_id"), {})
        e["team_name"] = (u.get("metadata", {}) or {}).get("team_name") or u.get("display_name") or f"Roster {e['roster_id']}"
        e["owner_name"] = u.get("display_name", "?")
        e["pos_values"] = positional_value(e)
        st = r.get("settings", {})
        e["record"] = f"{st.get('wins',0)}-{st.get('losses',0)}" + (f"-{st['ties']}" if st.get("ties") else "")
        e["fpts"] = st.get("fpts", 0) + (st.get("fpts_decimal", 0) or 0) / 100.0
        teams.append(e)

    dedicated, flex_for = starting_slots(league)
    # Rank each team per position by the value of the players who'd actually
    # start there (dedicated slots + a share of flex).
    for pos in CORE_POS:
        n_start = dedicated[pos] + flex_for[pos]  # generous: assume flex could be this pos
        n_start = max(1, n_start)
        ranked = sorted(teams, key=lambda t: -sum(t["pos_values"][pos][:n_start]))
        for rank, t in enumerate(ranked, 1):
            t.setdefault("pos_rank", {})[pos] = rank
            t.setdefault("pos_starter_value", {})[pos] = sum(t["pos_values"][pos][:n_start])

    n_teams = len(teams)
    for t in teams:
        needs, surplus = [], []
        for pos in CORE_POS:
            rank = t["pos_rank"][pos]
            n_start = max(1, dedicated[pos] + flex_for[pos])
            depth = len([v for v in t["pos_values"][pos] if v > 0])
            if rank > n_teams * 0.6:            # bottom ~40% at this position
                needs.append(pos)
            elif rank <= n_teams * 0.34 and depth > n_start:  # top third AND real depth
                surplus.append(pos)
        t["needs"] = needs
        t["surplus"] = surplus

    return {
        "league": league,
        "value_settings": vsettings,
        "teams": teams,
        "dedicated": dedicated,
        "flex_for": flex_for,
        "players": players,
        "value_index": (value_of, by_name_pos),
    }


def find_my_team(analysis, user):
    for t in analysis["teams"]:
        if t["owner_id"] == user["user_id"]:
            return t
    raise SleeperError("Could not find your team in this league (owner_id mismatch).")


# --------------------------------------------------------------------------- #
# Trade evaluation
# --------------------------------------------------------------------------- #
def resolve_players_by_name(names, analysis):
    """Map free-text player names to (name, pos, value) using the player index."""
    players = analysis["players"]
    value_of, _ = analysis["value_index"]
    # Build a normalized-name -> player_id index once.
    name_index = {}
    for pid, info in players.items():
        if (info.get("position") or "").upper() in CORE_POS + ["K", "DEF"]:
            name_index.setdefault(_norm_name(info.get("full_name")), pid)
    resolved, missing = [], []
    for raw in names:
        pid = name_index.get(_norm_name(raw))
        if pid:
            b = player_brief(pid, players)
            b["value"] = value_of(pid, players)
            resolved.append(b)
        else:
            missing.append(raw)
    return resolved, missing


def evaluate_trade(give, get, analysis, my_team):
    give_v = sum(p["value"] for p in give)
    get_v = sum(p["value"] for p in get)
    delta = get_v - give_v
    total = give_v + get_v or 1
    pct = 100.0 * delta / (total / 2)
    verdict = _verdict(pct)
    # Positional impact on your needs/surplus.
    impact = {}
    for p in get:
        impact[p["pos"]] = impact.get(p["pos"], 0) + 1
    for p in give:
        impact[p["pos"]] = impact.get(p["pos"], 0) - 1
    return {
        "give": give, "get": get,
        "give_value": give_v, "get_value": get_v,
        "value_delta": delta, "value_delta_pct": round(pct, 1),
        "verdict": verdict,
        "net_positions": impact,
        "your_needs": my_team["needs"], "your_surplus": my_team["surplus"],
    }


def _verdict(pct):
    if pct >= 15:
        return "Clear win for you"
    if pct >= 5:
        return "Slightly favors you"
    if pct > -5:
        return "Roughly even"
    if pct > -15:
        return "Slightly favors them"
    return "Overpay — favors them"


# --------------------------------------------------------------------------- #
# Trade-target finder
# --------------------------------------------------------------------------- #
def find_targets(analysis, my_team, max_partners=4):
    suggestions = []
    for opp in analysis["teams"]:
        if opp["roster_id"] == my_team["roster_id"]:
            continue
        # Complementary fit: they're strong where I'm weak, weak where I'm strong.
        my_needs_they_have = [p for p in my_team["needs"] if p in opp["surplus"]]
        their_needs_i_have = [p for p in opp["needs"] if p in my_team["surplus"]]
        if not (my_needs_they_have and their_needs_i_have):
            continue
        for need_pos in my_needs_they_have:
            target = _best_surplus_player(opp, need_pos, analysis)
            if not target:
                continue
            for give_pos in their_needs_i_have:
                offer = _best_surplus_player(my_team, give_pos, analysis, near_value=target["value"])
                if not offer:
                    continue
                suggestions.append({
                    "partner": opp["team_name"],
                    "partner_owner": opp["owner_name"],
                    "partner_record": opp["record"],
                    "you_get": target,
                    "you_give": offer,
                    "fills_your_need": need_pos,
                    "fills_their_need": give_pos,
                    "value_gap": target["value"] - offer["value"],
                })
    # Prefer the most balanced (smallest absolute value gap) partners first.
    suggestions.sort(key=lambda s: abs(s["value_gap"]))
    return suggestions[:max_partners * 2]


def _best_surplus_player(team, pos, analysis, near_value=None):
    """A benched/depth player at `pos` this team can afford to move."""
    dedicated = analysis["dedicated"]
    flex_for = analysis["flex_for"]
    keep = max(1, dedicated[pos] + flex_for[pos])
    pool = [p for p in team["starters"] + team["bench"] if p["pos"] == pos and p["value"] > 0]
    pool.sort(key=lambda x: -x["value"])
    movable = pool[keep:]  # players beyond what they need to start
    if not movable:
        return None
    if near_value is not None:
        movable.sort(key=lambda x: abs(x["value"] - near_value))
    return movable[0]


# --------------------------------------------------------------------------- #
# Rendering
# --------------------------------------------------------------------------- #
def _fmt_player(p):
    inj = f" ({p['injury']})" if p.get("injury") else ""
    age = f" age {p['age']}" if p.get("age") else ""
    return f"{p['name']} {p['pos']}-{p['team']}{age}{inj} — {p['value']}"


def render_team(analysis, t):
    lg = analysis["league"]
    vs = analysis["value_settings"]
    out = [
        f"=== {t['team_name']} ({t['owner_name']}) — {t['record']}, {t['fpts']:.1f} pts ===",
        f"League: {lg['name']}  |  Values: {'dynasty' if vs['is_dynasty'] else 'redraft'}, "
        f"{vs['num_qbs']}QB, {vs['num_teams']}-team, {vs['ppr']}PPR",
        f"Total roster value: {t['total_value']}",
        "",
        "Starters:",
    ]
    out += [f"  {_fmt_player(p)}" for p in t["starters"]]
    out += ["", "Bench:"]
    out += [f"  {_fmt_player(p)}" for p in t["bench"]] or ["  (none)"]
    out += ["", f"Positional rank (1=best of {len(analysis['teams'])}):"]
    for pos in CORE_POS:
        out.append(f"  {pos}: rank {t['pos_rank'][pos]}  (starter value {t['pos_starter_value'][pos]})")
    out += [
        "",
        f"NEEDS (upgrade targets): {', '.join(t['needs']) or 'none glaring'}",
        f"SURPLUS (trade bait):    {', '.join(t['surplus']) or 'none obvious'}",
    ]
    return "\n".join(out)


def render_league(analysis):
    out = ["=== League trade market ===", ""]
    teams = sorted(analysis["teams"], key=lambda t: -t["fpts"])
    for t in teams:
        out.append(
            f"{t['team_name']:<24} {t['record']:<7} "
            f"val {t['total_value']:<6} "
            f"needs:[{','.join(t['needs']) or '-'}] surplus:[{','.join(t['surplus']) or '-'}]"
        )
    return "\n".join(out)


def render_targets(suggestions):
    if not suggestions:
        return ("No clean complementary trade partners found from surplus/need "
                "matching. Look at value gaps in the `league` view instead, or "
                "target a specific position manually.")
    out = ["=== Suggested trade targets (value-balanced) ===", ""]
    for s in suggestions:
        gap = s["value_gap"]
        tilt = "even" if abs(gap) < 400 else ("you win" if gap > 0 else "they win")
        out += [
            f"With {s['partner']} ({s['partner_owner']}, {s['partner_record']}):",
            f"  You GET:  {_fmt_player(s['you_get'])}   (fills your {s['fills_your_need']})",
            f"  You GIVE: {_fmt_player(s['you_give'])}   (fills their {s['fills_their_need']})",
            f"  Value gap: {gap:+d}  [{tilt}]",
            "",
        ]
    return "\n".join(out)


def render_evaluation(ev):
    out = [
        "=== Trade evaluation ===",
        f"You GIVE ({ev['give_value']}):",
    ]
    out += [f"  {_fmt_player(p)}" for p in ev["give"]]
    out += [f"You GET ({ev['get_value']}):"]
    out += [f"  {_fmt_player(p)}" for p in ev["get"]]
    out += [
        "",
        f"Value delta: {ev['value_delta']:+d} ({ev['value_delta_pct']:+.1f}%) -> {ev['verdict']}",
        f"Position changes: " + ", ".join(f"{k} {v:+d}" for k, v in ev["net_positions"].items()),
        f"Your needs: {', '.join(ev['your_needs']) or 'none'}  |  "
        f"Your surplus: {', '.join(ev['your_surplus']) or 'none'}",
    ]
    return "\n".join(out)


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def main(argv):
    p = argparse.ArgumentParser(description="Sleeper trade advisor")
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("team", "league", "targets"):
        sp = sub.add_parser(name)
        sp.add_argument("--league", dest="league_id", default=None)
        sp.add_argument("--json", action="store_true")
    ev = sub.add_parser("evaluate")
    ev.add_argument("--give", required=True, help="comma-separated player names you send")
    ev.add_argument("--get", required=True, help="comma-separated player names you receive")
    ev.add_argument("--league", dest="league_id", default=None)
    ev.add_argument("--json", action="store_true")
    args = p.parse_args(argv)

    try:
        cfg = load_config()
        league, user = resolve_league(cfg, args.league_id)
        analysis = analyze_league(league)
        my_team = find_my_team(analysis, user)

        if args.cmd == "team":
            print(render_team(analysis, my_team))
            payload = my_team
        elif args.cmd == "league":
            print(render_league(analysis))
            payload = [{k: v for k, v in t.items() if k not in ("starters", "bench")} for t in analysis["teams"]]
        elif args.cmd == "targets":
            sugg = find_targets(analysis, my_team)
            print(render_targets(sugg))
            payload = sugg
        elif args.cmd == "evaluate":
            give_names = [n.strip() for n in args.give.split(",") if n.strip()]
            get_names = [n.strip() for n in args.get.split(",") if n.strip()]
            give, miss_g = resolve_players_by_name(give_names, analysis)
            get, miss_r = resolve_players_by_name(get_names, analysis)
            if miss_g or miss_r:
                print(f"WARNING: could not match: {', '.join(miss_g + miss_r)} "
                      "(check spelling; excluded from totals)", file=sys.stderr)
            ev_result = evaluate_trade(give, get, analysis, my_team)
            print(render_evaluation(ev_result))
            payload = ev_result

        if args.json:
            print("\n---JSON---")
            print(json.dumps(payload, indent=2, default=str))
    except SleeperError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
