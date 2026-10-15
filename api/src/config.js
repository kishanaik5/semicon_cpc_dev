// Automatically load root or local .env if running directly with node
try {
  if (typeof process.loadEnvFile === 'function') {
    // Try current directory then parent directory
    try { process.loadEnvFile(); } catch { process.loadEnvFile('../.env'); }
  }
} catch {
  // If .env is missing or already passed by docker/system, proceed smoothly
}

export const config = {
  port: Number(process.env.PORT || 4100),
  databaseUrl:
    process.env.DATABASE_URL ||
    process.env.DB_NAME ||
    'postgres://semicon:semicon@localhost:5434/semicon_coupons',
  adminApiKey: process.env.ADMIN_API_KEY || 'semicon-admin-dev-key',
  offerMode: process.env.OFFER_MODE || 'flexible', // 'strict' | 'flexible'
  // Brute-force protection
  maxFailedAttemptsPerIp: Number(process.env.MAX_FAILED_ATTEMPTS_PER_IP || 15),
  maxFailedAttemptsPerUser: Number(process.env.MAX_FAILED_ATTEMPTS_PER_USER || 10),
  attemptWindowMinutes: Number(process.env.ATTEMPT_WINDOW_MINUTES || 15),
  maxPinAttempts: Number(process.env.MAX_PIN_ATTEMPTS || 5),
  pinLockMinutes: Number(process.env.PIN_LOCK_MINUTES || 15),
  expiryJobIntervalMs: Number(process.env.EXPIRY_JOB_INTERVAL_MS || 60_000),
  seedDemoData: (process.env.SEED_DEMO_DATA || 'true') === 'true',
};

