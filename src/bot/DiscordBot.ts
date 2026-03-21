import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder,
  type Interaction,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  TextChannel,
} from "discord.js";
import { REST, Routes } from "discord.js";
import { BotConfig } from "../config";
import { SessionStore } from "../auth/SessionStore";
import { OAuthManager } from "../auth/OAuthManager";
import { PostizApiClient } from "./PostizApiClient";
import { ClaudeCodeRunner } from "./ClaudeCodeRunner";
import { GitHubClient } from "./GitHubClient";
import { CategoryRegistry } from "./CategoryRegistry";
import { CallbackServer } from "../server/CallbackServer";
import { BillingCategory } from "../categories/BillingCategory";

export class DiscordBot {
  readonly client: Client;
  private rest: REST;

  constructor(
    private config: BotConfig,
    private sessionStore: SessionStore,
    private oauthManager: OAuthManager,
    private apiClient: PostizApiClient,
    private claudeRunner: ClaudeCodeRunner,
    private githubClient: GitHubClient,
    private categoryRegistry: CategoryRegistry
  ) {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    });

    this.rest = new REST({ version: "10" }).setToken(config.discord.token);
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.client.once("ready", () => {
      console.log(`Bot logged in as ${this.client.user?.tag}`);
    });

    this.client.on("interactionCreate", (interaction) => {
      this.handleInteraction(interaction).catch(console.error);
    });
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isChatInputCommand()) {
      await this.handleCommand(interaction);
    } else if (interaction.isButton()) {
      await this.handleButton(interaction);
    } else if (interaction.isStringSelectMenu()) {
      await this.handleSelectMenu(interaction);
    } else if (interaction.isModalSubmit()) {
      await this.handleModal(interaction);
    }
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.commandName === "setup") {
      await this.postSupportPanel(interaction);
    }
  }

  private async postSupportPanel(interaction: ChatInputCommandInteraction): Promise<void> {
    const embed = new EmbedBuilder()
      .setTitle("Postiz Support")
      .setDescription("Need help? Click the button below to get started.")
      .setColor(0x5865f2);

    const startButton = new ButtonBuilder()
      .setCustomId("start_here")
      .setLabel("Start Here")
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(startButton);

    await interaction.reply({ embeds: [embed], components: [row] });
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    if (interaction.customId.startsWith("feedback_yes:") || interaction.customId.startsWith("feedback_no:")) {
      await this.handleFeedback(interaction);
      return;
    }

    if (interaction.customId.startsWith("create_issue:")) {
      await this.handleCreateIssue(interaction);
      return;
    }

    if (
      interaction.customId.startsWith("billing_accept_discount:") ||
      interaction.customId.startsWith("billing_decline_discount:") ||
      interaction.customId.startsWith("billing_confirm_refund:") ||
      interaction.customId.startsWith("billing_cancel_refund:")
    ) {
      const allowedUserId = interaction.customId.split(":")[1];
      if (interaction.user.id !== allowedUserId) {
        await interaction.reply({ content: "Only the original requester can use this.", flags: 64 });
        return;
      }
      const billing = this.getBillingCategory();
      if (interaction.customId.startsWith("billing_accept_discount:")) {
        await billing.handleAcceptDiscount(interaction);
      } else if (interaction.customId.startsWith("billing_decline_discount:")) {
        await billing.handleDeclineDiscount(interaction);
      } else if (interaction.customId.startsWith("billing_confirm_refund:")) {
        await billing.handleConfirmRefund(interaction);
      } else {
        await billing.handleCancelRefund(interaction);
      }
      return;
    }

    if (interaction.customId.startsWith("auth_logout:")) {
      const allowedUserId = interaction.customId.split(":")[1];
      if (interaction.user.id !== allowedUserId) {
        await interaction.reply({ content: "Only the original requester can use this.", flags: 64 });
        return;
      }
      await this.sessionStore.removeSession(interaction.user.id);
      await interaction.reply({ content: "You've been logged out.", flags: 64 });
      return;
    }

    if (interaction.customId !== "start_here") return;

    // Not logged in → prompt login
    if (!(await this.sessionStore.isAuthenticated(interaction.user.id))) {
      const authUrl = await this.oauthManager.generateAuthUrl(
        interaction.user.id,
        interaction.channelId
      );

      const embed = new EmbedBuilder()
        .setTitle("Connect your Postiz account")
        .setDescription(
          `You need to log in first.\n\n[Click here to authenticate](${authUrl})\n\nOnce done, come back and click **Start Here** again.`
        )
        .setColor(0x5865f2)
        .setFooter({ text: "This link expires in 10 minutes." });

      await interaction.reply({ embeds: [embed], flags: 64 });
      return;
    }

    // Logged in → show category select menu + logout button
    const selectMenu = this.buildCategorySelectMenu();
    const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

    const logoutButton = new ButtonBuilder()
      .setCustomId(`auth_logout:${interaction.user.id}`)
      .setLabel("Logout")
      .setEmoji("🚪")
      .setStyle(ButtonStyle.Danger);

    const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(logoutButton);

    await interaction.reply({ components: [selectRow, buttonRow], flags: 64 });
  }

  private getBillingCategory(): BillingCategory {
    return this.categoryRegistry.getAll().find((c) => c.id === "billing") as BillingCategory;
  }

  private buildCategorySelectMenu(): StringSelectMenuBuilder {
    return new StringSelectMenuBuilder()
      .setCustomId("category_select")
      .setPlaceholder("What do you need help with?")
      .addOptions(
        this.categoryRegistry.getAll().map((category) => ({
          label: category.label,
          value: category.id,
          description: category.description,
          emoji: category.emoji,
        }))
      );
  }

  private async handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
    if (interaction.customId === "billing_suboption") {
      const threadsChannel = await this.client.channels.fetch(this.config.discord.threadsChannelId);
      if (!(threadsChannel instanceof TextChannel)) {
        await interaction.reply({ content: "Support threads channel is misconfigured.", flags: 64 });
        return;
      }
      await this.getBillingCategory().handleBillingSubOption(interaction, threadsChannel);
      return;
    }

    if (interaction.customId !== "category_select") return;

    const categoryId = interaction.values[0];
    const category = this.categoryRegistry.getAll().find((c) => c.id === categoryId);
    if (!category) return;

    const handled = await category.handleButtonPress(interaction);

    // If the category handled the interaction itself (e.g. billing), don't reset
    if (handled) return;

    // Reset the select menu back to placeholder so it can be used again
    const freshMenu = this.buildCategorySelectMenu();
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(freshMenu);
    await interaction.editReply({ components: [row] });
  }

  private async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    const category = this.categoryRegistry.findByModalId(interaction.customId);
    if (!category) return;

    const session = await this.sessionStore.getSession(interaction.user.id);
    if (!session) {
      await interaction.reply({
        content: "Your session has expired. Please click **Start Here** again.",
        flags: 64,
      });
      return;
    }

    const threadsChannel = await this.client.channels.fetch(this.config.discord.threadsChannelId);
    if (!(threadsChannel instanceof TextChannel)) {
      await interaction.reply({
        content: "Support threads channel is misconfigured. Please contact an admin.",
        flags: 64,
      });
      return;
    }

    const responder = (prompt: string, onUpdate?: (messages: string[]) => void) =>
      this.claudeRunner.run(prompt, onUpdate);

    await category.handleModalSubmit(interaction, responder, threadsChannel);
  }

  private async handleCreateIssue(interaction: ButtonInteraction): Promise<void> {
    const parts = interaction.customId.split(":");
    const allowedUserId = parts[1];
    const issueLabel = parts[2] || "feature-request";

    if (interaction.user.id !== allowedUserId) {
      await interaction.reply({ content: "Only the original requester can create this issue.", flags: 64 });
      return;
    }

    await interaction.deferReply();

    try {
      const thread = interaction.channel;
      if (!thread || !thread.isThread()) {
        await interaction.editReply({ content: "Could not find the thread." });
        return;
      }

      const messages = await thread.messages.fetch({ limit: 10 });
      const questionMsg = messages.reverse().find(
        (m) => m.embeds.length > 0 && m.embeds[0].title === "Your question"
      );

      const userQuestion = questionMsg?.embeds[0].description || "Issue from Discord";

      const responseTexts = messages
        .filter((m) => m.embeds.length > 0 && m.embeds[0].title !== "Your question")
        .map((m) => m.embeds[0].description)
        .filter(Boolean)
        .join("\n\n");

      const isBug = issueLabel === "bug";
      const heading = isBug ? "Bug Report" : "Feature Request";
      const titlePrefix = isBug ? "Bug:" : "Feature request:";

      const issueBody = [
        `## ${heading}`,
        ``,
        `**User report:** ${userQuestion}`,
        ``,
        `## Context from support bot`,
        ``,
        responseTexts || "No additional context.",
        ``,
        `---`,
        `*Created from Discord support bot by <@${interaction.user.id}>*`,
      ].join("\n");

      const issueUrl = await this.githubClient.createIssue(
        `${titlePrefix} ${userQuestion.slice(0, 100)}`,
        issueBody,
        [issueLabel]
      );

      // Disable the button after use
      const disabledButton = new ButtonBuilder()
        .setCustomId(interaction.customId)
        .setLabel("Issue Created")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(disabledButton);
      await interaction.message.edit({ components: [row] });

      const embed = new EmbedBuilder()
        .setTitle("GitHub Issue Created")
        .setDescription(`Your ${isBug ? "bug report" : "feature request"} has been submitted!\n\n[View Issue](${issueUrl})`)
        .setColor(0x57f287);

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error("GitHub issue creation error:", error);
      await interaction.editReply({ content: "Failed to create the GitHub issue. Please try again later." });
    }
  }

  private async handleFeedback(interaction: ButtonInteraction): Promise<void> {
    const allowedUserId = interaction.customId.split(":")[1];
    if (interaction.user.id !== allowedUserId) {
      await interaction.reply({ content: "Only the original requester can use this.", flags: 64 });
      return;
    }

    const isPositive = interaction.customId.startsWith("feedback_yes:");
    const thread = interaction.channel;

    // Disable the buttons
    const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("feedback_done")
        .setLabel(isPositive ? "Resolved" : "Escalated")
        .setStyle(isPositive ? ButtonStyle.Success : ButtonStyle.Danger)
        .setDisabled(true)
    );
    await interaction.message.edit({ components: [disabledRow] });

    if (isPositive) {
      await interaction.reply("Glad we could help! This thread will be archived.");
      if (thread?.isThread()) {
        await thread.setArchived(true);
      }
    } else {
      await interaction.reply(
        `A support team member has been notified. <@&${this.config.discord.supportRoleId}> will follow up here shortly.`
      );
    }
  }

  async registerCommands(): Promise<void> {
    const commands = [
      {
        name: "setup",
        description: "Post the support panel in this channel (admin only)",
        default_member_permissions: "8", // ADMINISTRATOR
      },
    ];

    await this.rest.put(Routes.applicationCommands(this.config.discord.clientId), {
      body: commands,
    });

    console.log("Slash commands registered");
  }

  async start(): Promise<void> {
    await this.registerCommands();
    await this.client.login(this.config.discord.token);

    const callbackServer = new CallbackServer(
      this.config,
      this.oauthManager,
      this.client
    );
    callbackServer.start();
  }
}
