# Play Window — Build Session Prompt History

This document captures the full prompt history from the Claude Code session that built the Play Window application.

---

## 1. Install Weather MCP

**Prompt:** Install https://github.com/weather-mcp/weather-mcp MCP into the project to be used for knowing weather forecasts

**What happened:** Created `.mcp.json` at the project root configuring the weather MCP server via `npx @dangahagan/weather-mcp`. No API keys required — uses free public APIs (NOAA, Open-Meteo).

---

## 2. Clarification — MCP for the app chat

**Prompt:** It could be used by the user within the application chat as well if I configure it to do so

**What happened:** Discovered that `weather-mcp` is stdio-based (not HTTP/SSE), so it can't be added via the app's MCP URL panel directly. Discussed options: deploying as a remote server vs replacing the mock `getWeather` tool with real API calls.

---

## 3. Replace mock weather with real API

**Prompt:** Replace the mock getWeather tool with real Open-Meteo API calls

**What happened:** Replaced the random-data `getWeather` tool in `server.ts` with real Open-Meteo API calls:
- Geocodes city name via `geocoding-api.open-meteo.com`
- Fetches current conditions + 7-day forecast
- Maps WMO weather codes to human-readable descriptions
- Returns temperature, feels-like, humidity, wind, and daily forecast

---

## 4. Add flights and hotels tools

**Prompt:** Create getFlights and getHotels tools, that can utilize open APIs of https://github.com/wolfiesch/flightfinder for searching for flights and hotels.

**What happened:** Studied the flightfinder repo's source code to understand the underlying APIs:
- **Flights:** Kiwi/Skypicker GraphQL API at `api.skypicker.com` — supports one-way, round-trip, and "anywhere" searches
- **Hotels:** Xotelo API at `data.xotelo.com` — TripAdvisor data with 60+ city location key mappings

Implemented both as server-side tools with full parameter support (cabin class, stops, price filters, rating filters, etc.).

---

## 5. Rebrand and welcome message

**Prompt:** Change the Agent Starter AI Chat wording to Play Window - Your Agent for finding best flights, accommodation for instant weather friendly destinations. Rephrase and add welcome message...

**What happened:** Updated `app.tsx`:
- Header: "Agent Starter" → "Play Window" with plane emoji
- Badge: "AI Chat" → "Flights, Hotels & Weather"
- Welcome screen with description and 4 travel-focused quick prompts

---

## 6. Add user location detection

**Prompt:** Get Users location from the browser or IP for easily knowing the source city for travels

**What happened:** Added `getUserLocation` as a client-side tool:
- Primary: Browser Geolocation API (precise, requires permission)
- Fallback: IP geolocation via `ipapi.co` (no permission needed)
- Reverse geocoding via Nominatim for city/country names
- Updated system prompt to auto-call this when user doesn't specify origin

---

## 7. Add unit tests

**Prompt:** Add unit tests to the app module, server model with all the added tools for weather, location, flights and accommodation. Adjust the package.json commands to run the tests on builds.

**What happened:**
- Installed vitest, @testing-library/react, jsdom
- Extracted tool execute functions into `src/tools.ts` for testability
- Created `tests/tools.test.ts` with 34 tests covering all tools
- Created separate `vitest.config.ts` (Cloudflare Vite plugin conflicts with vitest)
- Updated `package.json`: added `test`, `test:watch` scripts; `deploy` and `check` now run tests first

---

## 8. Add agent context/rules

**Prompt:** Add a context file for guiding the agent, include in it these rules: Unless specified by the user explicitly, search for closest and cheapest options, within 5 hours flight...

**What happened:** Updated the system prompt in `server.ts` with default behavior rules:
1. Get user's location first
2. Prioritize closest and cheapest (within ~5 hours flight)
3. Weather-friendly only (sunny, 18-30°C)
4. Always include hotel suggestions with flights
5. Provide booking links on interest

---

## 9. Run locally and debug

**Prompt:** run locally, and tell me on which port should I access localhost

**What happened:** Started dev server at `http://localhost:5173/`.

---

## 10. Debug — no reply to prompts

**Prompt:** Submitted the prompt with no reply. Adjust it to keep the user engaged into what's happening with thinking in the background. Debug why it did not work.

**What happened:** Multi-step debugging session using Playwright:

1. **First issue:** Model `@cf/moonshotai/kimi-k2.7-code` not available on Workers Free plan → Switched to `@cf/meta/llama-3.3-70b-instruct-fp8-fast`

2. **Second issue:** `getFlights` tool erroring repeatedly ("An error occurred" x15+). Root cause: Skypicker API blocks requests from Cloudflare Worker IPs (the DO runs remotely). API works from curl but not from CF infrastructure.

3. **Third issue:** Daily free neuron quota (10,000) exhausted from the error retry loops.

**Fixes applied:**
- Changed model to free-tier compatible
- Added try/catch at both `tools.ts` and `server.ts` levels
- Added `User-Agent` headers to API calls
- Wrapped `onChatMessage` in try/catch to surface model errors
- Attempted client-side tool execution (discovered framework doesn't support complex client-side tools)

---

## 11. Search for backup APIs

**Prompt:** Search for other open APIs that searches for flights and accommodation, I dont want to depend on only one, there should be backups

**What happened:** Researched alternatives using a subagent. Key findings:

**Flights:**
- Amadeus Self-Service API (later discovered shut down July 2026)
- SerpAPI Google Flights — 250 free searches/month
- Bright Data — 5,000 free/month
- OctoTrip — completely free

**Hotels:**
- StayingAPI — 300 free credits, aggregates Airbnb/Booking/Vrbo
- LiteAPI — free sandbox, 3M+ properties
- Stay22 — paused for rebuilding

---

## 12. Integrate fallback APIs

**Prompt:** Yes (to integrating the recommended APIs)

**What happened:** Implemented fallback chain architecture:
- Extracted Skypicker logic into `searchFlightsSkypicker()`
- Added `searchFlightsAmadeus()` (later replaced)
- Added `searchHotelsStaying()` with async job polling
- Created orchestrators: `executeGetFlights()` and `executeGetHotels()` that cascade through providers
- Added `ApiCredentials` interface for env-based API keys

---

## 13. Amadeus shutdown correction

**Prompt:** Amadeus no longer offers a free tier or self-service access, as the company officially shut down the Amadeus for Developers Self-Service portal...

**What happened:** Replaced Amadeus with SerpAPI Google Flights as the flight fallback.

---

## 14. LiteAPI integration + Stay22 check

**Prompt:** Check https://dev.stay22.com/docs/api and https://liteapi.travel/

**What happened:**
- Stay22: API paused, not available for new integrations
- LiteAPI: Full REST API with flights (`POST /flights/rates`) and hotels (`GET /data/hotels`), free sandbox, 3M+ properties

---

## 15. Configure LiteAPI with credentials

**Prompt:** API Key sand_ab343353-171c-40fe-bb5c-219941bb04ac... https://docs.liteapi.travel/reference/overview (Flight and Hotels) setup env

**What happened:**
- Set `LITEAPI_KEY` in `wrangler.jsonc`
- Added `searchFlightsLiteApi()` — POST to `/flights/rates` with legs, adults, currency, filters
- Added `searchHotelsLiteApi()` — GET `/data/hotels` with city name
- Updated orchestrators to 3-tier chains:
  - Flights: Skypicker → LiteAPI → SerpAPI
  - Hotels: Xotelo → LiteAPI → StayingAPI
- All 34 tests passing

---

## 16. Run locally (again)

**Prompt:** run locally

**What happened:** Started fresh dev server at `http://localhost:5173/`. Note: neuron quota may still be exhausted from earlier debugging.

---

## 17. Update README

**Prompt:** update readme, and mention accessibility through https://cf-playwindow.ahmed-adham88.workers.dev/

**What happened:** Complete README rewrite covering:
- Live URL
- Feature overview with example prompts
- Project structure
- All 7 tools documented
- API fallback chain tables
- Configuration guide for API keys
- Scripts reference
- Deploy instructions

---

## 18. Save prompt history

**Prompt:** save this prompt history into an md file in this project

**What happened:** Created this file.

---

## Architecture Summary

```
User (Browser)
  ├── getUserLocation (client-side: geolocation + IP fallback)
  ├── getUserTimezone (client-side: Intl API)
  └── WebSocket → Cloudflare Durable Object (remote)
        ├── AI Model: @cf/meta/llama-3.3-70b-instruct-fp8-fast
        ├── getWeather → Open-Meteo API (free, no key)
        ├── getFlights → Skypicker → LiteAPI → SerpAPI
        ├── getHotels → Xotelo → LiteAPI → StayingAPI
        ├── calculate (with approval)
        └── scheduleTask / getScheduledTasks / cancelScheduledTask
```

## Key Files Modified

| File | Changes |
|------|---------|
| `src/server.ts` | Model, system prompt, tool definitions, error handling, credentials |
| `src/tools.ts` | New file — all tool execute functions with fallback chains |
| `src/app.tsx` | Branding, welcome screen, client-side tool handlers |
| `tests/tools.test.ts` | New file — 34 unit tests |
| `vitest.config.ts` | New file — test config (separate from Vite) |
| `package.json` | Test scripts, dev dependencies |
| `wrangler.jsonc` | API key env vars |
| `.mcp.json` | Weather MCP server config |
| `README.md` | Complete rewrite |
