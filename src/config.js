import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/** Load KEY=VALUE lines from .env without overriding real environment variables. */
function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return 'localhost';
}

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const int = (v, d) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export function loadConfig(overrides = {}) {
  loadDotEnv(path.resolve(process.cwd(), '.env'));
  const env = { ...process.env, ...overrides };
  const production = env.NODE_ENV === 'production';
  const port = int(env.PORT, 4000);

  let secretKey = env.SECRET_KEY || '';
  let generatedSecret = false;
  if (!secretKey) {
    if (production) throw new Error('SECRET_KEY is required when NODE_ENV=production');
    secretKey = 'sk_dev_' + randomBytes(18).toString('base64url');
    generatedSecret = true;
  }

  const allowedOrigins = list(env.ALLOWED_ORIGINS || '*');
  if (production && allowedOrigins.includes('*')) {
    throw new Error('ALLOWED_ORIGINS must list your site origins when NODE_ENV=production');
  }

  return {
    production,
    port,
    host: env.HOST || '0.0.0.0',
    publicUrl: (env.PUBLIC_URL || `http://${lanAddress()}:${port}`).replace(/\/+$/, ''),
    secretKey,
    generatedSecret,
    allowedOrigins,
    allowedTypes: list(env.ALLOWED_TYPES || 'image/jpeg,image/png,image/heic,image/webp,application/pdf'),
    maxFileSize: int(env.MAX_FILE_SIZE_MB, 10) * 1024 * 1024,
    maxFiles: int(env.MAX_FILES, 5),
    dataDir: path.resolve(env.DATA_DIR || './data'),
    fileTtlMs: int(env.FILE_TTL_HOURS, 24) * 3600_000,
    sessionTtlMs: int(env.SESSION_TTL_MINUTES, 30) * 60_000,
    pairTtlMs: 5 * 60_000,
    demo: String(env.DEMO ?? (production ? 'false' : 'true')) !== 'false',
  };
}
