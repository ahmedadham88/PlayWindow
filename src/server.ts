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
    // Pre-check: test the AI binding with a tiny request to catch quota errors early
    try {
      await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1
      });
    } catch (preCheckError) {
      const msg = preCheckError instanceof Error ? preCheckError.message : String(preCheckError);
      console.error("AI pre-check failed:", msg);
      return this.createErrorResponse(msg);
    }

    const mcpTools = this.mcp.getAITools();
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        sessionAffinity: this.sessionAffinity
      }),
      system: `You are Play Window, a friendly and verbose travel assistant. You help users find flights, hotels, and weather-friendly destinations.

## CRITICAL: Always talk to the user while working

**NEVER go silent.** Before calling any tool, ALWAYS write a short message to the user explaining what you're about to do. For example:
- "Let me find your location first..."
- "Searching for cheap flights from Toronto next week..."
- "Checking the weather in a few popular destinations..."
- "Looking up hotels in Barcelona for you..."

After each tool result, briefly share what you found before moving to the next step. Do NOT call multiple tools silently — narrate your progress so the user knows you're working.

## How to handle open-ended requests (e.g. "find me sunny destinations")

When the user asks for destination suggestions without specifying where, work **step by step** and narrate each step:

1. First, get the user's location (call getUserLocation). Tell them: "Let me find where you're located..."
2. Then search for cheap flights using "anywhere" as destination. Tell them: "Searching for the cheapest flights from [city]..."
3. Pick 2-3 of the cheapest destinations and check their weather. Tell them: "Let me check the weather at these destinations..."
4. Present the results with weather, flight prices, and suggest the best options.
5. Only search for hotels AFTER the user shows interest in a specific destination — don't search hotels for all destinations upfront.

## Preferences (unless the user says otherwise)

- Prioritise closest and cheapest options within ~5 hours flight time.
- Recommend only destinations with sunny/clear weather and moderate temps (18-30°C).
- When the user picks a destination, search for hotels there and include them.
- When the user wants to book, provide the direct booking URL.

## Tool usage

- Flight searches: use airport codes (SFO, LAX, JFK) or city slugs. "anywhere" for cheapest destinations. Dates in YYYY-MM-DD format.
- Hotel searches: use city names like "new york", "tokyo", "paris".
- If a tool returns an error, tell the user what happened and suggest an alternative (e.g. "The flight search API is temporarily down, let me try a different approach...").

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

    // Consume the stream to detect errors before returning
    // If the first chunk fails (e.g. quota exceeded), we catch it here
    try {
      // Force the stream to start so errors surface immediately
      const response = result.toUIMessageStreamResponse({
        sendReasoning: true
      });
      return response;
    } catch (streamError) {
      const errMsg = streamError instanceof Error ? streamError.message : String(streamError);
      console.error("Stream error:", errMsg);
      return this.createErrorResponse(errMsg);
    }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error("onChatMessage error:", errMsg);
      return this.createErrorResponse(errMsg);
    }
  }

  private async createErrorResponse(errMsg: string) {
    const errorText = errMsg.includes("neurons") || errMsg.includes("4006")
      ? "I'm temporarily unavailable — the daily Cloudflare AI usage quota has been reached. Please try again later or upgrade to the Workers Paid plan."
      : errMsg.includes("not available on the Workers Free plan")
        ? "This AI model requires a Workers Paid plan. Please upgrade at https://dash.cloudflare.com"
        : `Something went wrong: ${errMsg}`;

    await this.saveMessages([
      ...this.messages,
      {
        id: `error-${Date.now()}`,
        role: "assistant" as const,
        parts: [{ type: "text" as const, text: errorText }]
      } as (typeof this.messages)[number]
    ]);

    return new Response("data: done\n\n", {
      headers: { "Content-Type": "text/event-stream" }
    });
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
