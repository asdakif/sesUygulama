# Engineering Roadmap

## Completed in this pass

- Replaced the JSON persistence layer with a SQLite-backed store in [`database.js`](../database.js).
- Added one-time migration from legacy `chat-data.json` into `chat-data.sqlite`.
- Split reusable server concerns into dedicated modules:
  - [`server/config.js`](../server/config.js)
  - [`server/logger.js`](../server/logger.js)
  - [`server/realtime-state.js`](../server/realtime-state.js)
  - [`server/soundcloud.js`](../server/soundcloud.js)
- Split client-side voice/settings helpers into [`public/voice-settings.js`](../public/voice-settings.js).
- Added project-level `lint`, `test`, `check`, `build:dir`, and `build:mac` scripts in [`package.json`](../package.json).
- Added automated tests for persistence and realtime state behavior in [`test/`](../test).
- Added structured logging for key server lifecycle and socket events.
- Added a CI-ready smoke test and GitHub Actions workflow entrypoint.
- Moved WebRTC ICE server configuration behind `/api/client-config`, so Railway can supply TURN details via environment variables.
- Replaced the shared room-password login with real user accounts backed by `/api/auth/register` and `/api/auth/login`.
- Added HTTP/socket auth middleware, token revocation on logout, and persistent session restore on the client.

## Daily commands

```bash
npm run lint
npm test
npm run smoke
npm run check
npm start
npm run desktop
```

## Highest-impact next steps

These are intentionally left as separate follow-up projects because they change product behavior or require external services:

1. Set `RTC_ICE_SERVERS_JSON` in Railway with your production TURN service instead of relying on public relay defaults.
2. Add signed release builds for Windows/macOS.
3. Add a true global push-to-talk hotkey if background-game support is needed.
4. Move the remaining large feature blocks (`poker`, chat rendering, WebRTC signaling) into more modules.
5. Add password reset / account management flows if this grows beyond a private friend group.

Registration notes:

- `PASSWORD` now acts as the registration invite code for new accounts.
- `AUTH_SECRET` can be set separately; if omitted, it falls back to `PASSWORD`.

Example `RTC_ICE_SERVERS_JSON` value for Railway:

```json
[
  { "urls": "stun:stun.l.google.com:19302" },
  {
    "urls": [
      "turn:turn.example.com:3478",
      "turns:turn.example.com:5349?transport=tcp"
    ],
    "username": "turn-user",
    "credential": "turn-password"
  }
]
```
