import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  describeWeatherCode,
  WMO_DESCRIPTIONS,
  executeGetWeather,
  parseSector,
  executeGetFlights,
  HOTEL_LOCATION_KEYS,
  resolveHotelLocationKey,
  executeGetHotels,
  handleGetUserLocation
} from "../src/tools";

// ── Helpers ──────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function errorResponse(status: number) {
  return new Response("error", { status });
}

// ── Weather ──────────────────────────────────────────────────────────

describe("describeWeatherCode", () => {
  it("returns description for known codes", () => {
    expect(describeWeatherCode(0)).toBe("Clear sky");
    expect(describeWeatherCode(95)).toBe("Thunderstorm");
    expect(describeWeatherCode(65)).toBe("Heavy rain");
  });

  it("returns Unknown for unrecognised codes", () => {
    expect(describeWeatherCode(999)).toBe("Unknown (999)");
  });
});

describe("WMO_DESCRIPTIONS", () => {
  it("contains expected codes", () => {
    expect(Object.keys(WMO_DESCRIPTIONS).length).toBeGreaterThan(20);
    expect(WMO_DESCRIPTIONS[0]).toBe("Clear sky");
    expect(WMO_DESCRIPTIONS[99]).toBe("Thunderstorm with heavy hail");
  });
});

describe("executeGetWeather", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns weather data for a valid city", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // Geocoding response
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        results: [
          { name: "Paris", country: "France", latitude: 48.85, longitude: 2.35 }
        ]
      })
    );

    // Weather response
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        current: {
          temperature_2m: 22,
          relative_humidity_2m: 55,
          apparent_temperature: 21,
          weather_code: 1,
          wind_speed_10m: 12,
          wind_direction_10m: 180
        },
        current_units: { temperature_2m: "°C", wind_speed_10m: "km/h" },
        daily: {
          time: ["2026-09-06"],
          weather_code: [0],
          temperature_2m_max: [25],
          temperature_2m_min: [15],
          precipitation_sum: [0],
          precipitation_probability_max: [10],
          wind_speed_10m_max: [20]
        },
        timezone: "Europe/Paris"
      })
    );

    const result = await executeGetWeather({ city: "Paris" });

    expect(result).toHaveProperty("location", "Paris, France");
    expect(result).toHaveProperty("timezone", "Europe/Paris");
    expect(result).toHaveProperty("current");
    expect(result).toHaveProperty("forecast");

    const r = result as { current: { temperature: string; condition: string }; forecast: unknown[] };
    expect(r.current.temperature).toBe("22°C");
    expect(r.current.condition).toBe("Mainly clear");
    expect(r.forecast).toHaveLength(1);
  });

  it("returns error when city is not found", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ results: [] })
    );

    const result = await executeGetWeather({ city: "Atlantis" });
    expect(result).toEqual({ error: "City not found: Atlantis" });
  });

  it("returns error when geocoding API fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(errorResponse(500));

    const result = await executeGetWeather({ city: "Paris" });
    expect(result).toEqual({ error: "Failed to geocode city" });
  });

  it("returns error when weather API fails", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        results: [
          { name: "Paris", country: "France", latitude: 48.85, longitude: 2.35 }
        ]
      })
    );
    fetchSpy.mockResolvedValueOnce(errorResponse(503));

    const result = await executeGetWeather({ city: "Paris" });
    expect(result).toEqual({ error: "Failed to fetch weather data" });
  });
});

// ── Flights ──────────────────────────────────────────────────────────

describe("parseSector", () => {
  it("parses a sector with one segment (direct flight)", () => {
    const sector = {
      duration: 9000, // 150 minutes in seconds
      sectorSegments: [
        {
          segment: {
            source: {
              station: { code: "SFO", name: "San Francisco" },
              localTime: "2026-10-01T08:00:00"
            },
            destination: {
              station: { code: "LAX", name: "Los Angeles" },
              localTime: "2026-10-01T09:30:00"
            },
            duration: 5400,
            carrier: { code: "UA", name: "United Airlines" }
          }
        }
      ]
    };

    const result = parseSector(sector);
    expect(result.stops).toBe(0);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].from).toBe("SFO (San Francisco)");
    expect(result.segments[0].to).toBe("LAX (Los Angeles)");
    expect(result.segments[0].airline).toBe("United Airlines");
  });

  it("parses a sector with two segments (1 stop)", () => {
    const sector = {
      duration: 18000,
      sectorSegments: [
        {
          segment: {
            source: {
              station: { code: "SFO", name: "San Francisco" },
              localTime: "2026-10-01T08:00:00"
            },
            destination: {
              station: { code: "DEN", name: "Denver" },
              localTime: "2026-10-01T11:00:00"
            },
            duration: 7200,
            carrier: { code: "UA", name: "United Airlines" }
          }
        },
        {
          segment: {
            source: {
              station: { code: "DEN", name: "Denver" },
              localTime: "2026-10-01T12:00:00"
            },
            destination: {
              station: { code: "JFK", name: "John F Kennedy" },
              localTime: "2026-10-01T16:00:00"
            },
            duration: 10800,
            carrier: { code: "UA", name: "United Airlines" }
          }
        }
      ]
    };

    const result = parseSector(sector);
    expect(result.stops).toBe(1);
    expect(result.segments).toHaveLength(2);
  });

  it("handles empty sector", () => {
    const result = parseSector({});
    expect(result.stops).toBe(0);
    expect(result.segments).toHaveLength(0);
    expect(result.totalDuration).toBe("0h 0m");
  });

  it("falls back to carrier code when name is missing", () => {
    const sector = {
      duration: 5400,
      sectorSegments: [
        {
          segment: {
            source: {
              station: { code: "SFO", name: "San Francisco" },
              localTime: "2026-10-01T08:00:00"
            },
            destination: {
              station: { code: "LAX", name: "Los Angeles" },
              localTime: "2026-10-01T09:30:00"
            },
            duration: 5400,
            carrier: { code: "UA", name: "" }
          }
        }
      ]
    };

    const result = parseSector(sector);
    expect(result.segments[0].airline).toBe("UA");
  });
});

describe("executeGetFlights", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const baseParams = {
    origin: "SFO",
    destination: "LAX",
    departureDate: "2026-10-01",
    maxStops: 1,
    cabinClass: "ECONOMY",
    adults: 1,
    limit: 5
  };

  it("returns one-way flight results", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        data: {
          onewayItineraries: {
            __typename: "Itineraries",
            itineraries: [
              {
                id: "flight1",
                price: { amount: "89.00" },
                sector: {
                  duration: 5400,
                  sectorSegments: [
                    {
                      segment: {
                        source: {
                          station: { code: "SFO", name: "San Francisco" },
                          localTime: "2026-10-01T08:00:00"
                        },
                        destination: {
                          station: { code: "LAX", name: "Los Angeles" },
                          localTime: "2026-10-01T09:30:00"
                        },
                        duration: 5400,
                        carrier: { code: "UA", name: "United Airlines" }
                      }
                    }
                  ]
                },
                bookingOptions: {
                  edges: [{ node: { bookingUrl: "https://book.example.com/1" } }]
                }
              }
            ]
          }
        }
      })
    );

    const result = await executeGetFlights(baseParams);
    expect(result).toHaveProperty("type", "one-way");

    const r = result as { results: Array<{ price: string; stops: number; bookingUrl: string }> };
    expect(r.results).toHaveLength(1);
    expect(r.results[0].price).toBe("$89");
    expect(r.results[0].stops).toBe(0);
    expect(r.results[0].bookingUrl).toBe("https://book.example.com/1");
  });

  it("returns round-trip flight results", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        data: {
          returnItineraries: {
            __typename: "Itineraries",
            itineraries: [
              {
                id: "rt1",
                price: { amount: "250.50" },
                outbound: {
                  duration: 5400,
                  sectorSegments: [
                    {
                      segment: {
                        source: {
                          station: { code: "SFO", name: "San Francisco" },
                          localTime: "2026-10-01T08:00:00"
                        },
                        destination: {
                          station: {
                            code: "LAX",
                            name: "Los Angeles",
                            city: { name: "Los Angeles", country: { code: "US", name: "United States" } }
                          },
                          localTime: "2026-10-01T09:30:00"
                        },
                        duration: 5400,
                        carrier: { code: "UA", name: "United Airlines" }
                      }
                    }
                  ]
                },
                inbound: {
                  duration: 5400,
                  sectorSegments: [
                    {
                      segment: {
                        source: {
                          station: { code: "LAX", name: "Los Angeles" },
                          localTime: "2026-10-08T18:00:00"
                        },
                        destination: {
                          station: { code: "SFO", name: "San Francisco" },
                          localTime: "2026-10-08T19:30:00"
                        },
                        duration: 5400,
                        carrier: { code: "UA", name: "United Airlines" }
                      }
                    }
                  ]
                },
                bookingOptions: {
                  edges: [{ node: { bookingUrl: "https://book.example.com/rt1" } }]
                }
              }
            ]
          }
        }
      })
    );

    const result = await executeGetFlights({
      ...baseParams,
      returnDate: "2026-10-08"
    });
    expect(result).toHaveProperty("type", "round-trip");

    const r = result as { results: Array<{ price: string; outbound: unknown; inbound: unknown }> };
    expect(r.results).toHaveLength(1);
    expect(r.results[0].price).toBe("$251");
  });

  it("returns error when API responds with non-OK status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(errorResponse(500));

    const result = await executeGetFlights(baseParams);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Skypicker");
  });

  it("returns error when API returns AppError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        data: {
          onewayItineraries: {
            __typename: "AppError",
            error: "Invalid origin"
          }
        }
      })
    );

    const result = await executeGetFlights(baseParams);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Invalid origin");
  });

  it("returns empty results when no itineraries found", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        data: {
          onewayItineraries: {
            __typename: "Itineraries",
            itineraries: []
          }
        }
      })
    );

    const result = await executeGetFlights(baseParams);
    const r = result as { results: unknown[] };
    expect(r.results).toHaveLength(0);
  });
});

// ── Hotels ───────────────────────────────────────────────────────────

describe("resolveHotelLocationKey", () => {
  it("resolves known city names", () => {
    expect(resolveHotelLocationKey("new york")).toBe("g60763");
    expect(resolveHotelLocationKey("Tokyo")).toBe("g298184");
    expect(resolveHotelLocationKey("  Paris  ")).toBe("g187147");
  });

  it("is case-insensitive", () => {
    expect(resolveHotelLocationKey("NEW YORK")).toBe("g60763");
    expect(resolveHotelLocationKey("London")).toBe("g186338");
  });

  it("passes through keys starting with g", () => {
    expect(resolveHotelLocationKey("g12345")).toBe("g12345");
  });

  it("returns null for unknown cities", () => {
    expect(resolveHotelLocationKey("smalltown")).toBeNull();
  });
});

describe("HOTEL_LOCATION_KEYS", () => {
  it("contains 60+ cities", () => {
    expect(Object.keys(HOTEL_LOCATION_KEYS).length).toBeGreaterThanOrEqual(60);
  });

  it("maps aliases to the same key", () => {
    expect(HOTEL_LOCATION_KEYS["new york"]).toBe(HOTEL_LOCATION_KEYS["nyc"]);
    expect(HOTEL_LOCATION_KEYS["los angeles"]).toBe(HOTEL_LOCATION_KEYS["la"]);
    expect(HOTEL_LOCATION_KEYS["san francisco"]).toBe(HOTEL_LOCATION_KEYS["sf"]);
  });
});

describe("executeGetHotels", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns hotel results for a valid city", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        result: {
          total_count: 500,
          list: [
            {
              key: "g60763-d1234",
              name: "Grand Hotel",
              accommodation_type: "Hotel",
              review_summary: { rating: 4.5, count: 1200 },
              price_ranges: { minimum: 150, maximum: 300 },
              mentions: ["Modern", "Business"],
              merchandising_labels: ["Best seller"]
            },
            {
              key: "g60763-d5678",
              name: "Budget Inn",
              accommodation_type: "Hostel",
              review_summary: { rating: 3.2, count: 200 },
              price_ranges: { minimum: 50, maximum: 80 }
            }
          ]
        }
      })
    );

    const result = await executeGetHotels({ city: "new york", limit: 10 });
    expect(result).toHaveProperty("city", "new york");
    expect(result).toHaveProperty("totalAvailable", 500);

    const r = result as { hotels: Array<{ name: string; rating: number; priceRange: string; tags: string[] }> };
    expect(r.hotels).toHaveLength(2);
    expect(r.hotels[0].name).toBe("Grand Hotel");
    expect(r.hotels[0].rating).toBe(4.5);
    expect(r.hotels[0].priceRange).toBe("$150-$300/night");
    expect(r.hotels[0].tags).toContain("Best seller");
  });

  it("filters by minPrice", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        result: {
          total_count: 2,
          list: [
            {
              key: "k1",
              name: "Cheap Hotel",
              accommodation_type: "Hotel",
              price_ranges: { minimum: 50, maximum: 80 }
            },
            {
              key: "k2",
              name: "Nice Hotel",
              accommodation_type: "Hotel",
              price_ranges: { minimum: 150, maximum: 250 }
            }
          ]
        }
      })
    );

    const result = await executeGetHotels({ city: "paris", limit: 10, minPrice: 100 });
    const r = result as { hotels: Array<{ name: string }> };
    expect(r.hotels).toHaveLength(1);
    expect(r.hotels[0].name).toBe("Nice Hotel");
  });

  it("filters by maxPrice", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        result: {
          total_count: 2,
          list: [
            {
              key: "k1",
              name: "Cheap Hotel",
              accommodation_type: "Hotel",
              price_ranges: { minimum: 50, maximum: 80 }
            },
            {
              key: "k2",
              name: "Expensive Hotel",
              accommodation_type: "Hotel",
              price_ranges: { minimum: 150, maximum: 400 }
            }
          ]
        }
      })
    );

    const result = await executeGetHotels({ city: "paris", limit: 10, maxPrice: 100 });
    const r = result as { hotels: Array<{ name: string }> };
    expect(r.hotels).toHaveLength(1);
    expect(r.hotels[0].name).toBe("Cheap Hotel");
  });

  it("filters by minRating", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        result: {
          total_count: 2,
          list: [
            {
              key: "k1",
              name: "Low Rated",
              accommodation_type: "Hotel",
              review_summary: { rating: 2.5, count: 50 },
              price_ranges: { minimum: 80, maximum: 120 }
            },
            {
              key: "k2",
              name: "Top Rated",
              accommodation_type: "Hotel",
              review_summary: { rating: 4.8, count: 500 },
              price_ranges: { minimum: 200, maximum: 350 }
            }
          ]
        }
      })
    );

    const result = await executeGetHotels({ city: "tokyo", limit: 10, minRating: 4.0 });
    const r = result as { hotels: Array<{ name: string }> };
    expect(r.hotels).toHaveLength(1);
    expect(r.hotels[0].name).toBe("Top Rated");
  });

  it("returns error for unsupported city", async () => {
    const result = await executeGetHotels({ city: "middle of nowhere", limit: 10 });
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("City not supported");
  });

  it("returns error when API fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(errorResponse(500));

    const result = await executeGetHotels({ city: "london", limit: 10 });
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Xotelo");
  });

  it("returns error when API returns error object", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ error: { message: "Rate limit exceeded" } })
    );

    const result = await executeGetHotels({ city: "london", limit: 10 });
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Rate limit exceeded");
  });

  it("handles hotels without price ranges or reviews", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        result: {
          total_count: 1,
          list: [
            {
              key: "k1",
              name: "Mystery Hotel",
              accommodation_type: "Hotel"
            }
          ]
        }
      })
    );

    const result = await executeGetHotels({ city: "rome", limit: 10 });
    const r = result as { hotels: Array<{ name: string; rating: null; priceRange: null }> };
    expect(r.hotels).toHaveLength(1);
    expect(r.hotels[0].rating).toBeNull();
    expect(r.hotels[0].priceRange).toBeNull();
  });
});

// ── Location (client-side) ───────────────────────────────────────────

describe("handleGetUserLocation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns location from browser geolocation + reverse geocode", async () => {
    // Mock navigator.geolocation
    const mockGeolocation = {
      getCurrentPosition: vi.fn((success: PositionCallback) => {
        success({
          coords: { latitude: 37.77, longitude: -122.42 }
        } as GeolocationPosition);
      })
    };
    vi.stubGlobal("navigator", { geolocation: mockGeolocation });

    // Mock nominatim reverse geocode
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        address: {
          city: "San Francisco",
          state: "California",
          country: "United States",
          country_code: "us"
        }
      })
    );

    const result = await handleGetUserLocation();
    expect(result.city).toBe("San Francisco");
    expect(result.country).toBe("United States");
    expect(result.countryCode).toBe("US");
    expect(result.latitude).toBe(37.77);
    expect(result.longitude).toBe(-122.42);
    expect(result.source).toBe("browser-geolocation");
  });

  it("returns coordinates when reverse geocode fails", async () => {
    const mockGeolocation = {
      getCurrentPosition: vi.fn((success: PositionCallback) => {
        success({
          coords: { latitude: 37.77, longitude: -122.42 }
        } as GeolocationPosition);
      })
    };
    vi.stubGlobal("navigator", { geolocation: mockGeolocation });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(errorResponse(500));

    const result = await handleGetUserLocation();
    expect(result.latitude).toBe(37.77);
    expect(result.longitude).toBe(-122.42);
    expect(result.source).toBe("browser-geolocation");
  });

  it("falls back to IP geolocation when browser geolocation fails", async () => {
    const mockGeolocation = {
      getCurrentPosition: vi.fn(
        (_success: PositionCallback, error?: PositionErrorCallback | null) => {
          error?.({
            code: 1,
            message: "User denied",
            PERMISSION_DENIED: 1,
            POSITION_UNAVAILABLE: 2,
            TIMEOUT: 3
          });
        }
      )
    };
    vi.stubGlobal("navigator", { geolocation: mockGeolocation });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        city: "Seattle",
        region: "Washington",
        country_name: "United States",
        country_code: "US",
        latitude: 47.6,
        longitude: -122.33
      })
    );

    const result = await handleGetUserLocation();
    expect(result.city).toBe("Seattle");
    expect(result.source).toBe("ip-geolocation");
  });

  it("returns error when both methods fail", async () => {
    const mockGeolocation = {
      getCurrentPosition: vi.fn(
        (_success: PositionCallback, error?: PositionErrorCallback | null) => {
          error?.({
            code: 1,
            message: "denied",
            PERMISSION_DENIED: 1,
            POSITION_UNAVAILABLE: 2,
            TIMEOUT: 3
          });
        }
      )
    };
    vi.stubGlobal("navigator", { geolocation: mockGeolocation });
    vi.stubGlobal("Intl", {
      DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: "America/Los_Angeles" }) })
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(errorResponse(500));

    const result = await handleGetUserLocation();
    expect(result.error).toBe("Could not determine location");
    expect(result.timezone).toBe("America/Los_Angeles");
  });
});
