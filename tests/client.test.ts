import { describe, it, expect, vi, beforeEach } from "vitest";

// Short retry pauses so the tests run fast (config reads env at import time).
vi.hoisted(() => {
  process.env.GF_MCP_GOOGLE_ERROR_RETRY_DELAY_MS = "5";
  process.env.GF_MCP_CB_FAILURE_THRESHOLD = "1000";
});

vi.mock("../src/lib/http.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/http.js")>("../src/lib/http.js");
  return { ...actual, httpPost: vi.fn() };
});

import { httpPost, TIME_LIMIT_ERROR } from "../src/lib/http.js";
import { searchFlights } from "../src/google/client.js";
import type { FlightSearchFilters } from "../src/google/types.js";

const mockedPost = vi.mocked(httpPost);

const makeFlight = (airline: string, num: string, dep: string, arr: string, price: number, date: [number, number, number]) => {
  const leg = Array(23).fill(null);
  leg[3] = dep;
  leg[6] = arr;
  leg[8] = [10, 0];
  leg[10] = [20, 0];
  leg[11] = 600;
  leg[20] = date;
  leg[21] = date;
  leg[22] = [airline, num];
  return [[null, null, [leg], null, null, null, null, null, null, 600], [[null, price], "token"]];
};

const flightsResponse = (flights: unknown[][]) =>
  ")]}'\n" + JSON.stringify([["wrb.fr", null, JSON.stringify([null, null, [flights], null])]]);

const errorResponse =
  ")]}'\n" +
  JSON.stringify([["wrb.fr", null, null, null, null, [13, null, [["type.googleapis.com/travel.frontend.flights.ErrorResponse", []]]]]]);

const ok = (value: string) => ({ tag: "ok" as const, value });
const err = (error: string) => ({ tag: "err" as const, error });

let counter = 0;
const roundTrip = (): FlightSearchFilters => {
  // unique dates per test so the module-level cache never serves an earlier test's data
  counter += 1;
  const day = String(counter).padStart(2, "0");
  return {
    tripType: 1,
    passengers: { adults: 1, children: 0, infantsOnLap: 0, infantsInSeat: 0 },
    segments: [
      { departureAirport: "GIG", arrivalAirport: "PER", travelDate: `2026-12-${day}` },
      { departureAirport: "PER", arrivalAirport: "GIG", travelDate: `2027-03-${day}` },
    ],
    stops: 0,
    seatType: 1,
    sortBy: 2,
  };
};

const outbound = flightsResponse([makeFlight("LA", "777", "GIG", "PER", 2215, [2026, 12, 3])]);
const inbound = flightsResponse([makeFlight("QF", "764", "PER", "GIG", 2215, [2027, 3, 4])]);

describe("searchFlights — round trips", () => {
  beforeEach(() => mockedPost.mockReset());

  it("assembles outbound + return into a combo", async () => {
    mockedPost.mockResolvedValueOnce(ok(outbound)).mockResolvedValueOnce(ok(inbound));
    const result = await searchFlights(roundTrip(), 1);
    expect(result.tag).toBe("ok");
    if (result.tag !== "ok") return;
    expect(result.value.tag).toBe("combos");
    if (result.value.tag !== "combos") return;
    expect(result.value.combos[0].map((f) => f.legs[0].airline)).toEqual(["LA", "QF"]);
  });

  it("retries Google's transient error responses", async () => {
    mockedPost
      .mockResolvedValueOnce(ok(errorResponse))
      .mockResolvedValueOnce(ok(errorResponse))
      .mockResolvedValueOnce(ok(outbound))
      .mockResolvedValueOnce(ok(inbound));
    const result = await searchFlights(roundTrip(), 1);
    expect(result.tag === "ok" && result.value.tag).toBe("combos");
    expect(mockedPost).toHaveBeenCalledTimes(4);
  });

  it("retries a request that hung past the per-request timeout", async () => {
    mockedPost
      .mockResolvedValueOnce(err(TIME_LIMIT_ERROR))
      .mockResolvedValueOnce(ok(outbound))
      .mockResolvedValueOnce(ok(inbound));
    const result = await searchFlights(roundTrip(), 1);
    expect(result.tag === "ok" && result.value.tag).toBe("combos");
    expect(mockedPost).toHaveBeenCalledTimes(3);
  });

  it("returns outbound options with a reason when the return leg cannot be loaded", async () => {
    mockedPost.mockResolvedValueOnce(ok(outbound)).mockResolvedValue(ok(errorResponse));
    const result = await searchFlights(roundTrip(), 1, 300);
    expect(result.tag).toBe("ok");
    if (result.tag !== "ok" || result.value.tag !== "flights") throw new Error("expected partial flights");
    expect(result.value.flights[0].price).toBe(2215);
    expect(result.value.partialReason).toBeTruthy();
  });

  it("returns at the deadline while a slow search is still running", async () => {
    mockedPost.mockImplementation(() => new Promise((r) => setTimeout(() => r(ok(outbound)), 1000)));
    const started = Date.now();
    const result = await searchFlights(roundTrip(), 1, 200);
    expect(result.tag).toBe("err");
    if (result.tag !== "err") return;
    expect(result.error).toContain(TIME_LIMIT_ERROR);
    expect(result.error).toContain("background");
    expect(Date.now() - started).toBeLessThan(600);
  });

  it("finishes a timed-out search in the background so the next call answers from cache", async () => {
    const filters = roundTrip();
    mockedPost
      .mockImplementationOnce(() => new Promise((r) => setTimeout(() => r(ok(outbound)), 300)))
      .mockResolvedValueOnce(ok(inbound));

    const first = await searchFlights(filters, 1, 100);
    expect(first.tag).toBe("err");

    await new Promise((r) => setTimeout(r, 400)); // background search completes and is cached

    const second = await searchFlights(filters, 1, 1000);
    expect(second.tag === "ok" && second.value.tag).toBe("combos");
    // one outbound request (finished in the background) + one return request
    expect(mockedPost).toHaveBeenCalledTimes(2);
  });

  it("shares one request between identical concurrent searches", async () => {
    const filters = roundTrip();
    mockedPost
      .mockImplementationOnce(() => new Promise((r) => setTimeout(() => r(ok(outbound)), 100)))
      .mockResolvedValue(ok(inbound));
    const [a, b] = await Promise.all([searchFlights(filters, 1, 2000), searchFlights(filters, 1, 2000)]);
    expect(a.tag === "ok" && a.value.tag).toBe("combos");
    expect(b.tag === "ok" && b.value.tag).toBe("combos");
    expect(mockedPost).toHaveBeenCalledTimes(2);
  });
});
