import { Client, Events, GatewayIntentBits } from "discord.js";
import { config } from "./config";
import { handleAmongUsCommand } from "./commands/amongus";
import { initDb } from "./db/database";
import { handleButton } from "./interactions/buttonHandler";
import { handleModal } from "./interactions/modalHandler";
import { handleSelect } from "./interactions/selectHandler";
import { registerCommands } from "./services/commandRegistry";
import { isExpectedInteractionError, safeReply } from "./utils/interactionResponses";

async function main(): Promise<void> {
  await initDb();
  await registerCommands();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
  });

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`AmongUS Bot gestartet als ${readyClient.user.tag}`);
  });

  client.on(Events.Error, (error) => {
    console.error("Discord client error", error);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand() && interaction.commandName === "amongus") {
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
        console.error("Unhandled interaction error", error);
      }
      if (interaction.isRepliable()) {
        await safeReply(interaction, "Es ist ein Fehler aufgetreten. Bitte versuche es erneut oder informiere die Spielleitung.");
      }
    }
  });

  await client.login(config.token);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception", error);
});
