// Centralized configuration. All tunable values in one place.
// Override any value via environment variables prefixed with GF_MCP_.

const envInt = (key: string, fallback: number): number => {
  const val = process.env[`GF_MCP_${key}`];
  return val !== undefined ? parseInt(val, 10) : fallback;
};

const envString = (key: string, fallback: string): string =>
  process.env[`GF_MCP_${key}`] ?? fallback;

export const config = {
  // Cache
  cache: {
    ttlMs: envInt("CACHE_TTL_MS", 5 * 60 * 1000), // 5 minutes
    maxEntries: envInt("CACHE_MAX_ENTRIES", 100),
  },

  // HTTP retry
  retry: {
    maxRetries: envInt("RETRY_MAX", 2),
    baseDelayMs: envInt("RETRY_BASE_DELAY_MS", 500),
    maxDelayMs: envInt("RETRY_MAX_DELAY_MS", 5000),
    // Google intermittently rejects ~half of direct requests with an RPC error (code 13),
    // answered in ~100ms; rejections look random, so an identical retry usually succeeds.
    maxGoogleErrorRetries: envInt("GOOGLE_ERROR_RETRY_MAX", 10),
    googleRetryMinDelayMs: envInt("GOOGLE_ERROR_RETRY_DELAY_MS", 1500),
    // Abandon a single request that hangs longer than this and send it again.
    // Most Google responses take 2-10s, but uncached long-haul searches can
    // legitimately take 30-90s (and a re-sent request is not faster), so this
    // only guards against requests that never complete.
    requestTimeoutMs: envInt("REQUEST_TIMEOUT_MS", 120_000),
  },

  // Circuit breaker
  circuitBreaker: {
    failureThreshold: envInt("CB_FAILURE_THRESHOLD", 5),
    resetTimeoutMs: envInt("CB_RESET_TIMEOUT_MS", 30_000),
  },

  // Search defaults
  search: {
    // Hard time budget for one search tool call, including retries and the
    // follow-up requests a round trip needs. MCP clients typically cancel a
    // tool call after ~60s; when the budget runs out, a round-trip search
    // returns the outbound options it already has instead of nothing.
    deadlineMs: envInt("SEARCH_DEADLINE_MS", 45_000),
    // How long a search may keep running after the tool call has returned.
    // Its result is cached, so the same search a little later answers instantly.
    backgroundMs: envInt("SEARCH_BACKGROUND_MS", 180_000),
    defaultMaxResults: envInt("DEFAULT_MAX_RESULTS", 5),
    defaultCabinClass: envString("DEFAULT_CABIN_CLASS", "economy"),
    priceInsightsMaxDays: envInt("PRICE_INSIGHTS_MAX_DAYS", 30),
    priceInsightsBatchDelay: envInt("PRICE_INSIGHTS_BATCH_DELAY_MS", 500),
  },

  // Nearby airports
  airports: {
    defaultRadiusKm: envInt("AIRPORT_RADIUS_KM", 200),
    maxResults: envInt("AIRPORT_MAX_RESULTS", 10),
  },

  // Price tracker
  priceTracker: {
    dbDir: envString("PRICE_DB_DIR", ""),  // empty = default ~/.google-flights-mcp
  },

  // Logging
  logging: {
    level: envString("LOG_LEVEL", "info") as "debug" | "info" | "warn" | "error",
  },
} as const;
