# payouts.build

Portfolio site: globe intro, live Roblox game stats, About, and a live Discord contact card.

## Files

| File | What it is |
|---|---|
| `index.html` | Page structure and text (About bio, roles, headings) |
| `styles.css` | All styling |
| `app.js` | Intro globe, live stats, Discord card |
| `games.js` | **Your games list** — place IDs + role tags |
| `server.js` | Tiny web server Railway runs (`npm start`) |
| `serve.ps1` | Optional local preview on Windows without Node |

## Common edits

- **Add/remove a game:** edit `games.js`.
- **Change your Discord/Roblox account:** `DISCORD_ID` / `ROBLOX_USER_ID` in `app.js`.

Push to GitHub and Railway redeploys automatically.

## Run locally

- With Node: `npm start` → http://localhost:8080
- Without Node (Windows): `powershell -ExecutionPolicy Bypass -File serve.ps1`
