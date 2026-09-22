import path from "path";
import fs from "fs";

const isRailway = process.env.RAILWAY_ENVIRONMENT !== undefined;

export const UPLOAD_ROOT = path.resolve(
  process.cwd(),
  isRailway ? "/app/uploads" : (process.env.UPLOAD_DIR || "uploads"),
);

export const BACKUP_ROOT = path.resolve(
  process.cwd(),
  isRailway ? "/app/backups" : (process.env.BACKUP_DIR || "backups"),
);

export const AUDIT_LOG_ROOT = path.resolve(
  process.cwd(),
  isRailway ? "/app/logs" : (process.env.AUDIT_LOG_DIR || "logs"),
);

[UPLOAD_ROOT, BACKUP_ROOT, AUDIT_LOG_ROOT].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

export function getUploadRoot() {
  return UPLOAD_ROOT;
}

export function getBackupRoot() {
  return BACKUP_ROOT;
}

export function getAuditLogRoot() {
  return AUDIT_LOG_ROOT;
}