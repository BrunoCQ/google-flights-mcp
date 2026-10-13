// HTTP client with retry, browser-like TLS fingerprinting mitigation, and undici+fetch fallback.
//
// RISK: Google Flights has no official API. We hit their internal endpoint
// which may block requests that don't look like a real browser. The `fli`
// Python library uses curl_cffi with Chrome impersonation for this reason.
//
// MITIGATION STRATEGY:
// 1. Use undici with HTTP/1.1 (avoids some TLS fingerprint checks)
// 2. Rotate realistic User-Agent strings
// 3. Include plausible browser headers (Accept-Language, etc.)
// 4. If undici fails, fall back to Node.js built-in fetch
// 5. Retry on 429/5xx with exponential backoff + jitter
//
// If Google tightens enforcement, the fallback options are:
// - Use a headless browser (playwright) for the actual requests
// - Switch to SerpAPI as a paid alternative
// - Use a proxy service that handles TLS fingerprinting

import { request } from "undici";
import { ok, err, type Result } from "./result.js";
import { logger, startTimer } from "./logger.js";
import { config } from "./config.js";

const USER_AGENTS: readonly string[] = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
];

const pickUserAgent = (): string =>
  USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

const BROWSER_HEADERS: Readonly<Record<string, string>> = {
  "Accept": "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "Origin": "https://www.google.com",
  "Referer": "https://www.google.com/travel/flights",
};

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

const computeDelay = (attempt: number): number =>
  Math.min(
    config.retry.baseDelayMs * Math.pow(2, attempt) + Math.random() * config.retry.baseDelayMs,
    config.retry.maxDelayMs
  );

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Spacing for retries after a Google RPC rejection. Rejections come back in
// ~100ms and requests sent in quick succession are rejected far more often,
// so wait a flat 1.5-3s (with jitter) rather than starting with a short backoff.
export const googleRetryDelayMs = (): number =>
  config.retry.googleRetryMinDelayMs + Math.random() * config.retry.googleRetryMinDelayMs;

// --- Deadlines ---
// A deadline is an absolute epoch-ms time after which a search must stop.
// MCP clients cancel tool calls after a fixed time (often 60s), so long
// searches must finish — or return what they have — before that.
export type Deadline = number | undefined;

export const TIME_LIMIT_ERROR = "Search time limit reached";

export const timeLeft = (deadline: Deadline): number =>
  deadline === undefined ? Number.POSITIVE_INFINITY : deadline - Date.now();

export const isTimeLimitError = (error: string): boolean => error.startsWith(TIME_LIMIT_ERROR);

const deadlineSignal = (deadline: Deadline): AbortSignal | undefined =>
  deadline === undefined ? undefined : AbortSignal.timeout(Math.max(1, Math.floor(timeLeft(deadline))));

// Parse a Retry-After header value. The header may be either:
//   - a non-negative integer number of seconds
//   - an HTTP-date (RFC 7231)
// Returns ms, or null if the header is missing/unparseable.
const parseRetryAfter = (raw: string | string[] | null | undefined): number | null => {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
};

// Single-attempt POST via undici with fetch fallback. The request is aborted
// when the deadline passes.
const postOnce = async (
  url: string,
  body: string,
  headers: Record<string, string>,
  deadline: Deadline
): Promise<{ readonly status: number; readonly text: string; readonly retryAfterMs: number | null }> => {
  try {
    const { statusCode, headers: responseHeaders, body: responseBody } = await request(url, {
      method: "POST",
      headers,
      body,
      signal: deadlineSignal(deadline),
    });
    return {
      status: statusCode,
      text: await responseBody.text(),
      retryAfterMs: parseRetryAfter(responseHeaders["retry-after"]),
    };
  } catch (undiciErr) {
    if (timeLeft(deadline) <= 0) throw undiciErr;
    logger.warn("undici_failed_fallback_to_fetch", {
      error: undiciErr instanceof Error ? undiciErr.message : String(undiciErr),
    });
    const response = await fetch(url, { method: "POST", headers, body, signal: deadlineSignal(deadline) });
    return {
      status: response.status,
      text: await response.text(),
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
    };
  }
};

// Recursive retry with exponential backoff (or Retry-After when provided).
// Never waits or retries past the deadline.
const postWithRetry = async (
  url: string,
  body: string,
  headers: Record<string, string>,
  attempt: number,
  deadline: Deadline
): Promise<Result<string>> => {
  if (timeLeft(deadline) <= 0) return err(TIME_LIMIT_ERROR);
  try {
    const { status, text, retryAfterMs } = await postOnce(url, body, headers, deadline);

    if (status >= 200 && status < 300) return ok(text);

    const waitMs = retryAfterMs !== null
      ? Math.min(retryAfterMs, config.retry.maxDelayMs)
      : computeDelay(attempt);
    if (attempt < config.retry.maxRetries && RETRYABLE_STATUSES.has(status) && timeLeft(deadline) > waitMs) {
      logger.warn("http_retry", {
        status,
        attempt: attempt + 1,
        retryInMs: Math.round(waitMs),
        honoredRetryAfter: retryAfterMs !== null,
      });
      await delay(waitMs);
      return postWithRetry(url, body, headers, attempt + 1, deadline);
    }

    return err(`HTTP ${status}`);
  } catch (e) {
    if (timeLeft(deadline) <= 0) return err(TIME_LIMIT_ERROR);
    const waitMs = computeDelay(attempt);
    if (attempt < config.retry.maxRetries && timeLeft(deadline) > waitMs) {
      logger.warn("http_network_retry", {
        error: e instanceof Error ? e.message : String(e),
        attempt: attempt + 1,
        retryInMs: Math.round(waitMs),
      });
      await delay(waitMs);
      return postWithRetry(url, body, headers, attempt + 1, deadline);
    }
    return err(e instanceof Error ? e.message : String(e));
  }
};

export const httpPost = async (
  url: string,
  body: string,
  contentType: string,
  deadline?: Deadline
): Promise<Result<string>> => {
  const headers = {
    ...BROWSER_HEADERS,
    "Content-Type": contentType,
    "User-Agent": pickUserAgent(),
  };
  const elapsed = startTimer();
  const result = await postWithRetry(url, body, headers, 0, deadline);
  if (result.tag === "ok") {
    logger.debug("http_post_success", { url: url.split("?")[0], durationMs: elapsed() });
  }
  return result;
};
