# Personal dashboard (Canvas + Spotify)

A GitHub Pages site that shows Canvas deadlines, missing work, announcements and
calendar events, plus a live Spotify widget. Canvas data is fetched by a GitHub
Action and encrypted before it is published; the page decrypts it in your browser
after you type your passphrase.

## What lives where

| Thing | Where it is | Who can read it |
| --- | --- | --- |
| Canvas token | GitHub Actions secret | Nobody (not even you, after saving) |
| Passphrase | GitHub Actions secret + your head | Nobody |
| Canvas data | `data.enc.json` on the site, AES-256-GCM encrypted | Only someone with the passphrase |
| Site code | This repo | Anyone, if the repo is public. It contains no personal data. |
| Spotify login | Your browser only | Only you |

## Setup

1. **Create a repo** (for example `dashboard`) and upload everything in this folder,
   keeping the folder structure. The default branch must be `main`.
2. **Add three secrets** under Settings → Secrets and variables → Actions:
   - `CANVAS_BASE_URL`: your school's Canvas address, e.g. `https://yourschool.instructure.com`
   - `CANVAS_TOKEN`: in Canvas, Account → Settings → New Access Token
   - `DASH_PASSPHRASE`: four or five random words. This is what you type on the lock screen.
3. **Turn on Pages**: Settings → Pages → Source → **GitHub Actions**.
4. **Run it**: Actions tab → "Update dashboard" → Run workflow. When it finishes, the
   site is at `https://<username>.github.io/<repo>/`.
5. **Spotify** (optional): at https://developer.spotify.com/dashboard create an app,
   choose "Web API", and set the Redirect URI to your exact site address including the
   trailing slash (`https://<username>.github.io/<repo>/`). Copy the Client ID into
   `site/config.js` and commit.

## Try it locally first

```
DASH_PASSPHRASE="some long test passphrase" npm run sample
npx serve site        # or: python3 -m http.server --directory site
```

## Settings

In `.github/workflows/update.yml`:
- `cron`: how often Canvas is checked (default every 30 minutes)
- `WINDOW_DAYS`: how far ahead to look (default 14)
- `INCLUDE_GRADES`: set to `"true"` to show each course's current score

## Good to know

- **Public vs private repo.** On a free GitHub account, Pages only works from a public
  repo. That is fine here: the repo holds code only. GitHub Pro (free for students
  through the Student Developer Pack) allows a private repo, but the site address is
  reachable by anyone either way, which is why the data is encrypted. In a private repo,
  change the schedule to hourly to stay inside the free Actions minutes.
- **Changing the passphrase**: update the `DASH_PASSPHRASE` secret and re-run the workflow.
- **"Remember on this device"** stores the passphrase in that browser. Leave it unchecked
  on shared computers, and use the Lock button to forget it.
- **Canvas tokens can expire.** If the workflow starts failing with a 401, make a new token.
- Workflow logs only ever show counts, never course or assignment names.
