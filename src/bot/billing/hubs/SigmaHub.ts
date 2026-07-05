import {
  ActionRowBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import type Stripe from "stripe";
import { SigmaAdhocUnavailableError, type SigmaAdhocQuery } from "../../StripeClient";
import { embed as makeEmbed, COLORS } from "../../../util/embeds";
import { backRow, btn, buttonRow, selectRow, stripeErrorEmbed, textInput } from "../ui";
import type { Panel, RenderInteraction, RouteEntry } from "../types";
import type { HubContext } from "./HubContext";

// Sigma hub: read access to Stripe's analytics warehouse from Discord.
// Scheduled query runs (defined in Dashboard → Sigma) are listed, inspected
// and their result CSVs downloaded; ad-hoc SQL is a best-effort probe of an
// endpoint Stripe does not expose in the public SDK (SigmaAdhocUnavailableError
// turns into a friendly explanation).
//
// Self-contained by design (PaymentsHub pattern): registers `billadmin_hub:sigma`
// as an EXACT button route so it beats the facade's `billadmin_hub:` prefix
// route, and keeps its flow state in a hub-private side map keyed by the shared
// session token.

interface SigFlow {
  // Forward-only cursor chain for the runs list pager (ChargesHub pattern).
  cursors: (string | undefined)[];
  // Last rendered list page — Back-to-list from a run detail returns here.
  page: number;
  runId?: string;
  run?: Stripe.Sigma.ScheduledQueryRun;
}

const RUNS_PER_PAGE = 25;
const EXPIRY_WARN_S = 3 * 24 * 60 * 60;
const ADHOC_POLL_MS = 2_000;
const ADHOC_TIMEOUT_MS = 60_000;
const ADHOC_FAILED_STATUSES = ["failed", "canceled", "cancelled", "timed_out", "error"];

export class SigmaHub {
  // Extra per-token state that doesn't fit the shared BillAdminSession. Entries
  // are dropped alongside their session (see newFlow's sweep).
  private flows = new Map<string, SigFlow>();

  constructor(private ctx: HubContext) {}

  readonly routes: RouteEntry[] = [
    // Exact hub navigation — beats the facade's `billadmin_hub:` prefix route.
    {
      kind: "button",
      id: "billadmin_hub:sigma",
      match: "exact",
      handler: async (interaction) => {
        await interaction.update(this.buildPanel());
      },
    },
    // Scheduled runs list: `billadmin_sig_list:new` (from the hub panel, opens
    // a fresh session) or `billadmin_sig_list:<token>:<page>` (pager / back).
    {
      kind: "button",
      id: "billadmin_sig_list:",
      match: "prefix",
      handler: async (interaction) => {
        const [, tokenPart, pageStr] = interaction.customId.split(":");
        let token = tokenPart;
        let page = 0;
        if (tokenPart === "new") {
          token = this.ctx.sessions.newSession(interaction, {});
          this.newFlow(token);
        } else {
          const session = await this.ctx.sessions.getOwnedSession(token, interaction);
          if (!session) return;
          page = Math.max(0, Number.parseInt(pageStr, 10) || 0);
        }
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, () => this.renderList(interaction, token, page));
      },
    },
    // Pick a run from the list select → run detail.
    {
      kind: "select",
      id: "billadmin_sig_pick:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        this.flow(token).runId = interaction.values[0];
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, () => this.renderRunDetail(interaction, token));
      },
    },
    // Run detail (also serves as 🔄 Refresh — it always re-retrieves the run).
    {
      kind: "button",
      id: "billadmin_sig_run:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, () => this.renderRunDetail(interaction, token));
      },
    },
    // Download the run's result CSV: monospace preview + full file attached.
    {
      kind: "button",
      id: "billadmin_sig_fetch:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, () => this.fetchResults(interaction, token));
      },
    },
    // Ad-hoc SQL: button opens the modal (a fresh session carries the token).
    {
      kind: "button",
      id: "billadmin_sig_adhoc",
      match: "exact",
      handler: async (interaction) => {
        const token = this.ctx.sessions.newSession(interaction, {});
        this.newFlow(token);
        await interaction.showModal(this.buildAdhocModal(token));
      },
    },
    {
      kind: "modal",
      id: "billadmin_sig_adhoc_modal:",
      match: "prefix",
      handler: (interaction) => this.handleAdhocModal(interaction),
    },
  ];

  // ---- hub panel ----

  buildPanel(): Panel {
    const embed = new EmbedBuilder()
      .setTitle("📊 Sigma")
      .setColor(COLORS.brand)
      .setDescription(
        [
          "Sigma queries run against Stripe's analytics warehouse — data lags live by several hours. " +
            "Scheduled queries are defined in the Stripe Dashboard → Sigma; the bot fetches their latest runs.",
          "",
          "**Scheduled query runs** — list runs, inspect SQL & status, download result CSVs.",
          "**Ad-hoc SQL** — probe the (non-public) ad-hoc query API; falls back to an explanation if unavailable.",
        ].join("\n")
      );
    return {
      embeds: [embed],
      components: [
        buttonRow(
          btn("billadmin_sig_list:new", "📋 Scheduled query runs", ButtonStyle.Primary),
          btn("billadmin_sig_adhoc", "⚡ Ad-hoc SQL…", ButtonStyle.Primary)
        ),
        backRow("billadmin_root"),
      ],
    };
  }

  // ---- flow state ----

  private newFlow(token: string): SigFlow {
    // Sweep entries whose session is gone (expired + pruned, or never ours).
    for (const staleToken of this.flows.keys()) {
      if (!this.ctx.sessions.get(staleToken)) this.flows.delete(staleToken);
    }
    const flow: SigFlow = { cursors: [undefined], page: 0 };
    this.flows.set(token, flow);
    return flow;
  }

  private flow(token: string): SigFlow {
    return this.flows.get(token) ?? this.newFlow(token);
  }

  // ---- scheduled runs list ----

  private async renderList(interaction: RenderInteraction, token: string, page: number): Promise<void> {
    const flow = this.flow(token);
    if (page >= flow.cursors.length) page = Math.max(0, flow.cursors.length - 1);

    const res = await this.ctx.stripe.listSigmaScheduledQueryRuns(RUNS_PER_PAGE, flow.cursors[page]);
    const last = res.data[res.data.length - 1];
    if (res.has_more && last) flow.cursors[page + 1] = last.id;
    flow.page = page;

    const lines = res.data.map(
      (run) =>
        `${this.statusEmoji(run.status)} **${this.runLabel(run)}** · <t:${run.created}:R>${this.expiryNote(run)}`
    );

    const embed = new EmbedBuilder()
      .setTitle("📊 Sigma — scheduled query runs")
      .setColor(COLORS.brand)
      .setDescription(
        lines.join("\n").slice(0, 4096) ||
          "No scheduled query runs found — schedule a query in the Stripe Dashboard → Sigma first."
      )
      .setFooter({ text: `Page ${page + 1} · data lags live by several hours` });

    const components: Panel["components"] = [];
    if (res.data.length > 0) {
      const select = new StringSelectMenuBuilder()
        .setCustomId(`billadmin_sig_pick:${token}`)
        .setPlaceholder("Pick a run to inspect")
        .addOptions(
          res.data.slice(0, 25).map((run) => ({
            label: this.runLabel(run).slice(0, 100),
            description: `${run.id} · ${run.status}`.slice(0, 100),
            value: run.id,
          }))
        );
      components.push(selectRow(select));
    }
    components.push(
      buttonRow(
        btn(`billadmin_sig_list:${token}:${page - 1}`, "◀ Prev", ButtonStyle.Secondary, page <= 0),
        btn(`billadmin_sig_list:${token}:${page + 1}`, "Next ▶", ButtonStyle.Secondary, !res.has_more),
        btn("billadmin_hub:sigma", "Back", ButtonStyle.Secondary)
      )
    );

    await interaction.editReply({ embeds: [embed], components });
  }

  private statusEmoji(status: string): string {
    switch (status) {
      case "completed":
        return "✅";
      case "failed":
        return "❌";
      case "timed_out":
        return "⏱";
      case "canceled":
        return "🚫";
      default:
        return "❔";
    }
  }

  // title is nullable on the wire — fall back to the first ~50 chars of SQL.
  private runLabel(run: Stripe.Sigma.ScheduledQueryRun): string {
    const title = (run.title ?? "").trim();
    return title || run.sql.replace(/\s+/g, " ").slice(0, 50) || run.id;
  }

  private expiryNote(run: Stripe.Sigma.ScheduledQueryRun): string {
    const now = Math.floor(Date.now() / 1000);
    if (run.result_available_until <= now) return " · ⚠️ results expired";
    if (run.result_available_until - now < EXPIRY_WARN_S) {
      return ` · ⚠️ results expire <t:${run.result_available_until}:R>`;
    }
    return "";
  }

  // ---- run detail ----

  private async renderRunDetail(interaction: RenderInteraction, token: string): Promise<void> {
    const flow = this.flow(token);
    if (!flow.runId) {
      await interaction.editReply({
        embeds: [makeEmbed("No run selected — pick one from the list.", COLORS.warn)],
        components: [backRow("billadmin_hub:sigma")],
      });
      return;
    }
    const run = await this.ctx.stripe.getSigmaScheduledQueryRun(flow.runId);
    flow.run = run;

    const sql = run.sql.length > 1200 ? `${run.sql.slice(0, 1200)}\n… (truncated)` : run.sql;
    const embed = new EmbedBuilder()
      .setTitle(`${this.statusEmoji(run.status)} ${this.runLabel(run).slice(0, 240)}`)
      .setColor(run.status === "completed" ? COLORS.brand : run.status === "failed" ? COLORS.danger : COLORS.warn)
      .setDescription(
        [
          run.error?.message ? `❌ **Error:** ${run.error.message.slice(0, 500)}` : null,
          "```sql",
          sql,
          "```",
        ]
          .filter((line): line is string => line !== null)
          .join("\n")
          .slice(0, 4096)
      )
      .addFields(
        { name: "Run", value: `\`${run.id}\``, inline: true },
        { name: "Status", value: run.status, inline: true },
        { name: "Created", value: `<t:${run.created}:f>`, inline: true },
        { name: "Data as of", value: `<t:${run.data_load_time}:f>`, inline: true },
        {
          name: "Results available until",
          value: `<t:${run.result_available_until}:f>${this.expiryNote(run) ? " ⚠️" : ""}`,
          inline: true,
        },
        { name: "Result file", value: run.file ? `\`${run.file.id}\`` : "—", inline: true }
      );

    const canFetch = run.status === "completed" && !!run.file;
    await interaction.editReply({
      embeds: [embed],
      components: [
        buttonRow(
          btn(`billadmin_sig_fetch:${token}`, "📥 Fetch results", ButtonStyle.Primary, !canFetch),
          btn(`billadmin_sig_run:${token}`, "🔄 Refresh", ButtonStyle.Secondary),
          btn(`billadmin_sig_list:${token}:${flow.page}`, "◀ Back to list", ButtonStyle.Secondary)
        ),
      ],
    });
  }

  // ---- fetch results (preview + full CSV attachment) ----

  private async fetchResults(interaction: ButtonInteraction, token: string): Promise<void> {
    const flow = this.flow(token);
    const run = flow.run;
    if (!run || run.status !== "completed" || !run.file) {
      await interaction.editReply({
        embeds: [makeEmbed("This run has no downloadable results (not completed, or no result file).", COLORS.warn)],
        components: [backRow("billadmin_hub:sigma")],
      });
      return;
    }

    const dl = await this.ctx.stripe.downloadFileContents(run.file.id);
    const preview = this.buildCsvPreview(dl.body.toString("utf8"), dl.truncated);

    const embed = new EmbedBuilder()
      .setTitle(`📥 Results — ${this.runLabel(run).slice(0, 220)}`)
      .setColor(COLORS.success)
      .setDescription(
        [
          preview,
          dl.truncated ? "⚠️ file truncated at 2 MB — full file in the Stripe Dashboard" : null,
          `Data as of <t:${run.data_load_time}:f> · full CSV attached below.`,
        ]
          .filter((line): line is string => line !== null)
          .join("\n")
          .slice(0, 4096)
      );

    await interaction.editReply({
      embeds: [embed],
      components: [
        buttonRow(
          btn(`billadmin_sig_run:${token}`, "◀ Back to run", ButtonStyle.Secondary),
          btn(`billadmin_sig_list:${token}:${flow.page}`, "Back to list", ButtonStyle.Secondary)
        ),
      ],
      files: [{ attachment: dl.body, name: this.csvName(run.title || run.id) }],
    });
  }

  private csvName(base: string): string {
    return `${base.replace(/[^\w.-]+/g, "_").slice(0, 60) || "sigma"}.csv`;
  }

  // Light CSV preview: first line = headers, then up to 12 data rows, columns
  // padded/truncated so each line stays ≤100 chars, wrapped in a text fence.
  private buildCsvPreview(text: string, bodyTruncated: boolean): string {
    const lines = text.split(/\r?\n/);
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    if (lines.length === 0) return "```text\n(empty file)\n```\n0 rows total";

    const header = this.splitCsvLine(lines[0]);
    const rows = lines.slice(1, 13).map((line) => this.splitCsvLine(line));
    const ncols = Math.max(1, header.length);
    const sep = "  ";
    const width = Math.max(4, Math.floor((100 - sep.length * (ncols - 1)) / ncols));

    const fmt = (cells: string[]): string =>
      header
        .map((_, i) => {
          const cell = (cells[i] ?? "").trim();
          const cut = cell.length > width ? `${cell.slice(0, width - 1)}…` : cell;
          return cut.padEnd(width);
        })
        .join(sep)
        .trimEnd()
        .slice(0, 100);

    const body = [fmt(header), ...rows.map(fmt)].join("\n").slice(0, 3500);
    const totalRows = lines.length - 1;
    return `\`\`\`text\n${body}\n\`\`\`\n${bodyTruncated ? "≥" : ""}${totalRows} rows total`;
  }

  // Minimal CSV field splitter: handles quoted fields and "" escapes; good
  // enough for a preview (the full file is attached anyway).
  private splitCsvLine(line: string): string[] {
    const cells: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        cells.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    cells.push(cur);
    return cells;
  }

  // ---- ad-hoc SQL ----

  private buildAdhocModal(token: string): ModalBuilder {
    return new ModalBuilder()
      .setCustomId(`billadmin_sig_adhoc_modal:${token}`)
      .setTitle("Ad-hoc Sigma SQL")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("sql", "SQL (Sigma / Trino dialect)", {
            required: true,
            placeholder: "select count(*) from charges",
            style: TextInputStyle.Paragraph,
            maxLength: 4000,
          })
        )
      );
  }

  private async handleAdhocModal(interaction: ModalSubmitInteraction): Promise<void> {
    const token = interaction.customId.split(":")[1];
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    if (!session) return;
    const sql = interaction.fields.getTextInputValue("sql").trim();
    if (!sql) {
      await interaction.reply({ embeds: [makeEmbed("Enter a SQL query.", COLORS.danger)], flags: 64 });
      return;
    }

    await this.ctx.sessions.ackModal(interaction);
    await this.ctx.sessions.tryRender(interaction, async () => {
      // Audit carries only the first 100 chars of the SQL, never the full text.
      const sqlSnippet = sql.replace(/\s+/g, " ").slice(0, 100);

      let query: SigmaAdhocQuery;
      try {
        query = await this.ctx.stripe.runSigmaQueryAdhoc(sql);
      } catch (error) {
        if (error instanceof SigmaAdhocUnavailableError) {
          this.ctx.audit.log(interaction, {
            action: "Sigma ad-hoc query",
            outcome: `Unavailable — ${error.message.slice(0, 300)} · SQL: ${sqlSnippet}`,
            severity: "warn",
          });
          await interaction.editReply({
            embeds: [
              makeEmbed(
                "ℹ️ Ad-hoc Sigma queries aren't available via the API on this account (Stripe exposes " +
                  "scheduled query runs only). Define the query in Dashboard → Sigma and schedule it; " +
                  "fetch its runs here.",
                COLORS.warn
              ),
            ],
            components: [backRow("billadmin_hub:sigma")],
          });
          return;
        }
        const msg = error instanceof Error ? error.message : String(error);
        this.ctx.audit.log(interaction, {
          action: "Sigma ad-hoc query",
          outcome: `Failed — ${msg.slice(0, 300)} · SQL: ${sqlSnippet}`,
          severity: "danger",
        });
        await interaction.editReply({
          embeds: [stripeErrorEmbed(error)],
          components: [backRow("billadmin_hub:sigma")],
        });
        return;
      }

      // Poll until completed/failed; unknown status strings count as
      // still-running until the timeout (the endpoint's shape is undocumented).
      const deadline = Date.now() + ADHOC_TIMEOUT_MS;
      const hasFailed = (status: string): boolean => ADHOC_FAILED_STATUSES.includes(status);
      while (query.id && query.status !== "completed" && !hasFailed(query.status) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, ADHOC_POLL_MS));
        query = await this.ctx.stripe.getSigmaAdhocQuery(query.id);
      }

      const fileId = typeof query.file === "string" ? query.file : query.file?.id;
      if (query.status === "completed" && fileId) {
        this.ctx.audit.log(interaction, {
          action: "Sigma ad-hoc query",
          objectId: query.id || undefined,
          outcome: `Success — completed · SQL: ${sqlSnippet}`,
          severity: "success",
        });
        const dl = await this.ctx.stripe.downloadFileContents(fileId);
        const preview = this.buildCsvPreview(dl.body.toString("utf8"), dl.truncated);
        const embed = new EmbedBuilder()
          .setTitle("⚡ Ad-hoc Sigma query — results")
          .setColor(COLORS.success)
          .setDescription(
            [preview, dl.truncated ? "⚠️ file truncated at 2 MB — full file in the Stripe Dashboard" : null]
              .filter((line): line is string => line !== null)
              .join("\n")
              .slice(0, 4096)
          );
        await interaction.editReply({
          embeds: [embed],
          components: [backRow("billadmin_hub:sigma")],
          files: [{ attachment: dl.body, name: this.csvName(query.id || "sigma-adhoc") }],
        });
        return;
      }

      // Failure, timeout, or an unexpected shape — dump the raw response.
      const failed = hasFailed(query.status);
      const outcome = failed
        ? `Failed — status ${query.status}`
        : query.status === "completed"
          ? "Completed but returned no result file"
          : `Still \`${query.status}\` after ${ADHOC_TIMEOUT_MS / 1000}s of polling`;
      this.ctx.audit.log(interaction, {
        action: "Sigma ad-hoc query",
        objectId: query.id || undefined,
        outcome: `${outcome} · SQL: ${sqlSnippet}`,
        severity: failed ? "danger" : "warn",
      });

      let rawText: string;
      try {
        rawText = JSON.stringify(query.raw, null, 2);
      } catch {
        rawText = String(query.raw);
      }
      const embed = new EmbedBuilder()
        .setTitle("⚡ Ad-hoc Sigma query")
        .setColor(failed ? COLORS.danger : COLORS.warn)
        .setDescription(`${outcome}.\n\`\`\`json\n${rawText.slice(0, 3500)}\n\`\`\``.slice(0, 4096));
      await interaction.editReply({ embeds: [embed], components: [backRow("billadmin_hub:sigma")] });
    });
  }
}
