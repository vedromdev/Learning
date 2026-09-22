# Deploying Simurgh Chat on Railway

This guide takes the project from zero to a running, persistent deployment on
[Railway](https://railway.com). Total time: ~15 minutes.

## What was added to make this work

| File | Purpose |
| --- | --- |
| `Dockerfile` | Multi-stage production image (Node 22, Prisma, Next.js, Socket.IO, mongodump tools) |
| `railway.json` | Tells Railway to use the Dockerfile, health-check `/api/health`, restart on failure |
| `.dockerignore` | Keeps the image small and secrets out of it |
| `scripts/bootstrap.mjs` | Runs on every boot: validates env, creates data dirs, `prisma db push`, creates superadmin if missing |
| `src/lib/appOrigin.ts` | Derives the public URL from `APP_ORIGIN` **or** Railway's `RAILWAY_PUBLIC_DOMAIN` |
| `src/lib/storagePaths.ts` | Puts uploads/backups/logs under `DATA_DIR` (a Railway Volume) |
| `server.mjs` | Graceful `SIGTERM` shutdown, `DATA_DIR`-aware uploads, immutable caching for uploads |

The app is a **single long-running Node process** (custom server + WebSockets),
so it runs as a normal Railway service — no serverless adaptation needed.

---

## 1. Database — MongoDB as a replica set

Prisma's MongoDB connector **requires a replica set**. Pick one:

### Option A — MongoDB Atlas (recommended, free tier is fine)

1. Create a cluster at <https://cloud.mongodb.com> (M0 free tier is enough to start).
2. *Database Access* → add a user with read/write.
3. *Network Access* → add `0.0.0.0/0` (Railway egress IPs are dynamic).
4. *Connect → Drivers* → copy the URI and add a database name:

   ```
   mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/simurgh?retryWrites=true&w=majority
   ```

### Option B — MongoDB inside Railway

Deploy the official **MongoDB Replica Set** template from the Railway template
marketplace into the *same project* as the app (so you can use the private
network). Use the connection string it exposes as `DATABASE_URL`.

> The single-node "MongoDB" plugin in Railway is **not** a replica set and will
> fail with Prisma. Use the replica-set template or Atlas.

---

## 2. Push the code to GitHub

```bash
cd Simurgh_Chat
git init                      # already done if you see a .git folder
git add -A
git commit -m "Railway-ready"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

(Alternatively use the CLI: `npm i -g @railway/cli && railway login && railway init && railway up`.)

---

## 3. Create the Railway service

1. Railway dashboard → **New Project → Deploy from GitHub repo** → pick the repo.
2. Railway detects the `Dockerfile` automatically (the `railway.json` pins it).
3. The first build will start and **fail health checks** until variables are set — that's expected. Continue.

---

## 4. Add a Volume (persistent uploads / backups / logs)

1. Right-click the project canvas → **Create Volume** → attach to the service.
2. Mount path: **`/data`**

Without this, uploaded images/files vanish on every redeploy.

---

## 5. Set environment variables

Service → **Variables** → *Raw Editor* and paste (edit values):

```env
DATABASE_URL=mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/simurgh?retryWrites=true&w=majority
JWT_SECRET=<openssl rand -hex 32>
BACKUP_SIGNING_KEY=<openssl rand -hex 32>
DATA_DIR=/data
UPLOAD_MAX_SIZE_MB=20

# first-boot superadmin (only applied if none exists)
SUPERADMIN_USERNAME=admin
SUPERADMIN_PASSWORD=<at least 8 chars>

# optional
SENTRY_DSN=
NEXT_PUBLIC_WEBRTC_TURN_URLS=
NEXT_PUBLIC_WEBRTC_TURN_USERNAME=
NEXT_PUBLIC_WEBRTC_TURN_CREDENTIAL=
```

Notes:

- **`PORT`** — do not set; Railway injects it.
- **`APP_ORIGIN`** — leave unset at first. It is derived from Railway's
  `RAILWAY_PUBLIC_DOMAIN`. Once you attach a custom domain, set
  `APP_ORIGIN=https://your.domain` explicitly.
- **`NEXT_PUBLIC_*`** vars are compiled into the browser bundle at **build time**.
  Set them before the build, and trigger a redeploy after changing them.
- If you omit `SUPERADMIN_PASSWORD`, a random one is generated and printed
  **once** in the deploy logs.

---

## 6. Generate a public domain

Service → **Settings → Networking → Generate Domain**. Railway gives you
`https://<name>.up.railway.app`. WebSockets (Socket.IO) work out of the box on
Railway's edge — no extra config.

---

## 7. Deploy & verify

Redeploy (Deployments → ⋯ → Redeploy) after saving variables. Watch the logs:

```
{"scope":"bootstrap","message":"data directories ready", ...}
{"scope":"bootstrap","message":"prisma schema synced"}
{"scope":"bootstrap","message":"superadmin created","context":{"username":"admin"}}
{"message":"server.started", ...}
```

Then check:

- `https://<domain>/api/health` → `{"status":"ok"}`
- `https://<domain>/api/ready`  → `{"status":"ready", ...}` (200). If 503, the
  `checks` object tells you exactly what is wrong (env, database, dirs).
- `https://<domain>/login` → sign in with the superadmin → `/admin` opens.

**Change the superadmin password** right away (Admin → Superadmin Profile).

---

## 8. Custom domain (optional)

Settings → Networking → **Custom Domain** → add the CNAME Railway shows.
Then set `APP_ORIGIN=https://your.domain` and redeploy.

---

## Voice calls (WebRTC)

Signaling goes over Socket.IO and works immediately. Media is peer-to-peer; for
users behind strict NATs you need a TURN server. Options:

- Any hosted TURN provider (e.g. Metered, Twilio) — put the credentials in the
  `NEXT_PUBLIC_WEBRTC_TURN_*` variables and redeploy.
- Self-host `coturn` on a VPS (Railway does not expose UDP ports).

---

## Operations cheatsheet

| Task | How |
| --- | --- |
| View logs | Service → Deployments → click deployment → Logs |
| Shell into container | `railway ssh` (CLI) |
| Browse volume files | `railway volume browse /` |
| Re-run schema sync manually | `railway run node scripts/bootstrap.mjs` |
| Reset superadmin | Admin panel → Superadmin Profile, or delete the user in Atlas and redeploy (bootstrap recreates it) |
| Rotate `JWT_SECRET` | Change the variable → redeploy (logs everyone out) |
| Backups | Admin → Backup uses `mongodump` (bundled in the image) and writes to `/data/backups`. Also enable Railway's own **Volume Backups** and Atlas snapshots. |

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `prisma db push` fails: *"Transactions are not supported by this deployment"* / *"replica set"* | Your MongoDB is a standalone node. Use Atlas or the replica-set template. |
| `Server selection timeout` | Atlas Network Access is missing `0.0.0.0/0`, or wrong password / URI. |
| Health check fails, logs show `missing required environment variables` | Set `DATABASE_URL` and `JWT_SECRET`. |
| Login works but every POST returns **403 Forbidden (CSRF)** | `APP_ORIGIN` doesn't match the URL in the browser. Unset it (auto-detect) or set it to the exact `https://` origin with no trailing slash. |
| Uploads disappear after redeploy | Volume not mounted at `/data`, or `DATA_DIR` not set. |
| `EACCES` writing to `/data` | Volumes are mounted as root. The image runs as root by default; if you switched to `USER node`, set `RAILWAY_RUN_UID=0` on the service. |
| Voice call connects but no audio | Add TURN credentials (`NEXT_PUBLIC_WEBRTC_TURN_*`) and redeploy. |
| Build OOM | Settings → increase build resources, or reduce `--max-old-space-size` in the Dockerfile. |

---

## Local Docker test (optional)

```bash
docker build -t simurgh-chat .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL='mongodb+srv://...' \
  -e JWT_SECRET=dev-secret-please-change \
  -e BACKUP_SIGNING_KEY=dev-key \
  -e SUPERADMIN_PASSWORD=admin12345 \
  -v simurgh-data:/data \
  simurgh-chat
```
