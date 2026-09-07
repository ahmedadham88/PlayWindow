# Play Window

Your AI travel agent for finding the best flights, accommodation, and weather-friendly destinations — all from a single chat interface.

**Live:** [playwindow.ahmed-adham88.workers.dev](https://playwindow.ahmed-adham88.workers.dev/)

Built on Cloudflare Workers with the [Agents SDK](https://developers.cloudflare.com/agents/), powered by Workers AI.

## What it does

Ask Play Window to plan a trip and it will:

1. **Detect your location** automatically (browser geolocation or IP)
2. **Check the weather** at candidate destinations via Open-Meteo
3. **Search for flights** via Kiwi/Skypicker with LiteAPI and SerpAPI as fallbacks
4. **Find hotels** via Xotelo with LiteAPI and StayingAPI as fallbacks
5. **Recommend only sunny, moderate-temperature destinations** within ~5 hours of your location
6. **Provide booking links** when you pick an option

Try these prompts:

- **"Find me sunny destinations with cheap flights next week"**
- **"What's the weather like in Barcelona?"**
- **"Search flights from SFO to Tokyo"**
- **"Find hotels in Paris under $200/night"**

## Quick start

```bash
git clone <repo-url>
cd cf-playwindow
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) to use the app locally.

> **Cloudflare authentication required.** The app uses Workers AI with remote inference,
> so `npm run dev` needs a Cloudflare login. Run `wrangler login` once, or set
> `CLOUDFLARE_API_TOKEN` in a `.env` file.

## Project structure

```
src/
  server.ts    # Chat agent with tool definitions and system prompt
  tools.ts     # Tool execute functions (weather, flights, hotels, location)
  app.tsx      # Chat UI with client-side tool handlers
  client.tsx   # React entry point
  styles.css   # Tailwind + Kumo styles
tests/
  tools.test.ts  # 34 unit tests covering all tools
```

## Tools

| Tool | Type | Description |
|------|------|-------------|
| `getWeather` | Server | Current conditions + 7-day forecast via Open-Meteo |
| `getFlights` | Server | Flight search with fallback chain: Skypicker → LiteAPI → SerpAPI |
| `getHotels` | Server | Hotel search with fallback chain: Xotelo → LiteAPI → StayingAPI |
| `getUserLocation` | Client | Browser geolocation with IP fallback |
| `getUserTimezone` | Client | Browser timezone detection |
| `calculate` | Approval | Math with user confirmation for large numbers |
| `scheduleTask` | Server | One-time, delayed, and cron scheduling |

## API fallback chains

The app tries free APIs first, then falls back to keyed providers if configured.

### Flights

| Order | Provider | Auth | Notes |
|-------|----------|------|-------|
| 1 | Kiwi/Skypicker | None | Supports "anywhere" search |
| 2 | LiteAPI | `LITEAPI_KEY` | 3M+ routes, real-time pricing |
| 3 | SerpAPI | `SERPAPI_KEY` | Google Flights data (250 free/mo) |

### Hotels

| Order | Provider | Auth | Notes |
|-------|----------|------|-------|
| 1 | Xotelo | None | TripAdvisor data, 60+ cities |
| 2 | LiteAPI | `LITEAPI_KEY` | 3M+ properties worldwide |
| 3 | StayingAPI | `STAYINGAPI_TOKEN` | Airbnb, Booking, Vrbo, Google |

## Configuration

Set fallback API keys in `wrangler.jsonc` (vars) or as Cloudflare secrets:

```jsonc
"vars": {
  "SERPAPI_KEY": "",        // serpapi.com — 250 free searches/month
  "LITEAPI_KEY": "",        // liteapi.travel — free sandbox
  "STAYINGAPI_TOKEN": ""    // stayingapi.com — 300 free credits
}
```

The app works without any keys (using Skypicker + Xotelo), but fallbacks improve reliability.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start local dev server |
| `npm test` | Run unit tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run deploy` | Run tests, build, and deploy to Cloudflare |
| `npm run check` | Run tests, formatting, linting, and type-checking |

## MCP servers

The app supports connecting external MCP servers at runtime via the UI. Click the **MCP** button in the header to add/remove servers by URL.

## Deploy

```bash
npm run deploy
```

Your agent is live on Cloudflare's global network. Messages persist in SQLite, streams resume on disconnect, and the agent hibernates when idle.

## Learn more

- [Agents SDK documentation](https://developers.cloudflare.com/agents/)
- [Build a chat agent tutorial](https://developers.cloudflare.com/agents/getting-started/build-a-chat-agent/)
- [Workers AI models](https://developers.cloudflare.com/workers-ai/models/)

## License

MIT
