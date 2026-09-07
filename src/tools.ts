// Extracted tool execute functions for testability.
// Each function mirrors the `execute` callback of the corresponding AI tool.

// ── Weather ──────────────────────────────────────────────────────────

export const WMO_DESCRIPTIONS: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Foggy",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  71: "Slight snow",
  73: "Moderate snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Slight snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail"
};

export function describeWeatherCode(code: number): string {
  return WMO_DESCRIPTIONS[code] ?? `Unknown (${code})`;
}

export async function executeGetWeather({ city }: { city: string }) {
  const geoRes = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`
  );
  if (!geoRes.ok) return { error: "Failed to geocode city" };
  const geoData = (await geoRes.json()) as {
    results?: Array<{
      name: string;
      country: string;
      latitude: number;
      longitude: number;
    }>;
  };
  if (!geoData.results?.length) return { error: `City not found: ${city}` };

  const { name, country, latitude, longitude } = geoData.results[0];

  const weatherRes = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max&timezone=auto`
  );
  if (!weatherRes.ok) return { error: "Failed to fetch weather data" };
  const weather = (await weatherRes.json()) as {
    current: {
      temperature_2m: number;
      relative_humidity_2m: number;
      apparent_temperature: number;
      weather_code: number;
      wind_speed_10m: number;
      wind_direction_10m: number;
    };
    current_units: { temperature_2m: string; wind_speed_10m: string };
    daily: {
      time: string[];
      weather_code: number[];
      temperature_2m_max: number[];
      temperature_2m_min: number[];
      precipitation_sum: number[];
      precipitation_probability_max: number[];
      wind_speed_10m_max: number[];
    };
    timezone: string;
  };

  return {
    location: `${name}, ${country}`,
    coordinates: { latitude, longitude },
    timezone: weather.timezone,
    current: {
      temperature: `${weather.current.temperature_2m}${weather.current_units.temperature_2m}`,
      feelsLike: `${weather.current.apparent_temperature}${weather.current_units.temperature_2m}`,
      humidity: `${weather.current.relative_humidity_2m}%`,
      condition: describeWeatherCode(weather.current.weather_code),
      wind: `${weather.current.wind_speed_10m} ${weather.current_units.wind_speed_10m} from ${weather.current.wind_direction_10m}°`
    },
    forecast: weather.daily.time.map((date, i) => ({
      date,
      condition: describeWeatherCode(weather.daily.weather_code[i]),
      high: `${weather.daily.temperature_2m_max[i]}°C`,
      low: `${weather.daily.temperature_2m_min[i]}°C`,
      precipitation: `${weather.daily.precipitation_sum[i]}mm`,
      precipitationChance: `${weather.daily.precipitation_probability_max[i]}%`,
      maxWind: `${weather.daily.wind_speed_10m_max[i]} km/h`
    }))
  };
}

// ── Flights ──────────────────────────────────────────────────────────

const FLIGHTS_API_URL = "https://api.skypicker.com/umbrella/v2/graphql";

export interface FlightSearchParams {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
  maxStops: number;
  cabinClass: string;
  adults: number;
  maxPrice?: number;
  limit: number;
}

// Optional env credentials for fallback APIs
export interface ApiCredentials {
  serpApiKey?: string;
  liteApiKey?: string;
  stayingApiToken?: string;
}

export function parseSector(sector: {
  duration?: number;
  sectorSegments?: Array<{
    segment: {
      source: {
        station: { code: string; name: string };
        localTime: string;
      };
      destination: {
        station: {
          code: string;
          name: string;
          city?: { name: string; country?: { code: string; name: string } };
        };
        localTime: string;
      };
      duration: number;
      carrier: { code: string; name: string };
    };
  }>;
}) {
  const segments = (sector.sectorSegments ?? []).map((s) => {
    const seg = s.segment;
    return {
      from: `${seg.source.station.code} (${seg.source.station.name})`,
      to: `${seg.destination.station.code} (${seg.destination.station.name})`,
      departure: seg.source.localTime,
      arrival: seg.destination.localTime,
      duration: `${Math.floor((seg.duration || 0) / 60)}h ${(seg.duration || 0) % 60}m`,
      airline: seg.carrier.name || seg.carrier.code
    };
  });
  const totalMin = (sector.duration || 0) / 60;
  return {
    totalDuration: `${Math.floor(totalMin / 60)}h ${Math.round(totalMin % 60)}m`,
    stops: Math.max(0, segments.length - 1),
    segments
  };
}

function buildPassengers(adults: number) {
  return {
    adults,
    children: 0,
    infants: 0,
    adultsHoldBags: 0,
    adultsHandBags: 0,
    childrenHoldBags: [] as number[],
    childrenHandBags: [] as number[]
  };
}

function buildFilter(limit: number, maxStops: number, maxPrice?: number) {
  return {
    allowChangeInboundDestination: true,
    allowChangeInboundSource: true,
    allowDifferentStationConnection: true,
    enableSelfTransfer: true,
    enableThrowAwayTicketing: true,
    enableTrueHiddenCity: true,
    transportTypes: ["FLIGHT"],
    contentProviders: ["KIWI", "FRESH", "KAYAK"],
    flightsApiLimit: limit,
    limit,
    maxStopsCount: maxStops,
    ...(maxPrice != null ? { price: { end: maxPrice } } : {})
  };
}

function buildOptions() {
  return {
    sortBy: "PRICE",
    mergePriceDiffRule: "INCREASED",
    currency: "USD",
    locale: "en",
    partner: "skypicker",
    affilID: "skypicker",
    storeSearch: false,
    searchStrategy: "REDUCED"
  };
}

async function searchFlightsSkypicker(params: FlightSearchParams) {
  const {
    origin,
    destination,
    departureDate,
    returnDate,
    maxStops,
    cabinClass,
    adults,
    maxPrice,
    limit
  } = params;

  if (returnDate) {
    const query = `query SearchReturnItinerariesQuery($search:SearchReturnInput,$filter:ItinerariesFilterInput,$options:ItinerariesOptionsInput){returnItineraries(search:$search,filter:$filter,options:$options){__typename ...on AppError{error:message}...on Itineraries{itineraries{__typename ...on ItineraryReturn{id price{amount}outbound{duration sectorSegments{segment{source{station{code name}localTime}destination{station{code name city{name country{code name}}}localTime}duration carrier{code name}}}}inbound{duration sectorSegments{segment{source{station{code name}localTime}destination{station{code name}localTime}duration carrier{code name}}}}bookingOptions{edges{node{bookingUrl}}}}}}}}`;

    const variables = {
      search: {
        itinerary: {
          source: { ids: [origin] },
          destination: { ids: [destination] },
          outboundDepartureDate: {
            start: `${departureDate}T00:00:00`,
            end: `${departureDate}T23:59:59`
          },
          inboundDepartureDate: {
            start: `${returnDate}T00:00:00`,
            end: `${returnDate}T23:59:59`
          }
        },
        passengers: buildPassengers(adults),
        cabinClass: { cabinClass, applyMixedClasses: false }
      },
      filter: buildFilter(limit, maxStops, maxPrice),
      options: buildOptions()
    };

    const res = await fetch(
      `${FLIGHTS_API_URL}?featureName=SearchReturnItinerariesQuery`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "PlayWindow/1.0" },
        body: JSON.stringify({ query, variables })
      }
    );
    if (!res.ok) return { error: `Flight API error: ${res.status}` };

    const data = (await res.json()) as {
      data?: {
        returnItineraries?: {
          __typename: string;
          error?: string;
          itineraries?: Array<{
            id: string;
            price: { amount: string };
            outbound: {
              duration: number;
              sectorSegments: Array<{
                segment: {
                  source: {
                    station: { code: string; name: string };
                    localTime: string;
                  };
                  destination: {
                    station: {
                      code: string;
                      name: string;
                      city?: {
                        name: string;
                        country?: { code: string; name: string };
                      };
                    };
                    localTime: string;
                  };
                  duration: number;
                  carrier: { code: string; name: string };
                };
              }>;
            };
            inbound: {
              duration: number;
              sectorSegments: Array<{
                segment: {
                  source: {
                    station: { code: string; name: string };
                    localTime: string;
                  };
                  destination: {
                    station: { code: string; name: string };
                    localTime: string;
                  };
                  duration: number;
                  carrier: { code: string; name: string };
                };
              }>;
            };
            bookingOptions: {
              edges: Array<{ node: { bookingUrl: string } }>;
            };
          }>;
        };
      };
    };

    const rt = data.data?.returnItineraries;
    if (rt?.__typename === "AppError")
      return { error: rt.error ?? "Flight search failed" };

    return {
      type: "round-trip" as const,
      origin,
      destination,
      departureDate,
      returnDate,
      results: (rt?.itineraries ?? []).map((it) => ({
        price: `$${parseFloat(it.price.amount).toFixed(0)}`,
        outbound: parseSector(it.outbound),
        inbound: parseSector(it.inbound),
        bookingUrl:
          it.bookingOptions?.edges?.[0]?.node?.bookingUrl ?? null
      }))
    };
  }

  // One-way search
  const query = `query SearchOneWayItinerariesQuery($search:SearchOnewayInput,$filter:ItinerariesFilterInput,$options:ItinerariesOptionsInput){onewayItineraries(search:$search,filter:$filter,options:$options){__typename ...on AppError{error:message}...on Itineraries{itineraries{__typename ...on ItineraryOneWay{id price{amount}sector{duration sectorSegments{segment{source{station{code name}localTime}destination{station{code name}localTime}duration carrier{code name}}}}bookingOptions{edges{node{bookingUrl}}}}}}}}`;

  const variables = {
    search: {
      itinerary: {
        source: { ids: [origin] },
        destination: { ids: [destination] },
        outboundDepartureDate: {
          start: `${departureDate}T00:00:00`,
          end: `${departureDate}T23:59:59`
        }
      },
      passengers: buildPassengers(adults),
      cabinClass: { cabinClass, applyMixedClasses: false }
    },
    filter: buildFilter(limit, maxStops, maxPrice),
    options: buildOptions()
  };

  const res = await fetch(
    `${FLIGHTS_API_URL}?featureName=SearchOneWayItinerariesQuery`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables })
    }
  );
  if (!res.ok) return { error: `Flight API error: ${res.status}` };

  const data = (await res.json()) as {
    data?: {
      onewayItineraries?: {
        __typename: string;
        error?: string;
        itineraries?: Array<{
          id: string;
          price: { amount: string };
          sector: {
            duration: number;
            sectorSegments: Array<{
              segment: {
                source: {
                  station: { code: string; name: string };
                  localTime: string;
                };
                destination: {
                  station: { code: string; name: string };
                  localTime: string;
                };
                duration: number;
                carrier: { code: string; name: string };
              };
            }>;
          };
          bookingOptions: {
            edges: Array<{ node: { bookingUrl: string } }>;
          };
        }>;
      };
    };
  };

  const ow = data.data?.onewayItineraries;
  if (ow?.__typename === "AppError")
    return { error: ow.error ?? "Flight search failed" };

  return {
    type: "one-way" as const,
    origin,
    destination,
    departureDate,
    results: (ow?.itineraries ?? []).map((it) => ({
      price: `$${parseFloat(it.price.amount).toFixed(0)}`,
      ...parseSector(it.sector),
      bookingUrl:
        it.bookingOptions?.edges?.[0]?.node?.bookingUrl ?? null
    }))
  };
}

// ── SerpAPI Google Flights Search (fallback) ─────────────────────────

const SERPAPI_URL = "https://serpapi.com/search.json";

async function searchFlightsSerpApi(
  params: FlightSearchParams,
  apiKey: string
) {
  const queryParams = new URLSearchParams({
    engine: "google_flights",
    departure_id: params.origin,
    arrival_id: params.destination,
    outbound_date: params.departureDate,
    adults: String(params.adults),
    currency: "USD",
    hl: "en",
    type: params.returnDate ? "1" : "2", // 1 = round-trip, 2 = one-way
    stops: params.maxStops === 0 ? "1" : "0", // 1 = nonstop only, 0 = any
    api_key: apiKey
  });
  if (params.returnDate) queryParams.set("return_date", params.returnDate);

  const travelClassMap: Record<string, string> = {
    ECONOMY: "1",
    PREMIUM_ECONOMY: "2",
    BUSINESS: "3",
    FIRST: "4"
  };
  queryParams.set(
    "travel_class",
    travelClassMap[params.cabinClass] ?? "1"
  );

  const res = await fetch(`${SERPAPI_URL}?${queryParams.toString()}`);
  if (!res.ok) throw new Error(`SerpAPI error: ${res.status}`);

  const data = (await res.json()) as {
    best_flights?: SerpApiFlight[];
    other_flights?: SerpApiFlight[];
    error?: string;
  };

  if (data.error) throw new Error(`SerpAPI: ${data.error}`);

  const allFlights = [
    ...(data.best_flights ?? []),
    ...(data.other_flights ?? [])
  ].slice(0, params.limit);

  const results = allFlights.map((flight) => {
    const segments = (flight.flights ?? []).map((seg) => ({
      from: `${seg.departure_airport?.id} (${seg.departure_airport?.name ?? ""})`,
      to: `${seg.arrival_airport?.id} (${seg.arrival_airport?.name ?? ""})`,
      departure: seg.departure_airport?.time ?? "",
      arrival: seg.arrival_airport?.time ?? "",
      duration: `${Math.floor((seg.duration ?? 0) / 60)}h ${(seg.duration ?? 0) % 60}m`,
      airline: seg.airline ?? ""
    }));

    return {
      price: flight.price != null ? `$${flight.price}` : "N/A",
      totalDuration: `${Math.floor((flight.total_duration ?? 0) / 60)}h ${(flight.total_duration ?? 0) % 60}m`,
      stops: Math.max(0, (flight.flights?.length ?? 1) - 1),
      segments,
      bookingUrl: flight.booking_token
        ? `https://www.google.com/travel/flights/booking?token=${flight.booking_token}`
        : null
    };
  });

  // Filter by maxPrice client-side
  const filtered =
    params.maxPrice != null
      ? results.filter((r) => {
          const p = parseInt(r.price.replace("$", ""), 10);
          return !isNaN(p) && p <= params.maxPrice!;
        })
      : results;

  return {
    type: params.returnDate ? ("round-trip" as const) : ("one-way" as const),
    origin: params.origin,
    destination: params.destination,
    departureDate: params.departureDate,
    ...(params.returnDate ? { returnDate: params.returnDate } : {}),
    source: "google_flights",
    results: filtered
  };
}

interface SerpApiFlight {
  flights?: Array<{
    departure_airport?: { id: string; name: string; time: string };
    arrival_airport?: { id: string; name: string; time: string };
    duration?: number;
    airline?: string;
  }>;
  total_duration?: number;
  price?: number;
  booking_token?: string;
}

// ── LiteAPI Flight Search (fallback) ─────────────────────────────────

async function searchFlightsLiteApi(
  params: FlightSearchParams,
  apiKey: string
) {
  const cabinMap: Record<string, string> = {
    ECONOMY: "economy",
    PREMIUM_ECONOMY: "premium_economy",
    BUSINESS: "business",
    FIRST: "first"
  };

  const legs: Array<{ origin: string; destination: string; date: string }> = [
    {
      origin: params.origin,
      destination: params.destination,
      date: params.departureDate
    }
  ];
  if (params.returnDate) {
    legs.push({
      origin: params.destination,
      destination: params.origin,
      date: params.returnDate
    });
  }

  const body: Record<string, unknown> = {
    legs,
    adults: params.adults,
    currency: "USD",
    filters: {
      cabinClass: cabinMap[params.cabinClass] ?? "economy",
      ...(params.maxStops === 0 ? { maxStops: 0 } : {})
    }
  };

  const res = await fetch(`${LITEAPI_URL}/flights/rates`, {
    method: "POST",
    headers: {
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LiteAPI flights error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    data?: {
      offers?: Array<{
        offerId: string;
        price?: { total?: number; currency?: string };
        itineraries?: Array<{
          duration?: number;
          segments?: Array<{
            departure?: { airport?: string; time?: string };
            arrival?: { airport?: string; time?: string };
            duration?: number;
            carrier?: { name?: string; code?: string };
            flightNumber?: string;
          }>;
        }>;
      }>;
    };
  };

  const offers = (data.data?.offers ?? []).slice(0, params.limit);

  const results = offers.map((offer) => {
    const outbound = offer.itineraries?.[0];
    const inbound = offer.itineraries?.[1];

    const mapSegments = (itin: NonNullable<typeof outbound>) =>
      (itin.segments ?? []).map((seg) => ({
        from: seg.departure?.airport ?? "",
        to: seg.arrival?.airport ?? "",
        departure: seg.departure?.time ?? "",
        arrival: seg.arrival?.time ?? "",
        duration: seg.duration
          ? `${Math.floor(seg.duration / 60)}h ${seg.duration % 60}m`
          : "",
        airline: seg.carrier?.name || seg.carrier?.code || ""
      }));

    const base = {
      price: offer.price?.total != null
        ? `$${offer.price.total.toFixed(0)}`
        : "N/A",
      totalDuration: outbound?.duration
        ? `${Math.floor(outbound.duration / 60)}h ${outbound.duration % 60}m`
        : "",
      stops: Math.max(0, (outbound?.segments?.length ?? 1) - 1),
      segments: outbound ? mapSegments(outbound) : [],
      bookingUrl: null as string | null
    };

    if (inbound) {
      return {
        ...base,
        outbound: base,
        inbound: {
          totalDuration: inbound.duration
            ? `${Math.floor(inbound.duration / 60)}h ${inbound.duration % 60}m`
            : "",
          stops: Math.max(0, (inbound.segments?.length ?? 1) - 1),
          segments: mapSegments(inbound)
        }
      };
    }
    return base;
  });

  // Client-side price filter
  const filtered =
    params.maxPrice != null
      ? results.filter((r) => {
          const p = parseInt(r.price.replace("$", ""), 10);
          return !isNaN(p) && p <= params.maxPrice!;
        })
      : results;

  return {
    type: params.returnDate ? ("round-trip" as const) : ("one-way" as const),
    origin: params.origin,
    destination: params.destination,
    departureDate: params.departureDate,
    ...(params.returnDate ? { returnDate: params.returnDate } : {}),
    source: "liteapi",
    results: filtered
  };
}

// ── Flight search orchestrator (Skypicker → LiteAPI → SerpAPI) ───────

export async function executeGetFlights(
  params: FlightSearchParams,
  credentials?: ApiCredentials
) {
  const errors: string[] = [];

  // Try Skypicker first (no key needed, supports "anywhere")
  try {
    const result = await searchFlightsSkypicker(params);
    if (!("error" in result)) return result;
    errors.push(`Skypicker: ${(result as { error: string }).error}`);
  } catch (e) {
    errors.push(`Skypicker: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Try LiteAPI fallback (needs key, does not support "anywhere")
  if (credentials?.liteApiKey && params.destination !== "anywhere") {
    try {
      return await searchFlightsLiteApi(params, credentials.liteApiKey);
    } catch (e) {
      errors.push(`LiteAPI: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Try SerpAPI fallback (needs key, does not support "anywhere")
  if (credentials?.serpApiKey && params.destination !== "anywhere") {
    try {
      return await searchFlightsSerpApi(params, credentials.serpApiKey);
    } catch (e) {
      errors.push(`SerpAPI: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    error: errors.length > 0
      ? `All flight APIs failed. ${errors.join(". ")}`
      : "Flight search unavailable. Configure LITEAPI_KEY or SERPAPI_KEY for fallback providers."
  };
}

// ── Hotels ───────────────────────────────────────────────────────────

export const HOTEL_LOCATION_KEYS: Record<string, string> = {
  "new york": "g60763",
  nyc: "g60763",
  "los angeles": "g32655",
  la: "g32655",
  "san francisco": "g60713",
  sf: "g60713",
  chicago: "g35805",
  "las vegas": "g45963",
  miami: "g34438",
  seattle: "g60878",
  boston: "g60745",
  "washington dc": "g28970",
  dc: "g28970",
  austin: "g30196",
  denver: "g33388",
  "san diego": "g60750",
  portland: "g52024",
  phoenix: "g31310",
  atlanta: "g60898",
  nashville: "g55229",
  "new orleans": "g60864",
  orlando: "g34515",
  honolulu: "g60982",
  hawaii: "g60982",
  london: "g186338",
  paris: "g187147",
  tokyo: "g298184",
  rome: "g187791",
  barcelona: "g187497",
  amsterdam: "g188590",
  berlin: "g187323",
  dubai: "g295424",
  singapore: "g294265",
  "hong kong": "g294217",
  bangkok: "g293916",
  sydney: "g255060",
  melbourne: "g255100",
  toronto: "g155019",
  vancouver: "g154943",
  montreal: "g155032",
  "mexico city": "g150800",
  cancun: "g150807",
  lisbon: "g189158",
  madrid: "g187514",
  prague: "g274707",
  vienna: "g190454",
  dublin: "g186605",
  edinburgh: "g186525",
  florence: "g187895",
  venice: "g187870",
  milan: "g187849",
  munich: "g187309",
  zurich: "g188113",
  copenhagen: "g189541",
  stockholm: "g189852",
  oslo: "g190479",
  reykjavik: "g189970",
  athens: "g189400",
  istanbul: "g293974",
  cairo: "g294201",
  "cape town": "g1722390",
  marrakech: "g293734",
  bali: "g294226",
  seoul: "g294197",
  taipei: "g293913",
  "kuala lumpur": "g298570",
  "buenos aires": "g312741",
  "rio de janeiro": "g303506",
  lima: "g294316",
  bogota: "g294074",
  santiago: "g294305",
  kyoto: "g298564",
  osaka: "g298566"
};

export function resolveHotelLocationKey(city: string): string | null {
  if (city.startsWith("g")) return city;
  return HOTEL_LOCATION_KEYS[city.toLowerCase().trim()] ?? null;
}

export interface HotelSearchParams {
  city: string;
  limit: number;
  minPrice?: number;
  maxPrice?: number;
  minRating?: number;
}

async function searchHotelsXotelo(params: HotelSearchParams) {
  const { city, limit, minPrice, maxPrice, minRating } = params;

  const key = resolveHotelLocationKey(city);
  if (!key) {
    return {
      error: `City not supported: '${city}'. Try a major city like 'new york', 'tokyo', 'paris', 'london', etc.`
    };
  }

  const urlParams = new URLSearchParams({
    location_key: key,
    limit: String(limit),
    offset: "0"
  });

  const res = await fetch(
    `https://data.xotelo.com/api/list?${urlParams.toString()}`
  );
  if (!res.ok) return { error: `Hotel API error: ${res.status}` };

  const data = (await res.json()) as {
    error?: { message: string };
    result?: {
      total_count: number;
      list: Array<{
        key: string;
        name: string;
        accommodation_type: string;
        url?: string;
        image?: string;
        review_summary?: { rating: number; count: number };
        price_ranges?: { minimum: number; maximum: number };
        geo?: { latitude: number; longitude: number };
        mentions?: string[];
        merchandising_labels?: string[];
      }>;
    };
  };

  if (data.error)
    return { error: `Hotel search failed: ${data.error.message}` };

  let hotels = (data.result?.list ?? []).map((h) => ({
    name: h.name,
    type: h.accommodation_type,
    rating: h.review_summary?.rating ?? null,
    reviewCount: h.review_summary?.count ?? null,
    priceRange: h.price_ranges
      ? `$${h.price_ranges.minimum}-$${h.price_ranges.maximum}/night`
      : null,
    minPrice: h.price_ranges?.minimum ?? null,
    maxPrice: h.price_ranges?.maximum ?? null,
    tags: [...(h.mentions ?? []), ...(h.merchandising_labels ?? [])].filter(
      Boolean
    ),
    url: h.url ?? null
  }));

  if (minPrice != null) {
    hotels = hotels.filter(
      (h) => h.minPrice != null && h.minPrice >= minPrice
    );
  }
  if (maxPrice != null) {
    hotels = hotels.filter(
      (h) => h.maxPrice != null && h.maxPrice <= maxPrice
    );
  }
  if (minRating != null) {
    hotels = hotels.filter(
      (h) => h.rating != null && h.rating >= minRating
    );
  }

  return {
    city,
    totalAvailable: data.result?.total_count ?? hotels.length,
    resultsShown: hotels.length,
    hotels: hotels.map(({ minPrice: _a, maxPrice: _b, ...rest }) => rest)
  };
}

// ── StayingAPI Hotel Search (fallback) ───────────────────────────────

const STAYINGAPI_URL = "https://api.stayingapi.com/v1/search";

async function searchHotelsStaying(params: HotelSearchParams, token: string) {
  const { city, limit, minPrice, maxPrice, minRating } = params;

  const queryParams = new URLSearchParams({
    location: city,
    limit: String(limit),
    currency: "USD",
    sort: "price_asc",
    platforms: "booking,google"
  });

  const res = await fetch(`${STAYINGAPI_URL}?${queryParams.toString()}`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (res.status === 202) {
    // Async job — poll once
    const job = (await res.json()) as { data?: { jobId: string } };
    if (job.data?.jobId) {
      await new Promise((r) => setTimeout(r, 3000));
      const pollRes = await fetch(
        `https://api.stayingapi.com/v1/jobs/${job.data.jobId}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!pollRes.ok)
        throw new Error(`StayingAPI poll failed: ${pollRes.status}`);
      const pollData = (await pollRes.json()) as {
        data?: { result?: { data?: StayingHotel[] } };
      };
      return formatStayingResults(
        city,
        pollData.data?.result?.data ?? [],
        minPrice,
        maxPrice,
        minRating
      );
    }
  }

  if (!res.ok) throw new Error(`StayingAPI error: ${res.status}`);

  const data = (await res.json()) as { data?: StayingHotel[] };
  return formatStayingResults(
    city,
    data.data ?? [],
    minPrice,
    maxPrice,
    minRating
  );
}

interface StayingHotel {
  name: string;
  platform: string;
  propertyType: string;
  guestRating?: number;
  reviewCount?: number;
  price?: { nightlyPrice?: number; totalPrice?: number; currency?: string };
  location?: { city?: string; country?: string };
  amenities?: string[];
}

function formatStayingResults(
  city: string,
  raw: StayingHotel[],
  minPrice?: number,
  maxPrice?: number,
  minRating?: number
) {
  let hotels = raw.map((h) => ({
    name: h.name,
    type: h.propertyType || "Hotel",
    rating: h.guestRating ?? null,
    reviewCount: h.reviewCount ?? null,
    priceRange: h.price?.nightlyPrice
      ? `$${h.price.nightlyPrice}/night`
      : null,
    nightlyPrice: h.price?.nightlyPrice ?? null,
    platform: h.platform,
    tags: h.amenities?.slice(0, 5) ?? [],
    url: null as string | null
  }));

  if (minPrice != null)
    hotels = hotels.filter(
      (h) => h.nightlyPrice != null && h.nightlyPrice >= minPrice
    );
  if (maxPrice != null)
    hotels = hotels.filter(
      (h) => h.nightlyPrice != null && h.nightlyPrice <= maxPrice
    );
  if (minRating != null)
    hotels = hotels.filter(
      (h) => h.rating != null && h.rating >= minRating
    );

  return {
    city,
    source: "stayingapi",
    totalAvailable: hotels.length,
    resultsShown: hotels.length,
    hotels: hotels.map(({ nightlyPrice: _, ...rest }) => rest)
  };
}

// ── LiteAPI Hotel Search (fallback) ──────────────────────────────────

const LITEAPI_URL = "https://api.liteapi.travel/v3.0";

async function searchHotelsLiteApi(params: HotelSearchParams, apiKey: string) {
  const { city, limit, minPrice, maxPrice, minRating } = params;

  // Use the data endpoint to list hotels by city
  const listParams = new URLSearchParams({
    cityName: city,
    limit: String(limit)
  });

  const res = await fetch(`${LITEAPI_URL}/data/hotels?${listParams.toString()}`, {
    headers: {
      "X-API-Key": apiKey,
      Accept: "application/json"
    }
  });
  if (!res.ok) throw new Error(`LiteAPI error: ${res.status}`);

  const data = (await res.json()) as {
    data?: Array<{
      id: string;
      name: string;
      hotelDescription?: string;
      currency?: string;
      starRating?: number;
      reviewScore?: number;
      reviewCount?: number;
      address?: string;
      city?: string;
      country?: string;
      latitude?: number;
      longitude?: number;
      facilities?: string[];
      mainPhoto?: string;
    }>;
  };

  let hotels = (data.data ?? []).map((h) => ({
    name: h.name,
    type: "Hotel",
    rating: h.reviewScore ?? h.starRating ?? null,
    reviewCount: h.reviewCount ?? null,
    priceRange: null as string | null,
    minPrice: null as number | null,
    maxPrice: null as number | null,
    tags: (h.facilities ?? []).slice(0, 5),
    url: null as string | null,
    address: h.address ?? null
  }));

  if (minRating != null) {
    hotels = hotels.filter((h) => h.rating != null && h.rating >= minRating);
  }

  return {
    city,
    source: "liteapi",
    totalAvailable: hotels.length,
    resultsShown: hotels.length,
    hotels: hotels.map(({ minPrice: _a, maxPrice: _b, ...rest }) => rest)
  };
}

// ── Hotel search orchestrator (Xotelo → LiteAPI → StayingAPI) ────────

export async function executeGetHotels(
  params: HotelSearchParams,
  credentials?: ApiCredentials
) {
  const errors: string[] = [];

  // Try Xotelo first
  try {
    const result = await searchHotelsXotelo(params);
    if (!("error" in result)) return result;
    errors.push(`Xotelo: ${(result as { error: string }).error}`);
  } catch (e) {
    errors.push(`Xotelo: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Try LiteAPI fallback
  if (credentials?.liteApiKey) {
    try {
      return await searchHotelsLiteApi(params, credentials.liteApiKey);
    } catch (e) {
      errors.push(`LiteAPI: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Try StayingAPI fallback
  if (credentials?.stayingApiToken) {
    try {
      return await searchHotelsStaying(params, credentials.stayingApiToken);
    } catch (e) {
      errors.push(`StayingAPI: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    error: errors.length > 0
      ? `All hotel APIs failed. ${errors.join(". ")}`
      : "Hotel search unavailable. Configure LITEAPI_KEY or STAYINGAPI_TOKEN for fallback providers."
  };
}

// ── Client-side location handler ─────────────────────────────────────

export async function handleGetUserLocation(): Promise<Record<string, unknown>> {
  // Try browser Geolocation API first
  try {
    const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        timeout: 5000,
        maximumAge: 300000
      })
    );
    const { latitude, longitude } = pos.coords;

    const nomRes = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json&zoom=10`
    );
    if (nomRes.ok) {
      const nom = (await nomRes.json()) as {
        address?: {
          city?: string;
          town?: string;
          state?: string;
          country?: string;
          country_code?: string;
        };
      };
      const addr = nom.address ?? {};
      return {
        city: addr.city || addr.town || addr.state || "Unknown",
        country: addr.country || "Unknown",
        countryCode: addr.country_code?.toUpperCase() || "",
        latitude,
        longitude,
        source: "browser-geolocation"
      };
    }

    return { latitude, longitude, source: "browser-geolocation" };
  } catch {
    // Fallback to IP-based geolocation
  }

  try {
    const ipRes = await fetch("https://ipapi.co/json/");
    if (ipRes.ok) {
      const ip = (await ipRes.json()) as {
        city?: string;
        region?: string;
        country_name?: string;
        country_code?: string;
        latitude?: number;
        longitude?: number;
      };
      return {
        city: ip.city || "Unknown",
        region: ip.region || "",
        country: ip.country_name || "Unknown",
        countryCode: ip.country_code || "",
        latitude: ip.latitude,
        longitude: ip.longitude,
        source: "ip-geolocation"
      };
    }
  } catch {
    // Both methods failed
  }

  return {
    error: "Could not determine location",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  };
}
