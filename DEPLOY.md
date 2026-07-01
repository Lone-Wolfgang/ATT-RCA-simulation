# Deploy — complete runtime bundle

This folder contains EVERYTHING the app needs to run. The last two failures were
`pool.json` and `us_states.json` missing from the commit — both are here now.

## Files (all required)

    index.html                    the app
    resample.js                   fault resampler (imported by index.html)
    query.js                      NL query + sql.js (imported by index.html)
    actionplan.js                 action-plan builder (imported by index.html)
    pool.json                     184,920 cell locations  (~18 MB)  ← was missing
    us_states.json                state GeoJSON for the choropleth  ← was missing
    netlify.toml                  publish "." + functions dir
    netlify/functions/nl2sql.js   the API-key-holding function
    .gitignore                    excludes local data ONLY, never runtime files
    .nojekyll                     keep static files untouched

## Push it

From this folder:

    git init                # if not already a repo
    git add -A
    git commit -m "Complete runtime bundle"
    git branch -M main
    git remote add origin git@github.com:Lone-Wolfgang/ATT-RCA-simulation.git
    git push -u origin main

If the repo already exists and has the broken history, easiest is to just add the
two missing files to what's already there:

    git add pool.json us_states.json
    git commit -m "Add missing runtime data files"
    git push

## Verify BEFORE trusting the deploy

Confirm git is actually tracking all eight runtime files:

    git ls-files | grep -E 'pool.json|us_states.json|index.html|resample.js|query.js|actionplan.js|nl2sql.js'

You should see all of them. If `pool.json` or `us_states.json` is absent, they're
being ignored — force them: `git add -f pool.json us_states.json`.

## Netlify

Nothing to click if the repo is already connected — the push auto-deploys. Just
make sure the env var is set once:

    Site configuration → Environment variables → ANTHROPIC_API_KEY = sk-ant-...

Then, after the deploy goes green, hard-reload (Cmd/Ctrl+Shift+R) and check these
all return real content (not "Not Found"):

    https://<your-site>.netlify.app/pool.json
    https://<your-site>.netlify.app/us_states.json
    https://<your-site>.netlify.app/query.js

The splash clears only once pool.json AND us_states.json both load.
