import { Client, Events, GatewayIntentBits } from "discord.js";
import { config } from "./config";
import { handleAmongUsCommand } from "./commands/amongus";
import { handleCrazyPostCommand } from "./commands/crazyPost";
import { handleGameCommand } from "./commands/game";
import { initDb } from "./db/database";
import { handleButton } from "./interactions/buttonHandler";
import { handleModal } from "./interactions/modalHandler";
import { handleSelect } from "./interactions/selectHandler";
import { registerCommands } from "./services/commandRegistry";
import { handleCrazyPostPlayerMessage } from "./services/crazyPostService";
import { handleFragwuerdigPlayerMessage } from "./services/fragwuerdigService";
import {
  isGuildAllowed,
  logGuildAccessConfiguration,
  prepareAllowedGuildStorage,
  warnAboutLegacyGlobalJsonStorage
} from "./services/guildAccessService";
import { interactionGuildId, logBlockedInteraction, logBlockedMessage, messageGuildId } from "./utils/guildContext";
import { isExpectedInteractionError, safeReply } from "./utils/interactionResponses";
import { logger } from "./utils/logger";
import { startWebPanel } from "./webPanel";

const appLogger = logger.scoped("App");

async function main(): Promise<void> {
  appLogger.info("Botstart initialisiert.", { debugMode: config.debugMode, webPanelEnabled: config.webPanelEnabled });
  logGuildAccessConfiguration();
  prepareAllowedGuildStorage();
  warnAboutLegacyGlobalJsonStorage();
  await initDb();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
  });

  startWebPanel(client);
  await registerCommands();

  client.once(Events.ClientReady, (readyClient) => {
    appLogger.info(`AmongUS Bot gestartet als ${readyClient.user.tag}`);
  });

  client.on(Events.Error, (error) => {
    appLogger.error("Discord client error.", error);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      const guildId = interactionGuildId(interaction);
      if (guildId && !isGuildAllowed(guildId)) {
        logBlockedInteraction(interaction, "Guild nicht erlaubt");
        if (interaction.isRepliable()) {
          await safeReply(interaction, "Dieser Server ist für diesen Bot nicht freigeschaltet.");
        }
        return;
      }

      if (interaction.isChatInputCommand() && interaction.commandName === "amongus") {
        appLogger.debug("Slash Command ausgefuehrt.", { subcommand: interaction.options.getSubcommand(), userId: interaction.user.id });
        await handleAmongUsCommand(interaction);
        return;
      }

      if (interaction.isChatInputCommand() && interaction.commandName === "verruecktepost") {
        await handleCrazyPostCommand(interaction);
        return;
      }

      if (interaction.isChatInputCommand() && interaction.commandName === "game") {
        await handleGameCommand(interaction);
        return;
      }

      if (interaction.isButton()) {
        await handleButton(interaction);
        return;
      }

      if (interaction.isStringSelectMenu()) {
        await handleSelect(interaction);
        return;
      }

      if (interaction.isModalSubmit()) {
        await handleModal(interaction);
      }
    } catch (error) {
      if (!isExpectedInteractionError(error)) {
        appLogger.warn("Unhandled interaction error.", error instanceof Error ? error.message : error);
      }
      if (interaction.isRepliable()) {
        await safeReply(interaction, "Es ist ein Fehler aufgetreten. Bitte versuche es erneut oder informiere die Spielleitung.");
      }
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      const guildId = messageGuildId(message);
      if (guildId && !isGuildAllowed(guildId)) {
        logBlockedMessage(message, "Guild nicht erlaubt");
        return;
      }
      if (await handleFragwuerdigPlayerMessage(message)) {
        return;
      }
      await handleCrazyPostPlayerMessage(message);
    } catch (error) {
      console.error("Unhandled message error", error);
      await message.reply("Es ist ein Fehler aufgetreten. Bitte informiere die Spielleitung.").catch(() => null);
    }
  });

  await client.login(config.token);
}

main().catch((error) => {
  appLogger.error("Botstart fehlgeschlagen.", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  appLogger.error("Unhandled promise rejection.", reason);
});

process.on("uncaughtException", (error) => {
  appLogger.error("Uncaught exception.", error);
});
