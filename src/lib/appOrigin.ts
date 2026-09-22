/**
 * Resolves the public origin of the app.
 *
 * Priority:
 *   1. APP_ORIGIN                    (explicit, e.g. https://chat.example.com)
 *   2. RAILWAY_PUBLIC_DOMAIN         (auto-injected by Railway)
 *   3. RAILWAY_STATIC_URL            (legacy Railway variable)
 *   4. fallback                      (request origin / localhost)
 *
 * Always returns a value without a trailing slash.
 */
export function getAppOrigin(fallback?: string): string {
  const explicit = process.env.APP_ORIGIN?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const railwayDomain =
    process.env.RAILWAY_PUBLIC_DOMAIN?.trim() || process.env.RAILWAY_STATIC_URL?.trim();
  if (railwayDomain) {
    const withScheme = /^https?:\/\//i.test(railwayDomain) ? railwayDomain : `https://${railwayDomain}`;
    return withScheme.replace(/\/+$/, '');
  }

  if (fallback) return fallback.replace(/\/+$/, '');

  const port = process.env.PORT || '3000';
  return `http://localhost:${port}`;
}

/** True when the resolved origin is served over HTTPS (used for `secure` cookies). */
export function isSecureOrigin(fallback?: string): boolean {
  return getAppOrigin(fallback).startsWith('https://');
}
