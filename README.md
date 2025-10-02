# Buff Givers Roster Bot (Discord)

A Discord bot that manages a 7‑day rolling roster of **buff givers** (max 2 per hourly slot, UTC).

## Features

- One static **Roster Panel** with buttons & date dropdown for members to add/remove/edit their hours for any of the next 7 days.
- A **Buff Givers Roster** category with 7 day channels (named `YYYY-MM-DD`), always kept to 7 days.
- Each day channel contains **one message that updates in place** showing the full day’s hourly schedule.
- Reminders:
  - Users get a DM _N_ minutes before their slot (default 15; configurable).
  - The King role is notified _M_ minutes before an hour **only when assignees change** from the previous hour (default 10; configurable).
- King can confirm a slot with `/kingnotify` (pings the assigned users).
- Slash commands for setup and configuration.
- Railway-friendly (uses Postgres and a simple worker Procfile).

## Quick Start (Railway)

1. **Fork or upload** this repo to GitHub.
2. On Railway:
   - New Project → **Deploy from GitHub** (select this repo).
   - Add **Postgres** plugin. Copy its `DATABASE_URL` into Variables.
   - Add Variables:
     - `DISCORD_TOKEN`
     - `DISCORD_APP_ID`
     - `DATABASE_URL`
3. Open Railway Shell → run:
   ```bash
   npm run db:init
   npm run register
   ```
4. Invite the bot to your server with scopes `bot applications.commands`. Ensure it can **Manage Channels** and **Send Messages**.
5. In your server run:
   - `/setup`
   - Optionally: `/config kingrole @King`, `/config userlead 15`, `/config kinglead 10`

## Local Dev

```bash
cp .env.example .env
# Fill DISCORD_TOKEN, DISCORD_APP_ID, DATABASE_URL
npm install
npm run db:init
npm run register
npm start
```

## Notes

- All times are UTC (UTC+0).
- Each hourly slot allows **up to 2 users**. Attempting to add a 3rd is ignored.
- The bot posts **one message per day channel** and edits it in place as the roster changes.
