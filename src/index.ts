import { Client, Events, GatewayIntentBits } from "discord.js";
import { config } from "./config";
import { handleAmongUsCommand } from "./commands/amongus";
import { initDb } from "./db/database";
import { handleButton } from "./interactions/buttonHandler";
import { handleModal } from "./interactions/modalHandler";
import { handleSelect } from "./interactions/selectHandler";
import { registerCommands } from "./services/commandRegistry";
import { isExpectedInteractionError, safeReply } from "./utils/interactionResponses";
import { logger } from "./utils/logger";
import { startWebPanel } from "./webPanel";

const appLogger = logger.scoped("App");

async function main(): Promise<void> {
  appLogger.info("Botstart initialisiert.", { debugMode: config.debugMode, webPanelEnabled: config.webPanelEnabled });
  await initDb();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
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
      if (interaction.isChatInputCommand() && interaction.commandName === "amongus") {
        appLogger.debug("Slash Command ausgefuehrt.", { subcommand: interaction.options.getSubcommand(), userId: interaction.user.id });
        await handleAmongUsCommand(interaction);
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
