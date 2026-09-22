import path from 'path';

/**
 * Resolves on-disk storage directories.
 *
 * On Railway a single Volume is mounted (default: /data) and exposed as
 * DATA_DIR. Uploads, backups and audit logs live under it so they survive
 * redeploys. Explicit UPLOAD_DIR / BACKUP_DIR / AUDIT_LOG_DIR still win.
 *
 * Locally (no DATA_DIR) everything defaults to ./uploads, ./backups, ./logs
 * relative to the project root, exactly like before.
 */
function resolveDir(explicit: string | undefined, subdir: string, legacyDefault: string): string {
  if (explicit && explicit.trim()) {
    return path.resolve(process.cwd(), explicit.trim());
  }
  const dataDir = process.env.DATA_DIR?.trim();
  if (dataDir) {
    return path.resolve(process.cwd(), dataDir, subdir);
  }
  return path.resolve(process.cwd(), legacyDefault);
}

export function getUploadDir(): string {
  return resolveDir(process.env.UPLOAD_DIR, 'uploads', './uploads');
}

export function getBackupDir(): string {
  return resolveDir(process.env.BACKUP_DIR, 'backups', './backups');
}

export function getAuditLogDir(): string {
  return resolveDir(process.env.AUDIT_LOG_DIR, 'logs', './logs');
}

/**
 * Absolute path of a sub-folder inside the upload root
 * (e.g. `getUploadSubdir('stickers')` → `<uploads>/stickers`).
 */
export function getUploadSubdir(subdir: string): string {
  return path.join(getUploadDir(), subdir);
}

/**
 * Map a public `/uploads/<relative>` URL (as stored in the DB) back to its
 * absolute on-disk path inside the upload root. Returns null for anything
 * that is not under `/uploads/` or that tries to escape the root.
 */
export function uploadUrlToPath(fileUrl: string | null | undefined): string | null {
  if (!fileUrl) return null;
  const prefix = '/uploads/';
  if (!fileUrl.startsWith(prefix)) return null;
  const root = getUploadDir();
  const relative = decodeURIComponent(fileUrl.slice(prefix.length)).replace(/^[/\\]+/, '');
  if (!relative || relative.includes('\0')) return null;
  const abs = path.resolve(root, relative);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}
