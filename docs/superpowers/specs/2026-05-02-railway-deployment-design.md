# sesUygulama — Railway Deployment Design

**Date:** 2026-05-02

## Overview

Deploy sesUygulama (Node.js + Socket.io + WebRTC ses/sohbet uygulaması) to Railway as a production web service. The app will be accessible via Railway's default `.up.railway.app` URL.

## Constraints

- Message history persistence is not required — clean state on each deploy is acceptable.
- Deployment must be free or low-cost (TURN server must be free).
- Custom domain is not needed.

---

## 1. Railway Configuration

Add `railway.json` to the project root:

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": { "builder": "NIXPACKS" },
  "deploy": {
    "startCommand": "node server.js",
    "healthcheckPath": "/health",
    "healthcheckTimeout": 10,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3
  }
}
```

Add `GET /health` endpoint to `server.js` — returns `{ status: "ok" }` with HTTP 200. Railway polls this endpoint to confirm the service is alive and triggers a restart if it fails.

---

## 2. Free TURN Server (Open Relay Project)

Update the `ICE` config object in `public/app.js` to include Open Relay Project TURN servers alongside existing Google STUN servers:

```js
const ICE = { iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
]};
```

TURN is only used when a direct peer-to-peer connection cannot be established (symmetric NAT, strict firewalls). This covers users on corporate or university networks.

---

## 3. Environment Variables

Set in Railway dashboard before first deploy:

| Variable   | Value                  | Notes                          |
|------------|------------------------|--------------------------------|
| `PASSWORD` | (chosen by user)       | Room entry password            |
| `PORT`     | (set automatically)    | Railway injects this; no action needed |

---

## 4. Deploy Flow

1. Push code to GitHub (main branch).
2. Create new Railway project → connect GitHub repo.
3. Railway auto-detects Node.js via Nixpacks.
4. Set `PASSWORD` env var in Railway dashboard.
5. Deploy — Railway runs `node server.js`, app is live at `*.up.railway.app`.
6. Subsequent pushes to main trigger automatic redeploys.

---

## Files Changed

| File | Change |
|------|--------|
| `railway.json` | New file — Railway deploy config |
| `server.js` | Add `/health` endpoint |
| `public/app.js` | Add TURN servers to `ICE` config |
