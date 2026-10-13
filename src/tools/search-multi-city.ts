import { z } from "zod";
import { searchFlights } from "../google/client.js";
import {
  TripType,
  SeatType,
  SortBy,
  MaxStops,
  type FlightSearchFilters,
  type SearchResult,
} from "../google/types.js";
import { formatPrice } from "../lib/format.js";
import { formatDuration } from "../lib/date.js";
import type { Result } from "../lib/result.js";

export const searchMultiCitySchema = z.object({
  segments: z
    .array(
      z.object({
        origin: z.string().length(3).describe("Departure airport IATA code"),
        destination: z.string().length(3).describe("Arrival airport IATA code"),
        date: z.string().describe("Travel date in YYYY-MM-DD format"),
      })
    )
    .min(2)
    .max(5)
    .describe("Flight segments (2-5 legs)"),
  cabinClass: z.enum(["economy", "premium_economy", "business", "first"]).optional().default("economy"),
  adults: z.number().int().min(1).optional().default(1),
  children: z.number().int().min(0).optional().default(0),
  infants: z.number().int().min(0).optional().default(0),
  maxStops: z.number().int().min(0).max(2).optional(),
  maxResults: z.number().int().min(1).max(10).optional().default(3),
});

const SEAT_MAP: Readonly<Record<string, SeatType>> = {
  economy: SeatType.ECONOMY,
  premium_economy: SeatType.PREMIUM_ECONOMY,
  business: SeatType.BUSINESS,
  first: SeatType.FIRST,
};

const STOPS_MAP: Readonly<Record<number, MaxStops>> = {
  0: MaxStops.NON_STOP,
  1: MaxStops.ONE_OR_FEWER,
  2: MaxStops.TWO_OR_FEWER,
};

// Pure: params -> filters
const buildFilters = (
  params: z.infer<typeof searchMultiCitySchema>
): FlightSearchFilters => ({
  tripType: TripType.MULTI_CITY,
  passengers: {
    adults: params.adults ?? 1,
    children: params.children ?? 0,
    infantsOnLap: params.infants ?? 0,
    infantsInSeat: 0,
  },
  segments: params.segments.map((seg) => ({
    departureAirport: seg.origin.toUpperCase(),
    arrivalAirport: seg.destination.toUpperCase(),
    travelDate: seg.date,
  })),
  stops: params.maxStops !== undefined ? STOPS_MAP[params.maxStops] : MaxStops.ANY,
  seatType: SEAT_MAP[params.cabinClass ?? "economy"],
  sortBy: SortBy.BEST,
});

// Pure: format results
const formatSearchResult = (
  result: SearchResult,
  params: z.infer<typeof searchMultiCitySchema>
): string => {
  const max = params.maxResults ?? 3;
  const route = params.segments
    .map((s) => `${s.origin} -> ${s.destination} (${s.date})`)
    .join(" | ");

  if (result.tag === "combos") {
    // Each leg carries the fare for the whole itinerary; the last leg's price is the total.
    const lines = result.combos.slice(0, max).map((combo, i) => {
      const last = combo[combo.length - 1];
      const total = last ? formatPrice(last.price, last.currency) : "?";
      const legs = combo
        .map((flight, j) => {
          const seg = params.segments[j];
          const flightLegs = flight.legs
            .map((l) => `    ${l.airline} ${l.flightNumber}: ${l.departureAirport} ${l.departureTime.replace("T", " ")} -> ${l.arrivalAirport} ${l.arrivalTime.replace("T", " ")}`)
            .join("\n");
          return `  Leg ${j + 1} (${seg?.origin}->${seg?.destination}): ${formatDuration(flight.duration)} | ${flight.stops} stop(s)\n${flightLegs}`;
        })
        .join("\n");
      return `--- Option ${i + 1}: ${total} total ---\n${legs}`;
    });
    return `Multi-city flights: ${route}\n\n${lines.join("\n\n")}`;
  }

  const lines = result.flights.slice(0, max).map((flight, i) => {
    const price = formatPrice(flight.price, flight.currency);
    const flightLegs = flight.legs
      .map((l) => `  ${l.airline} ${l.flightNumber}: ${l.departureAirport} ${l.departureTime.replace("T", " ")} -> ${l.arrivalAirport} ${l.arrivalTime.replace("T", " ")}`)
      .join("\n");
    const label = result.partialReason ? `Leg 1 option ${i + 1}: from ${price} total itinerary` : `Flight ${i + 1}: ${price}`;
    return `${label} | ${formatDuration(flight.duration)} | ${flight.stops} stop(s)\n${flightLegs}`;
  });
  const partialNote = result.partialReason
    ? `\nLater legs could not be loaded (${result.partialReason}). Showing first-leg options only: each price is the cheapest TOTAL fare for an itinerary starting with that flight. Search again to see full itineraries.\n`
    : "";
  return `Multi-city flights: ${route}\n${partialNote}\n${lines.join("\n\n")}`;
};

export const handleSearchMultiCity = async (
  params: z.infer<typeof searchMultiCitySchema>
): Promise<Result<string>> => {
  const filters = buildFilters(params);
  const result = await searchFlights(filters, params.maxResults ?? 3);

  return result.tag === "ok"
    ? { tag: "ok", value: formatSearchResult(result.value, params) }
    : result;
};
