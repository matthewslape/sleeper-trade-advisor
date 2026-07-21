/* Sleeper Trade Advisor — browser app.
 *
 * A faithful client-side port of the Python skill (sleeper.py + trade_advisor.py).
 * All fetching and analysis run in the user's browser, so it needs no server of
 * its own beyond an optional proxy fallback (netlify/functions/proxy.js) for
 * networks where the two public APIs don't allow direct cross-origin calls.
 */

// --------------------------------------------------------------------------- //
// Config + constants
// --------------------------------------------------------------------------- //
const DEFAULT_CONFIG = {
  username: "slapebeboomin",
  league_id: "1311998246557609984",
  season: "",
};

const SLEEPER_BASE = "https://api.sleeper.app/v1";
const FANTASYCALC_BASE = "https://api.fantasycalc.com";
const PROXY_PATH = "/.netlify/functions/proxy";

const CORE_POS = ["QB", "RB", "WR", "TE"];
const FLEX_SLOTS = {
  FLEX: ["RB", "WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
  REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
};

// Session-scoped caches so switching tabs doesn't refetch the 5MB player index.
const State = {
  players: null,
  values: {}, // keyed by value-settings signature
  analysis: null, // last computed analysis
  analysisKey: null, // league id the analysis was built for
  proxyHosts: {}, // hostname -> true once a direct fetch has failed (use proxy)
  chatHistory: [], // [{role, content}] for the Ask AI tab
};

const CHAT_ENDPOINT = "/.netlify/functions/chat";

// --------------------------------------------------------------------------- //
// Fetch layer (direct first, proxy fallback)
// --------------------------------------------------------------------------- //
async function apiGetJson(url) {
  const host = new URL(url).hostname;

  if (!State.proxyHosts[host]) {
    try {
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      return await handleResponse(r);
    } catch (_e) {
      // A thrown fetch is almost always a CORS/network block, not a real HTTP
      // status. Remember it and route this host through the proxy from now on.
      State.proxyHosts[host] = true;
    }
  }

  const proxied = `${PROXY_PATH}?url=${encodeURIComponent(url)}`;
  let r;
  try {
    r = await fetch(proxied, { headers: { Accept: "application/json" } });
  } catch (e) {
    throw new AdvisorError(
      "Couldn't reach the data source, and the proxy fallback is unavailable. " +
        "If you're running this locally, use `netlify dev` (or deploy to Netlify) " +
        "so the proxy function exists."
    );
  }
  return await handleResponse(r);
}

async function handleResponse(r) {
  if (r.status === 404) return null; // treat "not found" like the Python client
  if (!r.ok) {
    throw new AdvisorError(`Request failed (HTTP ${r.status}).`);
  }
  const text = await r.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_e) {
    throw new AdvisorError("Data source returned a non-JSON response.");
  }
}

class AdvisorError extends Error {}

// --------------------------------------------------------------------------- //
// Sleeper + FantasyCalc endpoints
// --------------------------------------------------------------------------- //
const getState = () => apiGetJson(`${SLEEPER_BASE}/state/nfl`);
const getUser = (u) => apiGetJson(`${SLEEPER_BASE}/user/${encodeURIComponent(u)}`);
const getUserLeagues = (uid, season) =>
  apiGetJson(`${SLEEPER_BASE}/user/${uid}/leagues/nfl/${season}`);
const getLeague = (id) => apiGetJson(`${SLEEPER_BASE}/league/${id}`);
const getRosters = (id) => apiGetJson(`${SLEEPER_BASE}/league/${id}/rosters`);
const getLeagueUsers = (id) => apiGetJson(`${SLEEPER_BASE}/league/${id}/users`);
const getTrending = (kind, hours = 24, limit = 25) =>
  apiGetJson(
    `${SLEEPER_BASE}/players/nfl/trending/${kind}?lookback_hours=${hours}&limit=${limit}`
  );

async function loadPlayers() {
  if (State.players) return State.players;
  const data = await apiGetJson(`${SLEEPER_BASE}/players/nfl`);
  if (!data) throw new AdvisorError("Could not load the Sleeper player index.");
  State.players = data;
  return data;
}

async function loadValues(numQbs, numTeams, ppr, isDynasty) {
  const key = `${numQbs}q_${numTeams}t_${ppr}ppr_${isDynasty ? "dyn" : "red"}`;
  if (State.values[key]) return State.values[key];
  const q = new URLSearchParams({
    isDynasty: String(Boolean(isDynasty)),
    numQbs: String(numQbs),
    numTeams: String(numTeams),
    ppr: String(ppr),
  });
  const data = (await apiGetJson(`${FANTASYCALC_BASE}/values/current?${q}`)) || [];
  State.values[key] = data;
  return data;
}

// --------------------------------------------------------------------------- //
// Value matching
// --------------------------------------------------------------------------- //
function normName(name) {
  if (!name) return "";
  let n = String(name).toLowerCase();
  n = n.replace(/[.'`]/g, "");
  n = n.replace(/\s+(jr|sr|ii|iii|iv|v)\b/g, "");
  n = n.replace(/[^a-z0-9 ]/g, " ");
  return n.replace(/\s+/g, " ").trim();
}

function leagueValueSettings(league) {
  const positions = league.roster_positions || [];
  let numQbs =
    positions.filter((p) => p === "QB").length +
    positions.filter((p) => p === "SUPER_FLEX").length;
  numQbs = Math.max(1, numQbs);
  const numTeams = league.total_rosters || 12;
  const ppr = (league.scoring_settings && league.scoring_settings.rec) || 0;
  const isDynasty = (league.settings && league.settings.type) === 2;
  return { num_qbs: numQbs, num_teams: numTeams, ppr, is_dynasty: isDynasty };
}

async function buildValueIndex(league) {
  const s = leagueValueSettings(league);
  const values = (await loadValues(s.num_qbs, s.num_teams, s.ppr, s.is_dynasty)) || [];
  const bySleeperId = {};
  const byNamePos = {};
  for (const row of values) {
    const pl = row.player || {};
    const val = row.value || 0;
    if (pl.sleeperId != null) bySleeperId[String(pl.sleeperId)] = val;
    const key = `${normName(pl.name)}|${(pl.position || "").toUpperCase()}`;
    byNamePos[key] = val;
  }
  const valueOf = (playerId, players) => {
    const pid = String(playerId);
    if (pid in bySleeperId) return bySleeperId[pid];
    const info = players[pid] || {};
    const key = `${normName(info.full_name)}|${(info.position || "").toUpperCase()}`;
    return byNamePos[key] || 0;
  };
  return { valueOf, byNamePos, settings: s };
}

// --------------------------------------------------------------------------- //
// Roster enrichment
// --------------------------------------------------------------------------- //
function playerBrief(pid, players) {
  const info = players[String(pid)] || {};
  const name = info.full_name || info.last_name || String(pid);
  return {
    player_id: String(pid),
    name,
    pos: (info.position || "?").toUpperCase(),
    team: info.team || "FA",
    age: info.age != null ? info.age : null,
    injury: info.injury_status || null,
  };
}

function enrichRoster(roster, players, valueOf) {
  const starters = (roster.starters || [])
    .map(String)
    .filter((p) => p && p !== "0");
  const allPlayers = (roster.players || []).map(String).filter((p) => p && p !== "0");
  const reserve = new Set((roster.reserve || []).map(String).filter(Boolean));
  const taxi = new Set((roster.taxi || []).map(String).filter(Boolean));
  const starterSet = new Set(starters);
  const bench = allPlayers.filter(
    (p) => !starterSet.has(p) && !reserve.has(p) && !taxi.has(p)
  );

  const decorate = (pid) => {
    const b = playerBrief(pid, players);
    b.value = valueOf(pid, players);
    return b;
  };

  const enriched = {
    roster_id: roster.roster_id,
    owner_id: roster.owner_id,
    starters: starters.map(decorate).sort((a, b) => b.value - a.value),
    bench: bench.map(decorate).sort((a, b) => b.value - a.value),
    settings: roster.settings || {},
  };
  enriched.total_value = [...enriched.starters, ...enriched.bench].reduce(
    (acc, p) => acc + p.value,
    0
  );
  return enriched;
}

function positionalValue(enriched) {
  const buckets = {};
  for (const p of CORE_POS) buckets[p] = [];
  for (const p of [...enriched.starters, ...enriched.bench]) {
    if (buckets[p.pos]) buckets[p.pos].push(p.value);
  }
  const out = {};
  for (const pos of CORE_POS) out[pos] = buckets[pos].slice().sort((a, b) => b - a);
  return out;
}

function startingSlots(league) {
  const positions = league.roster_positions || [];
  const dedicated = {};
  const flexFor = {};
  for (const p of CORE_POS) {
    dedicated[p] = 0;
    flexFor[p] = 0;
  }
  for (const slot of positions) {
    if (slot in dedicated) {
      dedicated[slot] += 1;
    } else if (FLEX_SLOTS[slot]) {
      for (const p of FLEX_SLOTS[slot]) if (p in flexFor) flexFor[p] += 1;
    }
  }
  return { dedicated, flexFor };
}

// --------------------------------------------------------------------------- //
// Analysis
// --------------------------------------------------------------------------- //
async function analyzeLeague(league) {
  const players = await loadPlayers();
  const { valueOf, byNamePos, settings } = await buildValueIndex(league);
  const rosters = (await getRosters(league.league_id)) || [];
  const usersArr = (await getLeagueUsers(league.league_id)) || [];
  const users = {};
  for (const u of usersArr) users[u.user_id] = u;

  const teams = [];
  for (const r of rosters) {
    const e = enrichRoster(r, players, valueOf);
    const u = users[r.owner_id] || {};
    e.team_name =
      (u.metadata && u.metadata.team_name) || u.display_name || `Roster ${e.roster_id}`;
    e.owner_name = u.display_name || "?";
    e.pos_values = positionalValue(e);
    const st = r.settings || {};
    e.record =
      `${st.wins || 0}-${st.losses || 0}` + (st.ties ? `-${st.ties}` : "");
    e.fpts = (st.fpts || 0) + (st.fpts_decimal || 0) / 100.0;
    teams.push(e);
  }

  const { dedicated, flexFor } = startingSlots(league);

  for (const pos of CORE_POS) {
    let nStart = dedicated[pos] + flexFor[pos];
    nStart = Math.max(1, nStart);
    const ranked = teams
      .slice()
      .sort(
        (a, b) =>
          sumTop(b.pos_values[pos], nStart) - sumTop(a.pos_values[pos], nStart)
      );
    ranked.forEach((t, i) => {
      t.pos_rank = t.pos_rank || {};
      t.pos_starter_value = t.pos_starter_value || {};
      t.pos_rank[pos] = i + 1;
      t.pos_starter_value[pos] = sumTop(t.pos_values[pos], nStart);
    });
  }

  const nTeams = teams.length;
  for (const t of teams) {
    const needs = [];
    const surplus = [];
    for (const pos of CORE_POS) {
      const rank = t.pos_rank[pos];
      const nStart = realStartSlots(dedicated, flexFor, pos);
      const depth = t.pos_values[pos].filter((v) => v > 0).length;
      if (rank > nTeams * 0.6) {
        needs.push(pos);
      } else if (rank <= nTeams * 0.34 && depth > nStart) {
        surplus.push(pos);
      }
    }
    t.needs = needs;
    t.surplus = surplus;
  }

  // Every player id that sits on any roster (starters, bench, IR, taxi) — used
  // to tell free agents apart from rostered players for the waiver views.
  const rosteredIds = new Set();
  for (const r of rosters) {
    for (const key of ["starters", "players", "reserve", "taxi"]) {
      for (const pid of r[key] || []) {
        if (pid && pid !== "0") rosteredIds.add(String(pid));
      }
    }
  }

  return {
    league,
    value_settings: settings,
    teams,
    dedicated,
    flexFor,
    players,
    valueOf,
    byNamePos,
    rosteredIds,
  };
}

function sumTop(arr, n) {
  return arr.slice(0, n).reduce((acc, v) => acc + v, 0);
}

function findMyTeam(analysis, user) {
  const t = analysis.teams.find((t) => t.owner_id === user.user_id);
  if (!t) {
    throw new AdvisorError(
      "Could not find your team in this league (owner_id mismatch). " +
        "Check that the username matches an owner in this league."
    );
  }
  return t;
}

// --------------------------------------------------------------------------- //
// Trade evaluation
// --------------------------------------------------------------------------- //
function resolvePlayersByName(names, analysis) {
  const players = analysis.players;
  const nameIndex = {};
  for (const [pid, info] of Object.entries(players)) {
    const pos = (info.position || "").toUpperCase();
    if (CORE_POS.includes(pos) || pos === "K" || pos === "DEF") {
      const key = normName(info.full_name);
      if (!(key in nameIndex)) nameIndex[key] = pid;
    }
  }
  const resolved = [];
  const missing = [];
  for (const raw of names) {
    const pid = nameIndex[normName(raw)];
    if (pid) {
      const b = playerBrief(pid, players);
      b.value = analysis.valueOf(pid, players);
      resolved.push(b);
    } else {
      missing.push(raw);
    }
  }
  return { resolved, missing };
}

function verdict(pct) {
  if (pct >= 15) return "Clear win for you";
  if (pct >= 5) return "Slightly favors you";
  if (pct > -5) return "Roughly even";
  if (pct > -15) return "Slightly favors them";
  return "Overpay — favors them";
}

function evaluateTrade(give, get, myTeam) {
  const giveV = give.reduce((a, p) => a + p.value, 0);
  const getV = get.reduce((a, p) => a + p.value, 0);
  const delta = getV - giveV;
  const total = giveV + getV || 1;
  const pct = (100.0 * delta) / (total / 2);
  const impact = {};
  for (const p of get) impact[p.pos] = (impact[p.pos] || 0) + 1;
  for (const p of give) impact[p.pos] = (impact[p.pos] || 0) - 1;
  return {
    give,
    get,
    give_value: giveV,
    get_value: getV,
    value_delta: delta,
    value_delta_pct: Math.round(pct * 10) / 10,
    verdict: verdict(pct),
    net_positions: impact,
    your_needs: myTeam.needs,
    your_surplus: myTeam.surplus,
  };
}

// --------------------------------------------------------------------------- //
// Trade-target finder
// --------------------------------------------------------------------------- //
/** Realistic count of startable slots for a position: dedicated slots plus at
 * most one flex spot. (Counting *every* flex slot toward *every* eligible
 * position, as a naive sum would, makes "surplus" and "movable" almost
 * impossible to reach, which is why trade targets used to come up empty.) */
function realStartSlots(dedicated, flexFor, pos) {
  return Math.max(1, (dedicated[pos] || 0) + Math.min(flexFor[pos] || 0, 1));
}

function bestSurplusPlayer(team, pos, analysis, nearValue) {
  const keep = realStartSlots(analysis.dedicated, analysis.flexFor, pos);
  const pool = [...team.starters, ...team.bench]
    .filter((p) => p.pos === pos && p.value > 0)
    .sort((a, b) => b.value - a.value);
  let movable = pool.slice(keep);
  if (!movable.length) return null;
  if (nearValue != null) {
    movable = movable
      .slice()
      .sort((a, b) => Math.abs(a.value - nearValue) - Math.abs(b.value - nearValue));
  }
  return movable[0];
}

/** Players a team can plausibly move: depth beyond its startable slots at each
 * position, falling back to its cheapest bench pieces if it has no real depth,
 * so we always have something to offer. */
function movablePlayers(team, analysis) {
  const out = [];
  for (const pos of CORE_POS) {
    const keep = realStartSlots(analysis.dedicated, analysis.flexFor, pos);
    const pool = [...team.starters, ...team.bench]
      .filter((p) => p.pos === pos && p.value > 0)
      .sort((a, b) => b.value - a.value);
    out.push(...pool.slice(keep));
  }
  if (!out.length) {
    const bench = [...team.bench].filter((p) => p.value > 0).sort((a, b) => a.value - b.value);
    out.push(...bench.slice(0, 3));
  }
  return out.sort((a, b) => b.value - a.value);
}

function findTargets(analysis, myTeam, maxPartners = 4) {
  // Primary pass: clean two-way swaps where each side fixes the other's need.
  const suggestions = [];
  for (const opp of analysis.teams) {
    if (opp.roster_id === myTeam.roster_id) continue;
    const myNeedsTheyHave = myTeam.needs.filter((p) => opp.surplus.includes(p));
    const theirNeedsIHave = opp.needs.filter((p) => myTeam.surplus.includes(p));
    if (!myNeedsTheyHave.length || !theirNeedsIHave.length) continue;
    for (const needPos of myNeedsTheyHave) {
      const target = bestSurplusPlayer(opp, needPos, analysis);
      if (!target) continue;
      for (const givePos of theirNeedsIHave) {
        const offer = bestSurplusPlayer(myTeam, givePos, analysis, target.value);
        if (!offer) continue;
        suggestions.push({
          partner: opp.team_name,
          partner_owner: opp.owner_name,
          partner_record: opp.record,
          you_get: target,
          you_give: offer,
          fills_your_need: needPos,
          fills_their_need: givePos,
          value_gap: target.value - offer.value,
        });
      }
    }
  }
  if (suggestions.length) {
    suggestions.sort((a, b) => Math.abs(a.value_gap) - Math.abs(b.value_gap));
    return suggestions.slice(0, maxPartners * 2);
  }

  // Fallback: no clean mutual match, so surface realistic *upgrade leads* — the
  // best player another team could reasonably move at each of your neediest
  // positions, paired with your most expendable near-value piece.
  const tradeable = movablePlayers(myTeam, analysis);
  if (!tradeable.length) return [];
  const needs = myTeam.needs.length
    ? myTeam.needs
    : [...CORE_POS].sort((a, b) => myTeam.pos_rank[b] - myTeam.pos_rank[a]).slice(0, 2);

  const leads = [];
  const seen = new Set();
  for (const needPos of needs) {
    const myBest = Math.max(
      0,
      ...[...myTeam.starters, ...myTeam.bench]
        .filter((p) => p.pos === needPos)
        .map((p) => p.value)
    );
    const candidates = [];
    for (const opp of analysis.teams) {
      if (opp.roster_id === myTeam.roster_id) continue;
      const pool = [...opp.starters, ...opp.bench]
        .filter((p) => p.pos === needPos && p.value > 0)
        .sort((a, b) => b.value - a.value);
      // Skip each team's single best at the position — nobody trades their stud.
      pool.slice(1).forEach((p) => candidates.push({ opp, p }));
    }
    candidates.sort((a, b) => b.p.value - a.p.value);
    for (const { opp, p } of candidates) {
      if (p.value <= myBest) continue; // must actually upgrade you
      const key = `${opp.roster_id}:${p.name}`;
      if (seen.has(key)) continue;
      const offer = tradeable
        .slice()
        .sort((a, b) => Math.abs(a.value - p.value) - Math.abs(b.value - p.value))[0];
      if (!offer) continue;
      seen.add(key);
      leads.push({
        partner: opp.team_name,
        partner_owner: opp.owner_name,
        partner_record: opp.record,
        you_get: p,
        you_give: offer,
        fills_your_need: needPos,
        fills_their_need: offer.pos,
        value_gap: p.value - offer.value,
        lead: true,
      });
      if (leads.length >= maxPartners * 2) break;
    }
    if (leads.length >= maxPartners * 2) break;
  }
  leads.sort((a, b) => Math.abs(a.value_gap) - Math.abs(b.value_gap));
  return leads.slice(0, maxPartners * 2);
}

// --------------------------------------------------------------------------- //
// Waiver wire / trends (built from FantasyCalc values + league rosters)
// --------------------------------------------------------------------------- //
/** Pure: turn the FantasyCalc value rows + league analysis into the three
 * waiver panels. Kept separate from the fetch so it's unit-testable. */
function computeWaivers(rows, analysis, topN = 5) {
  const rostered = analysis.rosteredIds || new Set();
  const byPosGroups = (make) => {
    const g = {};
    for (const pos of CORE_POS) g[pos] = [];
    make(g);
    return g;
  };

  // Index every value row by sleeperId so we can attach position rank to
  // rostered/bench players too.
  const bySid = {};
  const free = byPosGroups((g) => {
    for (const row of rows) {
      const pl = row.player || {};
      const pos = (pl.position || "").toUpperCase();
      const sid = pl.sleeperId != null ? String(pl.sleeperId) : null;
      if (sid) bySid[sid] = row;
      if (!g[pos]) continue;
      if (sid && rostered.has(sid)) continue; // rostered => not a free agent
      g[pos].push({
        name: pl.name,
        pos,
        team: pl.maybeTeam || "FA",
        value: row.value || 0,
        posRank: row.positionRank != null ? row.positionRank : null,
        trend: row.trend30Day || 0,
      });
    }
  });

  const waiver = {};
  const risers = {};
  for (const pos of CORE_POS) {
    waiver[pos] = free[pos].slice().sort((a, b) => b.value - a.value).slice(0, topN);
    risers[pos] = free[pos]
      .slice()
      .filter((p) => p.trend !== 0)
      .sort((a, b) => b.trend - a.trend)
      .slice(0, topN);
  }

  // Highest-value players sitting on benches across the whole league.
  const bench = byPosGroups((g) => {
    for (const t of analysis.teams) {
      for (const p of t.bench) {
        if (!g[p.pos]) continue;
        const row = bySid[p.player_id];
        g[p.pos].push({
          name: p.name,
          pos: p.pos,
          team: p.team,
          value: p.value,
          posRank: row && row.positionRank != null ? row.positionRank : null,
          owner: t.owner_name,
        });
      }
    }
  });
  for (const pos of CORE_POS) {
    bench[pos] = bench[pos].sort((a, b) => b.value - a.value).slice(0, topN);
  }

  return { waiver, risers, bench };
}

async function buildWaivers(analysis) {
  const vs = analysis.value_settings;
  const rows = (await loadValues(vs.num_qbs, vs.num_teams, vs.ppr, vs.is_dynasty)) || [];
  return computeWaivers(rows, analysis);
}

// --------------------------------------------------------------------------- //
// League resolution + top-level orchestration
// --------------------------------------------------------------------------- //
async function resolveLeague(cfg) {
  const user = await getUser(cfg.username);
  if (!user) {
    throw new AdvisorError(
      `No Sleeper user named "${cfg.username}". Check the spelling and case.`
    );
  }
  if (cfg.league_id) {
    const league = await getLeague(cfg.league_id);
    if (!league) throw new AdvisorError(`League ${cfg.league_id} not found.`);
    return { league, user };
  }
  const season = cfg.season || ((await getState()) || {}).season;
  const leagues = (await getUserLeagues(user.user_id, season)) || [];
  if (!leagues.length) {
    throw new AdvisorError(`"${cfg.username}" has no NFL leagues for ${season}.`);
  }
  if (leagues.length === 1) return { league: leagues[0], user };
  const listing = leagues
    .map((lg) => `${lg.name} (league_id: ${lg.league_id})`)
    .join("; ");
  throw new AdvisorError(
    `"${cfg.username}" is in ${leagues.length} leagues for ${season}. ` +
      `Set a League ID above. Options: ${listing}`
  );
}

/** Build (or reuse) the analysis + my team for the current config. */
async function getContext(cfg) {
  const { league, user } = await resolveLeague(cfg);
  if (State.analysis && State.analysisKey === league.league_id) {
    return { analysis: State.analysis, myTeam: findMyTeam(State.analysis, user), user };
  }
  const analysis = await analyzeLeague(league);
  State.analysis = analysis;
  State.analysisKey = league.league_id;
  const myTeam = findMyTeam(analysis, user);
  return { analysis, myTeam, user };
}

// --------------------------------------------------------------------------- //
// Rendering
// --------------------------------------------------------------------------- //
function esc(s) {
  return String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function posBadge(pos) {
  return `<span class="pos pos-${esc(pos)}">${esc(pos)}</span>`;
}

function playerRow(p) {
  const inj = p.injury ? `<span class="inj">${esc(p.injury)}</span>` : "";
  const age = p.age ? `<span class="meta">age ${esc(p.age)}</span>` : "";
  return `<div class="player">
    <div class="player-id">${posBadge(p.pos)}
      <span class="pname">${esc(p.name)}</span>
      <span class="meta">${esc(p.team)}</span>${age}${inj}
    </div>
    <div class="pval">${p.value}</div>
  </div>`;
}

function chips(list, cls, emptyLabel) {
  if (!list || !list.length) return `<span class="chip muted">${esc(emptyLabel)}</span>`;
  return list.map((x) => `<span class="chip ${cls}">${esc(x)}</span>`).join(" ");
}

function settingsLine(vs, league) {
  return `${esc(league.name)} &middot; ${vs.is_dynasty ? "dynasty" : "redraft"},
    ${vs.num_qbs}QB, ${vs.num_teams}-team, ${vs.ppr}PPR`;
}

function renderTeam(analysis, t) {
  const vs = analysis.value_settings;
  const posRanks = CORE_POS.map(
    (pos) =>
      `<div class="rank-cell">${posBadge(pos)}
        <div><b>#${t.pos_rank[pos]}</b> <span class="meta">of ${analysis.teams.length}</span></div>
        <div class="meta">val ${t.pos_starter_value[pos]}</div>
      </div>`
  ).join("");

  return `
    <div class="card head-card">
      <div class="head-top">
        <div>
          <h2>${esc(t.team_name)}</h2>
          <div class="meta">${esc(t.owner_name)} &middot; ${esc(t.record)} &middot; ${t.fpts.toFixed(1)} pts</div>
        </div>
        <div class="totval"><div class="totval-num">${t.total_value}</div><div class="meta">roster value</div></div>
      </div>
      <div class="meta subtle">${settingsLine(vs, analysis.league)}</div>
      <div class="needsurp">
        <div><span class="label">Needs</span> ${chips(t.needs, "need", "none glaring")}</div>
        <div><span class="label">Surplus</span> ${chips(t.surplus, "surplus", "none obvious")}</div>
      </div>
      <div class="rank-row">${posRanks}</div>
    </div>
    <div class="card">
      <h3>Starters</h3>
      ${t.starters.map(playerRow).join("") || '<div class="meta">(none)</div>'}
    </div>
    <div class="card">
      <h3>Bench</h3>
      ${t.bench.map(playerRow).join("") || '<div class="meta">(none)</div>'}
    </div>`;
}

function renderLeague(analysis) {
  const teams = analysis.teams.slice().sort((a, b) => b.fpts - a.fpts);
  const rows = teams
    .map(
      (t) => `<tr>
        <td><b>${esc(t.team_name)}</b><div class="meta">${esc(t.owner_name)}</div></td>
        <td>${esc(t.record)}</td>
        <td class="num">${t.total_value}</td>
        <td>${chips(t.needs, "need", "—")}</td>
        <td>${chips(t.surplus, "surplus", "—")}</td>
      </tr>`
    )
    .join("");
  return `<div class="card">
    <h3>League trade market</h3>
    <div class="meta subtle">${settingsLine(analysis.value_settings, analysis.league)}</div>
    <div class="table-wrap"><table>
      <thead><tr><th>Team</th><th>Record</th><th class="num">Value</th><th>Needs</th><th>Surplus</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

function renderTargets(suggestions) {
  if (!suggestions.length) {
    return `<div class="card"><p class="meta">No trade leads to show — this usually
      means your roster has no clear surplus to deal from, or the league's other
      teams don't have an upgrade at your weak spots. Try the <b>League Market</b>
      tab to eyeball value gaps, or use <b>Evaluate a Trade</b> to test a specific
      idea.</p></div>`;
  }
  const isLead = suggestions.some((s) => s.lead);
  const intro = isLead
    ? `<div class="card"><p class="meta">No perfectly balanced two-way swap right
        now, so here are <b>upgrade leads</b>: the best players other teams could
        realistically move at your neediest spots, paired with your most
        expendable near-value piece. You'll usually add or adjust a bench piece to
        even out the value — use <b>Evaluate a Trade</b> to fine-tune.</p></div>`
    : "";
  const cards = suggestions
    .map((s) => {
      const gap = s.value_gap;
      const tilt = Math.abs(gap) < 400 ? "even" : gap > 0 ? "you win" : "they win";
      const tiltCls = Math.abs(gap) < 400 ? "even" : gap > 0 ? "win" : "lose";
      const giveLabel = s.lead
        ? `You give &middot; expendable depth`
        : `You give &middot; fills their ${esc(s.fills_their_need)}`;
      return `<div class="card target">
        <div class="target-head">With <b>${esc(s.partner)}</b>
          <span class="meta">(${esc(s.partner_owner)}, ${esc(s.partner_record)})</span></div>
        <div class="swap">
          <div class="swap-side get">
            <div class="swap-label">You get &middot; upgrades your ${esc(s.fills_your_need)}</div>
            ${playerRow(s.you_get)}
          </div>
          <div class="swap-side give">
            <div class="swap-label">${giveLabel}</div>
            ${playerRow(s.you_give)}
          </div>
        </div>
        <div class="gap ${tiltCls}">Value gap: ${gap >= 0 ? "+" : ""}${gap} &middot; ${tilt}</div>
      </div>`;
    })
    .join("");
  return intro + cards;
}

function renderWaivers(data) {
  const rankBadge = (pos, rank) =>
    rank != null ? `<span class="rankbadge">${esc(pos)}${rank}</span>` : "";

  const rowHtml = (r, i, opts) => `<div class="wrow">
      <span class="wrank">${i + 1}.</span>
      <span class="wname">${esc(r.name)}</span>
      ${rankBadge(r.pos, r.posRank)}
      ${opts.owner && r.owner ? `<span class="wowner">${esc(r.owner)}</span>` : ""}
      <span class="wspacer"></span>
      ${opts.trend && r.trend ? `<span class="wtrend">+${r.trend}</span>` : ""}
      <span class="wval">${r.value}</span>
    </div>`;

  const posBlock = (pos, rows, opts) => `<div class="wblock">
      <div class="wpos">${esc(pos)}</div>
      ${
        rows && rows.length
          ? rows.map((r, i) => rowHtml(r, i, opts)).join("")
          : '<div class="meta wempty">(none)</div>'
      }
    </div>`;

  const panel = (title, sub, byPos, opts) => `<div class="card waiver-col">
      <h3 class="waiver-title">${esc(title)}${sub ? ` <span class="waiver-sub">${esc(sub)}</span>` : ""}</h3>
      ${CORE_POS.map((pos) => posBlock(pos, byPos[pos], opts)).join("")}
    </div>`;

  return `<div class="waiver-grid">
    ${panel("Waiver Wire", "", data.waiver, {})}
    ${panel("Top Waiver Risers", "(30 day)", data.risers, { trend: true })}
    ${panel("Top Bench Players", "", data.bench, { owner: true })}
  </div>`;
}

// --------------------------------------------------------------------------- //
// Ask AI (chat) — grounds a Groq-hosted open model in the live league data
// --------------------------------------------------------------------------- //
/** Compact, text snapshot of the league for the chatbot to reason over. */
function buildChatContext(analysis, myTeam) {
  const vs = analysis.value_settings;
  const lg = analysis.league;
  const fmtP = (p) =>
    `${p.name} ${p.pos}-${p.team}${p.age ? ` age ${p.age}` : ""}${p.injury ? ` (${p.injury})` : ""} — ${p.value}`;

  const lines = [];
  lines.push(
    `Format: ${lg.name} · ${vs.is_dynasty ? "dynasty" : "redraft"}, ${vs.num_qbs}QB, ${vs.num_teams}-team, ${vs.ppr}PPR`
  );

  lines.push("");
  lines.push(`=== YOUR TEAM: ${myTeam.team_name} (${myTeam.owner_name}) — ${myTeam.record}, ${myTeam.fpts.toFixed(1)} pts ===`);
  lines.push(`Total roster value: ${myTeam.total_value}`);
  lines.push(`Needs: ${myTeam.needs.join(", ") || "none glaring"} | Surplus: ${myTeam.surplus.join(", ") || "none obvious"}`);
  lines.push(
    "Positional rank (1=best): " +
      CORE_POS.map((pos) => `${pos} #${myTeam.pos_rank[pos]}/${analysis.teams.length}`).join(", ")
  );
  lines.push("Starters: " + myTeam.starters.map(fmtP).join("; "));
  lines.push("Bench: " + (myTeam.bench.map(fmtP).join("; ") || "(none)"));

  lines.push("");
  lines.push("=== LEAGUE (highest roster value first) ===");
  analysis.teams
    .slice()
    .sort((a, b) => b.total_value - a.total_value)
    .forEach((t) => {
      const you = t.roster_id === myTeam.roster_id ? " [YOU]" : "";
      lines.push(
        `${t.team_name} (${t.owner_name})${you} — ${t.record}, val ${t.total_value}, needs:[${t.needs.join(",") || "-"}] surplus:[${t.surplus.join(",") || "-"}]`
      );
    });

  const targets = findTargets(analysis, myTeam);
  if (targets.length) {
    lines.push("");
    lines.push("=== SUGGESTED TARGETS (value-balanced leads) ===");
    targets.forEach((s) => {
      lines.push(
        `With ${s.partner} (${s.partner_owner}): GET ${fmtP(s.you_get)} [upgrades your ${s.fills_your_need}] / GIVE ${fmtP(s.you_give)} — value gap ${s.value_gap >= 0 ? "+" : ""}${s.value_gap}`
      );
    });
  }
  return lines.join("\n");
}

function chatBubble(role, text) {
  return `<div class="bubble ${role === "assistant" ? "bot" : "you"}">${esc(text).replace(/\n/g, "<br>")}</div>`;
}

function renderChat() {
  const pw = (() => {
    try {
      return localStorage.getItem("sta_chat_pw") || "";
    } catch (_e) {
      return "";
    }
  })();
  const bubbles = State.chatHistory.length
    ? State.chatHistory.map((m) => chatBubble(m.role, m.content)).join("")
    : `<div class="bubble bot">Ask me anything about your team or a trade — e.g. <i>"Should I trade Bijan for CeeDee Lamb?"</i>, <i>"Who's my best buy-low?"</i>, or <i>"What does my roster actually need?"</i> I read your live league data before answering.</div>`;

  return `<div class="card chat-card">
    <div class="chat-pw">
      <label>Access password</label>
      <input id="chat-pw" type="password" autocomplete="off" placeholder="set in Netlify (CHAT_PASSWORD)" value="${esc(pw)}" />
    </div>
    <div id="chat-log" class="chat-log">${bubbles}</div>
    <div id="chat-status" class="chat-status"></div>
    <div class="chat-inputrow">
      <textarea id="chat-input" rows="2" placeholder="Ask about a trade… (Enter to send, Shift+Enter for a new line)"></textarea>
      <button id="chat-send" class="primary" type="button">Send</button>
    </div>
  </div>`;
}

function setupChat(cfg) {
  const log = document.getElementById("chat-log");
  const input = document.getElementById("chat-input");
  const sendBtn = document.getElementById("chat-send");
  const pwEl = document.getElementById("chat-pw");
  const statusEl = document.getElementById("chat-status");

  const scroll = () => (log.scrollTop = log.scrollHeight);
  const addBubble = (role, text) => {
    if (!State.chatHistory.length) log.innerHTML = ""; // clear the intro on first send
    State.chatHistory.push({ role, content: text });
    log.insertAdjacentHTML("beforeend", chatBubble(role, text));
    scroll();
  };

  pwEl.addEventListener("change", () => {
    try {
      localStorage.setItem("sta_chat_pw", pwEl.value.trim());
    } catch (_e) {
      /* ignore */
    }
  });

  let busy = false;
  async function send() {
    if (busy) return;
    const text = input.value.trim();
    if (!text) return;
    busy = true;
    sendBtn.disabled = true;
    input.value = "";
    addBubble("user", text);
    statusEl.innerHTML = `<span class="spinner"></span> Reading your league and thinking…`;

    try {
      const { analysis, myTeam } = await getContext(readConfig());
      const context = buildChatContext(analysis, myTeam);
      const resp = await fetch(CHAT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: State.chatHistory,
          context,
          password: pwEl.value.trim(),
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        statusEl.innerHTML = `<span class="chat-err">${esc(data.error || `Request failed (HTTP ${resp.status}).`)}</span>`;
      } else {
        addBubble("assistant", data.reply || "(no response)");
        statusEl.innerHTML = "";
      }
    } catch (e) {
      statusEl.innerHTML = `<span class="chat-err">${esc(
        e instanceof AdvisorError ? e.message : "Couldn't reach the chat backend. If running locally, use `netlify dev` so the function exists."
      )}</span>`;
    } finally {
      busy = false;
      sendBtn.disabled = false;
      input.focus();
    }
  }

  sendBtn.addEventListener("click", send);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  input.focus();
}

function renderEvaluation(ev, missing) {
  const pct = ev.value_delta_pct;
  const cls = pct >= 5 ? "win" : pct <= -5 ? "lose" : "even";
  const warn = missing.length
    ? `<div class="warn">Couldn't match: ${esc(missing.join(", "))}
        (check spelling; excluded from totals).</div>`
    : "";
  const posChanges = Object.entries(ev.net_positions)
    .map(([k, v]) => `${esc(k)} ${v >= 0 ? "+" : ""}${v}`)
    .join(", ");
  return `${warn}
    <div class="card verdict ${cls}">
      <div class="verdict-main">${esc(ev.verdict)}</div>
      <div class="verdict-sub">Value delta ${ev.value_delta >= 0 ? "+" : ""}${ev.value_delta}
        (${pct >= 0 ? "+" : ""}${pct}%)</div>
    </div>
    <div class="eval-grid">
      <div class="card">
        <h3>You give <span class="meta">(${ev.give_value})</span></h3>
        ${ev.give.map(playerRow).join("") || '<div class="meta">(nothing matched)</div>'}
      </div>
      <div class="card">
        <h3>You get <span class="meta">(${ev.get_value})</span></h3>
        ${ev.get.map(playerRow).join("") || '<div class="meta">(nothing matched)</div>'}
      </div>
    </div>
    <div class="card">
      <div class="meta">Position changes: ${posChanges || "—"}</div>
      <div class="needsurp">
        <div><span class="label">Your needs</span> ${chips(ev.your_needs, "need", "none")}</div>
        <div><span class="label">Your surplus</span> ${chips(ev.your_surplus, "surplus", "none")}</div>
      </div>
    </div>`;
}

function renderTrending(list, players, kind) {
  if (!list || !list.length) {
    return `<div class="card"><p class="meta">No trending ${esc(kind)} data right now.</p></div>`;
  }
  const rows = list
    .map((row) => {
      const b = playerBrief(row.player_id, players);
      return `<div class="player">
        <div class="player-id">${posBadge(b.pos)}
          <span class="pname">${esc(b.name)}</span>
          <span class="meta">${esc(b.team)}</span>
          ${b.injury ? `<span class="inj">${esc(b.injury)}</span>` : ""}
        </div>
        <div class="pval">${kind === "add" ? "+" : "−"}${row.count.toLocaleString()}</div>
      </div>`;
    })
    .join("");
  return `<div class="card">
    <h3>Trending ${kind === "add" ? "adds" : "drops"} <span class="meta">(last 24h, league-wide)</span></h3>
    ${rows}
  </div>`;
}

// --------------------------------------------------------------------------- //
// UI wiring
// --------------------------------------------------------------------------- //
function readConfig() {
  const saved = JSON.parse(localStorage.getItem("sta_config") || "null") || {};
  return {
    username: document.getElementById("username").value.trim() || saved.username || DEFAULT_CONFIG.username,
    league_id: document.getElementById("league").value.trim() || saved.league_id || DEFAULT_CONFIG.league_id,
    season: DEFAULT_CONFIG.season,
  };
}

function saveConfig(cfg) {
  localStorage.setItem("sta_config", JSON.stringify(cfg));
}

function setStatus(msg, kind) {
  const el = document.getElementById("status");
  el.className = "status" + (kind ? " " + kind : "");
  el.innerHTML = msg;
}

function setResult(html) {
  document.getElementById("result").innerHTML = html;
}

let activeTab = "team";

async function run(tab) {
  activeTab = tab;
  document.querySelectorAll(".tab").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === tab)
  );
  document.getElementById("evaluate-inputs").style.display =
    tab === "evaluate" ? "flex" : "none";

  const cfg = readConfig();
  if (!cfg.username) {
    setStatus("Enter your Sleeper username above.", "error");
    return;
  }
  saveConfig(cfg);

  // The chat tab is interactive — render it immediately and load league data
  // lazily on the first question, rather than blocking on analysis up front.
  if (tab === "chat") {
    setStatus("");
    setResult(renderChat());
    setupChat(cfg);
    return;
  }

  setStatus(`<span class="spinner"></span> Loading… (first run fetches the full player list — a few seconds)`);
  setResult("");

  try {
    if (tab === "trending-add" || tab === "trending-drop") {
      const players = await loadPlayers();
      const kind = tab === "trending-add" ? "add" : "drop";
      const list = (await getTrending(kind, 24, 25)) || [];
      setResult(renderTrending(list, players, kind));
      setStatus("");
      return;
    }

    const { analysis, myTeam } = await getContext(cfg);

    if (tab === "team") {
      setResult(renderTeam(analysis, myTeam));
    } else if (tab === "league") {
      setResult(renderLeague(analysis));
    } else if (tab === "targets") {
      setResult(renderTargets(findTargets(analysis, myTeam)));
    } else if (tab === "waivers") {
      setResult(renderWaivers(await buildWaivers(analysis)));
    } else if (tab === "evaluate") {
      const giveNames = document.getElementById("give").value.split(",").map((s) => s.trim()).filter(Boolean);
      const getNames = document.getElementById("get").value.split(",").map((s) => s.trim()).filter(Boolean);
      if (!giveNames.length && !getNames.length) {
        setStatus("Enter the players you'd give and get, then press Evaluate.", "");
        setResult("");
        return;
      }
      const g = resolvePlayersByName(giveNames, analysis);
      const r = resolvePlayersByName(getNames, analysis);
      const ev = evaluateTrade(g.resolved, r.resolved, myTeam);
      setResult(renderEvaluation(ev, [...g.missing, ...r.missing]));
    }
    setStatus("");
  } catch (e) {
    if (e instanceof AdvisorError) {
      setStatus(esc(e.message), "error");
    } else {
      setStatus("Unexpected error: " + esc(e.message || String(e)), "error");
      console.error(e);
    }
    setResult("");
  }
}

function setupThemeToggle() {
  // The initial theme is applied before paint by the inline script in index.html;
  // here we just flip and persist it on click.
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const current =
      document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("sta_theme", next);
    } catch (_e) {
      /* ignore storage failures */
    }
  });
}

function init() {
  setupThemeToggle();

  const saved = JSON.parse(localStorage.getItem("sta_config") || "null") || {};
  document.getElementById("username").value = saved.username || DEFAULT_CONFIG.username;
  document.getElementById("league").value = saved.league_id || DEFAULT_CONFIG.league_id;

  document.querySelectorAll(".tab").forEach((b) =>
    b.addEventListener("click", () => run(b.dataset.tab))
  );
  document.getElementById("eval-run").addEventListener("click", () => run("evaluate"));
  // Changing identity invalidates the cached analysis.
  ["username", "league"].forEach((id) =>
    document.getElementById(id).addEventListener("change", () => {
      State.analysis = null;
      State.analysisKey = null;
    })
  );

  run("team");
}

document.addEventListener("DOMContentLoaded", init);
