#!/usr/bin/env node
/**
 * Simurgh Chat — deployment bootstrap.
 *
 * Runs before the server starts (see Dockerfile CMD / railway.json):
 *   1. Validate required environment variables
 *   2. Ensure data directories exist (uploads / backups / logs)
 *   3. Sync the Prisma schema to MongoDB (indexes, unique constraints)
 *   4. Create the superadmin account if no superadmin exists yet
 *
 * Safe to run on every boot — every step is idempotent.
 *
 * Env:
 *   DATABASE_URL          required
 *   JWT_SECRET            required
 *   BACKUP_SIGNING_KEY    recommended (admin backups fail without it)
 *   DATA_DIR              default /data  (Railway volume mount path)
 *   SUPERADMIN_USERNAME   default "admin"
 *   SUPERADMIN_PASSWORD   if omitted a random password is generated and
 *                         printed ONCE to the deploy logs
 *   SUPERADMIN_DISPLAY_NAME default "Super Admin"
 *   SKIP_DB_PUSH=1        skip `prisma db push`
 *   SKIP_BOOTSTRAP=1      skip the whole script
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function log(level, message, context) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    scope: "bootstrap",
    message,
    ...(context ? { context } : {}),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

if (process.env.SKIP_BOOTSTRAP === "1") {
  log("info", "skipped", { reason: "SKIP_BOOTSTRAP=1" });
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1. Environment validation
// ---------------------------------------------------------------------------
const missing = ["DATABASE_URL", "JWT_SECRET"].filter(
  (key) => !process.env[key] || !process.env[key].trim(),
);
if (missing.length) {
  log("error", "missing required environment variables", { missing });
  console.error(
    `\nSet these in Railway → your service → Variables:\n  ${missing.join(
      "\n  ",
    )}\n`,
  );
  process.exit(1);
}
if (!process.env.BACKUP_SIGNING_KEY) {
  log("warn", "BACKUP_SIGNING_KEY is not set; admin backups will be disabled");
}
if (
  !process.env.APP_ORIGIN &&
  !process.env.RAILWAY_PUBLIC_DOMAIN &&
  !process.env.RAILWAY_STATIC_URL
) {
  log(
    "warn",
    "APP_ORIGIN is not set and no Railway domain detected; CSRF checks will use the request origin",
  );
}

const dbUrl = process.env.DATABASE_URL.trim();
if (!/^mongodb(\+srv)?:\/\//.test(dbUrl)) {
  log("error", "DATABASE_URL must start with mongodb:// or mongodb+srv://");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Data directories
// ---------------------------------------------------------------------------
function resolveDir(explicit, subdir, legacy) {
  if (explicit && explicit.trim()) return path.resolve(process.cwd(), explicit.trim());
  const dataDir = process.env.DATA_DIR && process.env.DATA_DIR.trim();
  if (dataDir) return path.resolve(process.cwd(), dataDir, subdir);
  return path.resolve(process.cwd(), legacy);
}
const dirs = {
  uploads: resolveDir(process.env.UPLOAD_DIR, "uploads", "./uploads"),
  backups: resolveDir(process.env.BACKUP_DIR, "backups", "./backups"),
  logs: resolveDir(process.env.AUDIT_LOG_DIR, "logs", "./logs"),
};
for (const [name, dir] of Object.entries(dirs)) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (error) {
    log("warn", `data directory not writable: ${name}`, {
      dir,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
log("info", "data directories ready", dirs);

// ---------------------------------------------------------------------------
// 3. Prisma schema sync
// ---------------------------------------------------------------------------
if (process.env.SKIP_DB_PUSH === "1") {
  log("info", "prisma db push skipped", { reason: "SKIP_DB_PUSH=1" });
} else {
  let prismaBin;
  try {
    prismaBin = require.resolve("prisma/build/index.js");
  } catch {
    prismaBin = null;
  }
  if (!prismaBin) {
    log("warn", "prisma CLI not found; skipping db push");
  } else {
    const maxAttempts = 5;
    let synced = false;
    for (let attempt = 1; attempt <= maxAttempts && !synced; attempt++) {
      log("info", "prisma db push", { attempt, maxAttempts });
      const result = spawnSync(
        process.execPath,
        [prismaBin, "db", "push", "--skip-generate", "--accept-data-loss"],
        { stdio: "inherit", env: process.env },
      );
      if (result.status === 0) {
        synced = true;
      } else if (attempt < maxAttempts) {
        const waitMs = attempt * 3000;
        log("warn", "prisma db push failed; retrying", { waitMs });
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    if (!synced) {
      log("error", "prisma db push failed after retries — check DATABASE_URL and that MongoDB runs as a replica set");
      process.exit(1);
    }
    log("info", "prisma schema synced");
  }
}

// ---------------------------------------------------------------------------
// 4. Superadmin
// ---------------------------------------------------------------------------
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const prisma = new PrismaClient();

try {
  const existing = await prisma.user.findFirst({
    where: { isSuperAdmin: true },
    select: { id: true, username: true },
  });

  if (existing) {
    log("info", "superadmin exists", { username: existing.username });
  } else {
    const username = (process.env.SUPERADMIN_USERNAME || "admin").trim();
    const displayName = (process.env.SUPERADMIN_DISPLAY_NAME || "Super Admin").trim();
    let password = process.env.SUPERADMIN_PASSWORD;
    let generated = false;
    if (!password || password.length < 8) {
      if (password) {
        log("warn", "SUPERADMIN_PASSWORD shorter than 8 chars; generating a random one instead");
      }
      password = randomBytes(12).toString("base64url");
      generated = true;
    }

    const hashed = await bcrypt.hash(password, 12);

    // Promote an existing user with that username, or create a new one.
    const byName = await prisma.user.findUnique({ where: { username } });
    if (byName) {
      await prisma.user.update({
        where: { id: byName.id },
        data: { isSuperAdmin: true, isBanned: false, password: hashed, displayName },
      });
    } else {
      await prisma.user.create({
        data: { username, displayName, password: hashed, isSuperAdmin: true },
      });
    }

    log("info", "superadmin created", { username });
    if (generated) {
      console.log("\n" + "=".repeat(64));
      console.log("  SUPERADMIN CREDENTIALS (shown once — change after login)");
      console.log(`  username : ${username}`);
      console.log(`  password : ${password}`);
      console.log("=".repeat(64) + "\n");
    }
  }

  // Ensure the singleton Settings row exists so the admin panel works.
  await prisma.settings.upsert({
    where: { id: "default" },
    update: {},
    create: { id: "default", registrationEnabled: true },
  });
} catch (error) {
  log("error", "bootstrap database step failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
}

await prisma.$disconnect();
log("info", "bootstrap complete");
