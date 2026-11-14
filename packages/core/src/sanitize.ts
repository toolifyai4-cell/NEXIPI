export const SENSITIVE_KEYS = [
  'apiKey',
  'api_key',
  'token',
  'secret',
  'password',
  'auth',
  'credential',
  'accessToken',
  'refreshToken',
  'apikey',
  'clientSecret',
  'client_secret',
  'privateKey',
  'private_key',
  'authorization',
  'bearer',
] as const;

export type SensitiveKey = (typeof SENSITIVE_KEYS)[number];

function isSensitiveKey(key: string): boolean {
  const lowerKey = key.toLowerCase();
  return SENSITIVE_KEYS.some(s => lowerKey.includes(s.toLowerCase()));
}

export function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return '[CIRCULAR]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map(v => sanitize(v, seen));
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      sanitized[key] = '[REDACTED]';
    } else {
      sanitized[key] = sanitize(val, seen);
    }
  }
  return sanitized;
}

export function sanitizeErrorContext(
  context?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!context) {
    return undefined;
  }
  return sanitize(context) as Record<string, unknown>;
}

export function createSanitizedContext(
  context?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!context) {
    return undefined;
  }
  return sanitize(context) as Record<string, unknown>;
}
