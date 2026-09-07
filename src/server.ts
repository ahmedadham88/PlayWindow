import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest, type Schedule } from "agents";
import { getSchedulePrompt, scheduleSchema } from "agents/schedule";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool
} from "ai";
import { z } from "zod";
import {
  executeGetWeather,
  executeGetFlights,
  executeGetHotels,
  type ApiCredentials
} from "./tools";

export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  chatRecovery = true;
  // Wait for MCP connections to be re-established after hibernation before
  // processing a message, so MCP tools aren't intermittently missing.
  waitForMcpConnections = true;

  onStart() {
    // Configure OAuth popup behavior for MCP servers that require authentication
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });
  }

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    try {
    const creds: ApiCredentials = {
      serpApiKey: this.env.SERPAPI_KEY || undefined,
      liteApiKey: this.env.LITEAPI_KEY || undefined,
      stayingApiToken: this.env.STAYINGAPI_TOKEN || undefined
    };
    const mcpTools = this.mcp.getAITools();
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        sessionAffinity: this.sessionAffinity
      }),
      system: `You are Play Window, a travel assistant that helps users find the best flights, hotels, and weather-friendly destinations. You can also understand images, get the user's timezone, run calculations, and schedule tasks.

## Default behavior (unless the user explicitly asks otherwise)

1. **Get the user's location first.** If the user has not specified an origin, call getUserLocation before searching for flights so you know their nearest city/airport.
2. **Prioritise closest and cheapest options.** Search for destinations within roughly 5 hours of flying time from the user's location, sorted by lowest price.
3. **Weather-friendly destinations only.** Check the weather at candidate destinations and recommend only places where the forecast is sunny (clear or mostly clear skies) and moderate temperatures (roughly 18-30 °C / 65-85 °F). Exclude destinations with rain, storms, or extreme heat/cold in the travel window.
4. **Always include hotel suggestions.** When presenting flight options, also search for hotels at each destination and include accommodation details (name, nightly price range, rating) alongside the flight results.
5. **Provide booking links.** When the user expresses interest in an option (e.g. "I like that one", "book it", "tell me more"), provide the direct booking URL for the flight and, if available, the hotel URL so they can complete the reservation.

## Tool usage guidelines

- For flight searches, use airport codes (e.g. SFO, LAX, JFK) or city slugs. Use "anywhere" as the destination to discover the cheapest flights to any destination. Dates must be in YYYY-MM-DD format.
- For hotel searches, use city names like "new york", "tokyo", "paris", etc.
- When the user specifies a particular destination, budget, dates, or other preferences, honour those and override the defaults above.

${getSchedulePrompt({ date: new Date() })}

If the user asks to schedule a task, use the schedule tool to schedule the task.`,
      // Prune old tool calls and reasoning to save tokens on long conversations
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: {
        // MCP tools from connected servers
        ...mcpTools,

        // Server-side tool: runs automatically on the server
        getWeather: tool({
          description:
            "Get the current weather and forecast for a city. Returns current conditions plus a 7-day daily forecast. Powered by Open-Meteo (free, no API key).",
          inputSchema: z.object({
            city: z.string().describe("City name (e.g. 'Paris', 'Tokyo', 'New York')")
          }),
          execute: async (args) => {
            try { return await executeGetWeather(args); }
            catch (e) { return { error: `Weather lookup failed: ${e instanceof Error ? e.message : String(e)}` }; }
          }
        }),

        // Flight search via Kiwi/Skypicker GraphQL API (no API key required)
        getFlights: tool({
          description:
            "Search for flights between airports. Returns prices, times, airlines, stops, and booking links. Use airport codes (SFO, LAX, JFK) or 'anywhere' as destination to find cheapest flights to any destination.",
          inputSchema: z.object({
            origin: z
              .string()
              .describe("Origin airport code (e.g. 'SFO', 'JFK', 'LHR')"),
            destination: z
              .string()
              .default("anywhere")
              .describe(
                "Destination airport code or 'anywhere' for cheapest destinations"
              ),
            departureDate: z
              .string()
              .describe("Departure date in YYYY-MM-DD format"),
            returnDate: z
              .string()
              .optional()
              .describe(
                "Return date in YYYY-MM-DD format (omit for one-way)"
              ),
            maxStops: z
              .number()
              .int()
              .min(0)
              .max(3)
              .default(2)
              .describe("Maximum number of stops (0 = direct only)"),
            cabinClass: z
              .enum(["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"])
              .default("ECONOMY")
              .describe("Cabin class"),
            adults: z
              .number()
              .int()
              .min(1)
              .max(9)
              .default(1)
              .describe("Number of adult passengers"),
            maxPrice: z
              .number()
              .optional()
              .describe("Maximum price in USD"),
            limit: z
              .number()
              .int()
              .min(1)
              .max(20)
              .default(5)
              .describe("Number of results to return")
          }),
          execute: async (args) => {
            try { return await executeGetFlights(args, creds); }
            catch (e) { return { error: `Flight search failed: ${e instanceof Error ? e.message : String(e)}` }; }
          }
        }),

        // Hotel search via Xotelo API (TripAdvisor data, no API key required)
        getHotels: tool({
          description:
            "Search for hotels in a city. Returns hotel names, ratings, price ranges, and types. Supports 60+ major cities worldwide including New York, Tokyo, Paris, London, etc.",
          inputSchema: z.object({
            city: z
              .string()
              .describe(
                "City name (e.g. 'new york', 'tokyo', 'paris', 'london')"
              ),
            limit: z
              .number()
              .int()
              .min(1)
              .max(30)
              .default(10)
              .describe("Number of results to return"),
            minPrice: z
              .number()
              .optional()
              .describe("Minimum nightly price in USD"),
            maxPrice: z
              .number()
              .optional()
              .describe("Maximum nightly price in USD"),
            minRating: z
              .number()
              .min(0)
              .max(5)
              .optional()
              .describe("Minimum rating (0-5)")
          }),
          execute: async (args) => {
            try { return await executeGetHotels(args, creds); }
            catch (e) { return { error: `Hotel search failed: ${e instanceof Error ? e.message : String(e)}` }; }
          }
        }),

        // Client-side tools: no execute function — the browser handles them
        getUserLocation: tool({
          description:
            "Get the user's current location (city, country, coordinates) from their browser. Use this to determine the user's origin city/airport for flight searches when they don't specify one.",
          inputSchema: z.object({})
        }),

        getUserTimezone: tool({
          description:
            "Get the user's timezone from their browser. Use this when you need to know the user's local time.",
          inputSchema: z.object({})
        }),

        // Approval tool: requires user confirmation before executing
        calculate: tool({
          description:
            "Perform a math calculation with two numbers. Requires user approval for large numbers.",
          inputSchema: z.object({
            a: z.number().describe("First number"),
            b: z.number().describe("Second number"),
            operator: z
              .enum(["+", "-", "*", "/", "%"])
              .describe("Arithmetic operator")
          }),
          needsApproval: async ({ a, b }) =>
            Math.abs(a) > 1000 || Math.abs(b) > 1000,
          execute: async ({ a, b, operator }) => {
            const ops: Record<string, (x: number, y: number) => number> = {
              "+": (x, y) => x + y,
              "-": (x, y) => x - y,
              "*": (x, y) => x * y,
              "/": (x, y) => x / y,
              "%": (x, y) => x % y
            };
            if (operator === "/" && b === 0) {
              return { error: "Division by zero" };
            }
            return {
              expression: `${a} ${operator} ${b}`,
              result: ops[operator](a, b)
            };
          }
        }),

        scheduleTask: tool({
          description:
            "Schedule a task to be executed at a later time. Use this when the user asks to be reminded or wants something done later.",
          inputSchema: scheduleSchema,
          execute: async ({ when, description }) => {
            if (when.type === "no-schedule") {
              return "Not a valid schedule input";
            }
            const input =
              when.type === "scheduled"
                ? when.date
                : when.type === "delayed"
                  ? when.delayInSeconds
                  : when.type === "cron"
                    ? when.cron
                    : null;
            if (!input) return "Invalid schedule type";
            try {
              this.schedule(input, "executeTask", description, {
                idempotent: true
              });
              return `Task scheduled: "${description}" (${when.type}: ${input})`;
            } catch (error) {
              return `Error scheduling task: ${error}`;
            }
          }
        }),

        getScheduledTasks: tool({
          description: "List all tasks that have been scheduled",
          inputSchema: z.object({}),
          execute: async () => {
            const tasks = this.getSchedules();
            return tasks.length > 0 ? tasks : "No scheduled tasks found.";
          }
        }),

        cancelScheduledTask: tool({
          description: "Cancel a scheduled task by its ID",
          inputSchema: z.object({
            taskId: z.string().describe("The ID of the task to cancel")
          }),
          execute: async ({ taskId }) => {
            try {
              this.cancelSchedule(taskId);
              return `Task ${taskId} cancelled.`;
            } catch (error) {
              return `Error cancelling task: ${error}`;
            }
          }
        })
      },
      stopWhen: stepCountIs(20),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("onChatMessage error:", msg);
      // Return a readable error as a text stream so the user sees something
      return new Response(
        JSON.stringify({
          type: "error",
          error: { message: msg }
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }
  }

  async executeTask(description: string, _task: Schedule<string>) {
    // Do the actual work here (send email, call API, etc.)
    console.log(`Executing scheduled task: ${description}`);

    // Notify connected clients via a broadcast event.
    // We use broadcast() instead of saveMessages() to avoid injecting
    // into chat history — that would cause the AI to see the notification
    // as new context and potentially loop.
    this.broadcast(
      JSON.stringify({
        type: "scheduled-task",
        description,
        timestamp: new Date().toISOString()
      })
    );
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
