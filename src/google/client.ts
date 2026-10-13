import type {
  FlightSearchFilters,
  FlightResult,
  FlightCombo,
  SearchResult,
  SearchMetadata,
} from "./types.js";
import { TripType } from "./types.js";
import { buildRequestBody } from "./request-builder.js";
import { parseFlightsResponse, isTransientGoogleError } from "./response-parser.js";
import { ok, err, type Result, flatMap } from "../lib/result.js";
import { pipe } from "../lib/pipe.js";
import { logger, startTimer } from "../lib/logger.js";
import { createCircuitBreaker } from "../lib/retry.js";
import { httpPost, delay, googleRetryDelayMs, timeLeft, isTimeLimitError, TIME_LIMIT_ERROR, type Deadline } from "../lib/http.js";
import { config } from "../lib/config.js";
import { createCache, get as cacheGet, set as cacheSet, buildCacheKey } from "../lib/cache.js";

const FLIGHTS_URL =
  "https://www.google.com/_/FlightsFrontendUi/data/travel.frontend.flights.FlightsFrontendService/GetShoppingResults";

type FetchResult = {
  readonly flights: readonly FlightResult[];
  readonly metadata: SearchMetadata;
};

const flightsCache = createCache<FetchResult>();
const circuitBreaker = createCircuitBreaker();

// Don't start (or wait for) another attempt with less time than this left.
const MIN_ATTEMPT_MS = 2_000;

// One attempt, cut off after config.retry.requestTimeoutMs (or the overall deadline, if sooner).
const fetchOnce = async (filters: FlightSearchFilters, deadline: Deadline): Promise<Result<FetchResult>> => {
  const body = buildRequestBody(filters);
  const attemptDeadline = Math.min(
    deadline ?? Number.POSITIVE_INFINITY,
    Date.now() + config.retry.requestTimeoutMs
  );
  const textResult = await httpPost(
    FLIGHTS_URL,
    body,
    "application/x-www-form-urlencoded;charset=UTF-8",
    attemptDeadline
  );
  return pipe(textResult, flatMap(parseFlightsResponse));
};

// Google answers a large share of direct requests with a transient RPC error
// (HTTP 200 + ErrorResponse code 13), and occasionally lets a request hang for
// over a minute. Both are retried: re-send the identical request after a short
// pause, as long as the overall deadline leaves room for another attempt.
const fetchWithGoogleRetry = async (
  filters: FlightSearchFilters,
  deadline: Deadline,
  attempt: number = 0
): Promise<Result<FetchResult>> => {
  const result = await fetchOnce(filters, deadline);
  if (result.tag === "ok") return result;
  const slowAttempt = isTimeLimitError(result.error) && timeLeft(deadline) > MIN_ATTEMPT_MS;
  if (
    !(isTransientGoogleError(result.error) || slowAttempt) ||
    attempt >= config.retry.maxGoogleErrorRetries
  ) {
    return result;
  }
  if (slowAttempt) logger.info("slow_request_retry", { attempt: attempt + 1, timeoutMs: config.retry.requestTimeoutMs });
  const waitMs = googleRetryDelayMs();
  if (timeLeft(deadline) < waitMs + MIN_ATTEMPT_MS) {
    return err(`${TIME_LIMIT_ERROR} while retrying after: ${result.error}`);
  }
  logger.debug("google_error_retry", { attempt: attempt + 1, error: result.error });
  await delay(waitMs);
  return fetchWithGoogleRetry(filters, deadline, attempt + 1);
};

// Searches that are still running, keyed like the cache. A tool call that runs
// out of time leaves its search running here; when it finishes, the result is
// cached, so asking again shortly afterwards answers instantly. Identical
// concurrent searches share one request.
/* eslint-disable functional/immutable-data -- mutation confined to this registry */
const inflight = new Map<string, Promise<Result<FetchResult>>>();

export const STILL_RUNNING_NOTE =
  "still searching in the background; Google can take over a minute to compute long-haul searches. " +
  "Run the same search again in about a minute and it will answer from cache.";

const startSearch = (filters: FlightSearchFilters, cacheKey: string): Promise<Result<FetchResult>> => {
  const existing = inflight.get(cacheKey);
  if (existing) return existing;

  const elapsed = startTimer();
  const backgroundDeadline = Date.now() + config.search.backgroundMs;
  const search = circuitBreaker
    .execute(() => fetchWithGoogleRetry(filters, backgroundDeadline))
    .then((result) => {
      inflight.delete(cacheKey);
      if (result.tag === "ok") {
        cacheSet(flightsCache, cacheKey, result.value);
        logger.info("search_complete", {
          origin: filters.segments[0]?.departureAirport,
          destination: filters.segments[0]?.arrivalAirport,
          results: result.value.flights.length,
          durationMs: elapsed(),
        });
      } else {
        logger.error("search_failed", {
          origin: filters.segments[0]?.departureAirport,
          destination: filters.segments[0]?.arrivalAirport,
          error: result.error,
          durationMs: elapsed(),
        });
      }
      return result;
    });
  inflight.set(cacheKey, search);
  return search;
};
/* eslint-enable functional/immutable-data */

// Returns the cached result, or waits for the (possibly shared) search until
// the caller's deadline. Past the deadline the search keeps running.
export const fetchFlights = async (
  filters: FlightSearchFilters,
  deadline?: Deadline
): Promise<Result<FetchResult>> => {
  const cacheKey = buildCacheKey(filters);
  const cached = cacheGet(flightsCache, cacheKey);
  if (cached) {
    logger.debug("cache_hit", { key: cacheKey.slice(0, 60) });
    return ok(cached);
  }

  const search = startSearch(filters, cacheKey);
  const remaining = timeLeft(deadline);
  if (!Number.isFinite(remaining)) return search;

  const timedOut: Promise<Result<FetchResult>> = delay(Math.max(0, remaining)).then(() =>
    err(`${TIME_LIMIT_ERROR}: ${STILL_RUNNING_NOTE}`)
  );
  const result = await Promise.race([search, timedOut]);
  if (result.tag === "err" && isTimeLimitError(result.error)) {
    logger.info("search_continues_in_background", {
      origin: filters.segments[0]?.departureAirport,
      destination: filters.segments[0]?.arrivalAirport,
    });
  }
  return result;
};

const countSelected = (filters: FlightSearchFilters): number =>
  filters.segments.filter((s) => s.selectedFlight !== undefined).length;

const withSelectedFlight = (
  filters: FlightSearchFilters,
  segmentIndex: number,
  flight: FlightResult
): FlightSearchFilters => ({
  ...filters,
  segments: filters.segments.map((seg, i) =>
    i === segmentIndex ? { ...seg, selectedFlight: flight } : seg
  ),
});

const prependToCombos = (
  selected: FlightResult,
  next: SearchResult
): readonly FlightCombo[] =>
  next.tag === "flights"
    ? next.flights.map((flight) => [selected, flight])
    : next.combos.map((combo) => [selected, ...combo]);

type ComboAccumulator = {
  readonly combos: readonly FlightCombo[];
  readonly lastError: string | null;
};

// Builds round-trip / multi-city itineraries: fetch the options for the first
// unselected leg, then — one candidate at a time, while the deadline allows —
// select each of the top N and fetch what can follow it. Requests are made
// sequentially because Google rejects bursts of parallel requests far more often.
//
// If no complete itinerary could be assembled (time limit, Google errors), the
// options for this leg are returned with `partialReason` set: for the first leg
// of a round trip their prices are already the cheapest TOTAL trip fare.
const assembleMultiLeg = async (
  filters: FlightSearchFilters,
  topN: number,
  deadline: Deadline
): Promise<Result<SearchResult>> => {
  const fetchResult = await fetchFlights(filters, deadline);
  if (fetchResult.tag === "err") return fetchResult;

  const { flights, metadata } = fetchResult.value;
  if (flights.length === 0) return err("No flights found");

  const selectedCount = countSelected(filters);
  const numSegments = filters.segments.length;

  if (selectedCount >= numSegments - 1) {
    return ok({ tag: "flights" as const, flights, metadata });
  }

  const assembled = await flights.slice(0, topN).reduce<Promise<ComboAccumulator>>(
    async (accP, selected) => {
      const acc = await accP;
      // Start the next lookup while any time is left: even if it can't finish
      // in time, it keeps running in the background and warms the cache.
      if (timeLeft(deadline) <= 0) {
        return { ...acc, lastError: acc.lastError ?? `${TIME_LIMIT_ERROR}: ${STILL_RUNNING_NOTE}` };
      }
      const nextFilters = withSelectedFlight(filters, selectedCount, selected);
      const nextResult = await assembleMultiLeg(nextFilters, topN, deadline);
      if (nextResult.tag === "err") return { ...acc, lastError: nextResult.error };
      if (nextResult.value.tag === "flights" && nextResult.value.partialReason) {
        return { ...acc, lastError: nextResult.value.partialReason };
      }
      return { ...acc, combos: [...acc.combos, ...prependToCombos(selected, nextResult.value)] };
    },
    Promise.resolve({ combos: [], lastError: null })
  );

  if (assembled.combos.length > 0) {
    return ok({ tag: "combos" as const, combos: assembled.combos, metadata });
  }

  logger.warn("multi_leg_partial", { reason: assembled.lastError });
  return ok({
    tag: "flights" as const,
    flights,
    metadata,
    partialReason: assembled.lastError ?? "No flight combinations found",
  });
};

export const searchFlights = async (
  filters: FlightSearchFilters,
  topN: number = 5,
  deadlineMs: number = config.search.deadlineMs
): Promise<Result<SearchResult>> => {
  const deadline = Date.now() + deadlineMs;

  if (filters.tripType === TripType.ONE_WAY) {
    const result = await fetchFlights(filters, deadline);
    if (result.tag === "err") return result;
    return result.value.flights.length > 0
      ? ok({ tag: "flights" as const, flights: result.value.flights, metadata: result.value.metadata })
      : err("No flights found");
  }

  return assembleMultiLeg(filters, topN, deadline);
};
