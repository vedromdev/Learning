import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { prisma } from '@/lib/prisma';
import { getBackupDir, getUploadDir } from '@/lib/storagePaths';
import { getAppOrigin } from '@/lib/appOrigin';

export const dynamic = 'force-dynamic';

export async function GET() {
  const checks: Record<string, { ok: boolean; detail?: string }> = {
    env: { ok: true },
    database: { ok: true },
    uploadsDir: { ok: true },
    backupDir: { ok: true },
  };

  const requiredEnvs = ['JWT_SECRET', 'BACKUP_SIGNING_KEY', 'DATABASE_URL'];
  const missing = requiredEnvs.filter((key) => !process.env[key]);
  // APP_ORIGIN may be derived from RAILWAY_PUBLIC_DOMAIN
  if (!process.env.APP_ORIGIN && !process.env.RAILWAY_PUBLIC_DOMAIN && !process.env.RAILWAY_STATIC_URL) {
    missing.push('APP_ORIGIN');
  }
  if (missing.length > 0) {
    checks.env = { ok: false, detail: `Missing env vars: ${missing.join(', ')}` };
  }

  try {
    await prisma.$runCommandRaw({ ping: 1 });
  } catch (error) {
    checks.database = { ok: false, detail: String(error) };
  }

  const uploadsDir = getUploadDir();
  const backupDir = getBackupDir();

  try {
    await fs.mkdir(uploadsDir, { recursive: true });
    await fs.access(uploadsDir, fs.constants.W_OK);
  } catch (error) {
    checks.uploadsDir = { ok: false, detail: String(error) };
  }

  try {
    await fs.mkdir(backupDir, { recursive: true });
    await fs.access(backupDir, fs.constants.W_OK);
  } catch (error) {
    checks.backupDir = { ok: false, detail: String(error) };
  }

  const allOk = Object.values(checks).every((c) => c.ok);
  return NextResponse.json(
    {
      status: allOk ? 'ready' : 'not-ready',
      origin: getAppOrigin(),
      timestamp: new Date().toISOString(),
      checks,
    },
    { status: allOk ? 200 : 503 }
  );
}
