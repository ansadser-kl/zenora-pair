# Hermit-md Session Site

A small website where you link WhatsApp with a **pairing code** and get a **SESSION_ID**.
The bot then downloads its login from this site, so the bot only needs two variables:

```
SESSION_ID=HERMIT~xxxxxxxxxxxxxxxx
SESSION_API=https://your-site.onrender.com/session
```

## How it works
1. Open the site, type your WhatsApp number (country code, no `+`), press **Get pairing code**.
2. WhatsApp > Settings > Linked devices > Link a device > *Link with phone number instead* > type the code.
3. The site shows your **SESSION_ID**. Copy it.
4. Put `SESSION_ID` and `SESSION_API` in the bot's environment (config.env / Render variables) and start the bot.
   The bot calls `GET /session?id=<SESSION_ID>`, stores the login in its own database and from then on does not need this site.

While linking, the site holds the connection only in memory. When linking is finished the site **closes** its connection
(no logout), so the bot is the only one using the login.

## Deploy on Render (works from a phone)
1. Upload these files to a GitHub repo (without `node_modules`).
2. Render > New > **PostgreSQL** (free). Copy the *Internal Database URL*.
3. Render > New > **Web Service** > pick the repo. Runtime **Node**, Build Command `npm install`, Start Command `node server.js`.
   (Or runtime Docker, the Dockerfile is included.)
4. Environment variables: `DATABASE_URL` = the URL from step 2. Optional: `ACCESS_KEY` (see below).
5. Deploy, open the site URL. `/health` should show `{"ok":true,...}`.

Without `DATABASE_URL` the sessions are saved in `data/sessions.json`. That is fine on a VPS, but on Render's free
web service the disk is wiped on every restart, so use PostgreSQL there.

Free Render services sleep after ~15 minutes without visitors; the first request wakes them up (30-60 seconds).
Hermit-md waits and retries for about a minute, so this is fine for the first start of a bot.

## Environment variables
| Name | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | set by Render |
| `DATABASE_URL` | (file) | PostgreSQL connection URL |
| `ACCESS_KEY` | (none) | if set, the page asks for this key before a number can be linked (stops strangers from using your site) |
| `ID_PREFIX` | `HERMIT~` | start of every SESSION_ID |
| `MAX_ACTIVE` | 5 | logins running at the same time |
| `PAIR_PER_HOUR` | 5 | pairing requests per IP per hour |
| `SESSION_PER_MIN` | 60 | `/session` requests per IP per minute |
| `SETTLE_MS` | 8000 | wait after linking so WhatsApp can send the first keys |

## API (what the bot uses)
`GET /session?id=<SESSION_ID>`
```json
{ "status": true, "data": { "creds": { "...": "..." }, "pre-key-1": { "...": "..." } } }
```
Unknown id: HTTP 404 `{ "status": false, "message": "Session not found" }`.

Other endpoints: `POST /api/pair`, `GET /api/status?token=`, `GET /health`.

## Security
- The SESSION_ID is a long random secret. **Anyone who has it can use that WhatsApp login.** Do not share it, do not log it.
- Anyone who knows the site URL can link their own number (and get their own SESSION_ID). Set `ACCESS_KEY` if the site is only for you.
- Do not use WhatsApp Web / another bot with the same login while the bot runs, two connections disconnect each other (status 440).
- Sessions stay in the database until you delete the row (`DELETE FROM sessions WHERE id = '...'`).
