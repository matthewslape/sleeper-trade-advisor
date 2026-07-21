# API reference (Sleeper + FantasyCalc)

The `scripts/sleeper.py` module wraps these. Read this only when you need data
the trade advisor doesn't already expose.

## Sleeper — `https://api.sleeper.app/v1`

Public, read-only, **no authentication or API key**. Be reasonable: stay well
under ~1000 requests/minute. The player index and value list are cached to the
OS temp dir (`players_nfl.json` for 24h, values for 6h) so bursts of analysis
only fetch once.

| Endpoint | Returns |
|---|---|
| `GET /state/nfl` | Current `season`, `week`, `season_type`, `leg`. |
| `GET /user/<username>` | User object incl. `user_id`. Username is **case-sensitive**. |
| `GET /user/<user_id>/leagues/nfl/<season>` | Array of the user's leagues that season. |
| `GET /league/<league_id>` | League settings: `roster_positions`, `scoring_settings`, `settings.type` (0 redraft / 1 keeper / 2 dynasty), `total_rosters`. |
| `GET /league/<league_id>/rosters` | Array of rosters: `roster_id`, `owner_id`, `starters`, `players`, `reserve`, `taxi`, `settings` (wins/losses/fpts). |
| `GET /league/<league_id>/users` | League members: `user_id`, `display_name`, `metadata.team_name`. |
| `GET /league/<league_id>/matchups/<week>` | Per-roster matchup: `matchup_id`, `points`, `players`, `starters`. |
| `GET /league/<league_id>/transactions/<week>` | Trades, waivers, free-agent moves for that week. |
| `GET /league/<league_id>/traded_picks` | Draft picks that have changed hands (dynasty). |
| `GET /players/nfl` | **Large (~5MB)** map of `player_id -> {full_name, position, team, age, injury_status, years_exp, fantasy_positions, ...}`. Cached 24h. |
| `GET /players/nfl/trending/<add\|drop>?lookback_hours=24&limit=25` | `[{player_id, count}]` — league-wide adds/drops. Join to the player index for names. |

### Joining data
- Rosters reference players by `player_id` (a string). Look up names/positions
  in the `/players/nfl` index.
- `roster.owner_id` maps to a `user_id` in `/league/<id>/users`.
- `roster.starters` is the actual weekly lineup (in slot order); everything in
  `players` but not `starters`/`reserve`/`taxi` is bench.

## FantasyCalc — `https://api.fantasycalc.com`

Free, no auth. Provides the objective **trade values** Sleeper lacks.

`GET /values/current?isDynasty=<bool>&numQbs=<n>&numTeams=<n>&ppr=<n>`

Returns an array of:
```json
{
  "player": {"name": "...", "position": "RB", "maybeTeam": "SF",
             "sleeperId": "4034", "maybeAge": 27, ...},
  "value": 8421, "overallRank": 3, "positionRank": 1, ...
}
```

- **Match to Sleeper by `player.sleeperId`** first (exact), then by normalized
  name + position as a fallback. `build_value_index()` in `trade_advisor.py`
  already does this.
- Tune the query to the league: `numQbs` = QB slots + SUPER_FLEX slots,
  `numTeams` = `total_rosters`, `ppr` = `scoring_settings.rec`, `isDynasty` =
  `settings.type == 2`.
- Kickers, team defenses, and deep rookies may be missing — treat an absent or
  `0` value as "unknown," not "worthless."

## Networking notes
- All requests honor `HTTP_PROXY`/`HTTPS_PROXY` env vars automatically (urllib).
- If both hosts 403/timeout, an outbound proxy is blocking them; the skill
  can't function without reaching at least `api.sleeper.app`.
