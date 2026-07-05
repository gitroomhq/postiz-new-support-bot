// Read-only Stripe MCP server, spawned by the Claude Code CLI for admin
// /ai runs (stdio transport). This process intentionally contains ZERO
// write tools — even a prompt-injected model cannot mutate Stripe here.
//
// stdout is the MCP protocol channel: never console.log in this file,
// diagnostics go to stderr only. Sentry DSN arrives via env (SENTRY_DSN)
// because the DSN lives in BotSettings, not in the deploy .env.
import * as Sentry from "@sentry/node";
import { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z, ZodRawShape } from "zod";
import { StripeClient } from "../bot/StripeClient";
import { BotConfig } from "../config";
import { Logger } from "../util/logger";

// stream: "stderr" — every level must stay off the stdout protocol channel.
const mcpLog = new Logger("mcp:stripe", {}, { stream: "stderr" });

const secretKey = process.env.STRIPE_SECRET_KEY;
if (!secretKey) {
  mcpLog.error("STRIPE_SECRET_KEY missing");
  process.exit(1);
}

const sentryDsn = process.env.SENTRY_DSN;
if (sentryDsn) {
  try {
    // dsn / environment / release / debug / tracesSampleRate AND the parent
    // trace (SENTRY_TRACE / SENTRY_BAGGAGE) are all consumed from env by the
    // SDK — set by DiscordBot.buildAiRunConfig. The process is spawned with
    // `--require @sentry/node/preload`, so Stripe's HTTPS calls get spans.
    Sentry.init({ serverName: "stripe-readonly-mcp", enableLogs: true });
  } catch (e) {
    mcpLog.error("Sentry init failed", e);
  }
}

const recordAiContent = process.env.SENTRY_AI_RECORD_CONTENT === "1";

// Flush buffered events before the CLI reaps the process at run end.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void Sentry.close(1000)
      .catch(() => {})
      .finally(() => process.exit(0));
  });
}

// StripeClient only reads config.stripe.* — a minimal config is sufficient.
const stripe = new StripeClient({ stripe: { secretKey } } as unknown as BotConfig);

// The wrapper emits one MCP-convention span per tool call/protocol event.
// Tool inputs are Stripe ids (safe); outputs carry customer PII, so they are
// only recorded when the /config AI-content toggle is on.
const server = Sentry.wrapMcpServerWithSentry(new McpServer({ name: "stripe-readonly", version: "1.0.0" }), {
  recordInputs: true,
  recordOutputs: recordAiContent,
});

function readTool<Shape extends ZodRawShape>(
  name: string,
  description: string,
  shape: Shape,
  handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<unknown>
): void {
  server.registerTool(
    name,
    {
      description,
      inputSchema: shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    // args are validated against `shape` by the SDK before reaching here; the
    // cast bridges the SDK's conditional ToolCallback type, which TS cannot
    // resolve for an unbound generic Shape.
    (async (args: unknown) => {
      try {
        const value = await handler(args as z.infer<z.ZodObject<Shape>>);
        return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // Logger.error captures the exception (tool name in the log context);
        // the Sentry MCP wrapper additionally marks the tool span as failed.
        mcpLog.error("tool failed", e, { "mcp.tool": name });
        return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
      }
    }) as unknown as ToolCallback<Shape>
  );
}

readTool(
  "get_customer",
  "Fetch a Stripe customer by id (cus_...). Returns null if deleted/missing.",
  { customerId: z.string() },
  ({ customerId }) => stripe.getCustomer(customerId)
);

readTool(
  "find_customers_by_email",
  "Find Stripe customers by exact email address.",
  { email: z.string() },
  ({ email }) => stripe.findCustomersByEmail(email)
);

readTool(
  "list_subscriptions",
  "List all subscriptions (any status) of a customer.",
  { customerId: z.string() },
  ({ customerId }) => stripe.listSubscriptions(customerId)
);

readTool(
  "get_subscription",
  "Fetch a subscription by id (sub_...).",
  { subscriptionId: z.string() },
  ({ subscriptionId }) => stripe.getSubscription(subscriptionId)
);

readTool(
  "list_invoices",
  "List recent invoices of a customer (newest first).",
  { customerId: z.string(), limit: z.number().int().min(1).max(100).optional() },
  ({ customerId, limit }) => stripe.listInvoices(customerId, limit ?? 10)
);

readTool(
  "list_charges",
  "List recent charges of a customer (newest first).",
  { customerId: z.string(), limit: z.number().int().min(1).max(100).optional() },
  ({ customerId, limit }) => stripe.listCharges(customerId, limit ?? 10)
);

readTool(
  "get_charge",
  "Fetch a charge by id (ch_...).",
  { chargeId: z.string() },
  ({ chargeId }) => stripe.getCharge(chargeId)
);

readTool(
  "list_payment_intents",
  "List PaymentIntents of a customer — includes declined/abandoned attempts that never became charges.",
  { customerId: z.string(), limit: z.number().int().min(1).max(100).optional() },
  ({ customerId, limit }) => stripe.listPaymentIntents(customerId, limit ?? 100)
);

readTool(
  "get_dispute_for_charge",
  "Fetch the dispute attached to a charge, if any.",
  { chargeId: z.string() },
  ({ chargeId }) => stripe.getDisputeForCharge(chargeId)
);

readTool(
  "list_customer_cards",
  "List saved card payment methods of a customer (brand, last4, expiry — no full numbers).",
  { customerId: z.string() },
  ({ customerId }) => stripe.listCustomerCards(customerId)
);

readTool(
  "list_tax_ids",
  "List tax IDs of a customer.",
  { customerId: z.string() },
  ({ customerId }) => stripe.listTaxIds(customerId)
);

server
  .connect(new StdioServerTransport())
  .catch(async (e) => {
    mcpLog.error("failed to start", e);
    if (sentryDsn) {
      Sentry.captureException(e);
      await Sentry.flush(2000).catch(() => {});
    }
    process.exit(1);
  });
