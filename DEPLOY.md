# Deploying the web app to Netlify

The `web/` folder is a self-contained browser app that does all the fetching and
analysis **in your browser**, so it works from any device with normal internet —
no cloud environment, no API keys, no network-policy tinkering. A tiny
serverless function (`netlify/functions/proxy.js`) is included as a fallback for
networks where the Sleeper/FantasyCalc APIs don't allow direct browser calls.

## What's here

```
web/
  index.html      # the page
  styles.css      # styling (light + dark)
  app.js          # all data fetching + analysis, ported from the Python skill
netlify/functions/
  proxy.js        # locked-down GET proxy for the two API hosts (fallback only)
netlify.toml      # tells Netlify to serve web/ and bundle the function
```

No build step, no dependencies to install.

## Option 1 — Deploy from GitHub (recommended, ~2 minutes)

This gives you a live URL that redeploys automatically whenever you push.

1. Go to **[app.netlify.com](https://app.netlify.com)** and sign in (you can sign
   in with your GitHub account).
2. Click **Add new site → Import an existing project**.
3. Choose **GitHub** and authorize Netlify if prompted, then pick the
   **`sleeper-trade-advisor`** repository.
4. Select the branch to deploy (`main` after you merge, or
   `claude/initial-branch-setup-vgst8x` to try it now).
5. Netlify reads `netlify.toml`, so the build settings fill in automatically:
   - **Build command:** *(empty)*
   - **Publish directory:** `web`
   - **Functions directory:** `netlify/functions`
   Leave them as detected.
6. Click **Deploy**. In under a minute you'll get a URL like
   `https://your-site-name.netlify.app` — open it and it loads your team.

To change the site name: **Site configuration → Change site name**.

## Option 2 — Deploy from your computer with the Netlify CLI

```bash
npm install -g netlify-cli      # one-time
cd sleeper-trade-advisor
netlify deploy --prod           # follow the prompts to create/link a site
```

To run it locally first (this also runs the proxy function):

```bash
netlify dev                     # serves the site at http://localhost:8888
```

## After deploying

- The username and league ID are pre-filled (`slapebeboomin` /
  `1311998246557609984`) and editable in the page; your changes are remembered
  in the browser.
- First load fetches the full NFL player list (a few MB), so it takes a few
  seconds; after that, switching tabs is instant.
- Tabs: **My Team**, **Trade Targets**, **Evaluate a Trade**, **League Market**,
  **Trending Adds/Drops**.

## Notes

- The proxy only forwards GET requests to `api.sleeper.app` and
  `api.fantasycalc.com` — it can't be used to reach anything else.
- Everything is read-only and public; no secrets or credentials are involved.
- The original Python skill in `scripts/` still works unchanged for terminal use
  or as a Claude skill; the web app is an additional way to run the same logic.
