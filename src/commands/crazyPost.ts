import { ChatInputCommandInteraction, MessageFlags } from "discord.js";
import { config } from "../config";
import { isAdminMember } from "../services/authService";
import { createCrazyPostGameSession } from "../services/crazyPostService";
import { CrazyPostOrderMode } from "../models/session";
import { safeReply } from "../utils/interactionResponses";
import { resolveCommandGuildContext } from "../utils/guildContext";

export async function handleCrazyPostCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const context = await resolveCommandGuildContext(interaction);
  if (!context.ok) {
    await safeReply(interaction, context.message);
    return;
  }

  if (!isAdminMember(context.member)) {
    await safeReply(interaction, "Nur die Spielleitung kann diesen Command benutzen.");
    return;
  }

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const orderMode = interaction.options.getString("reihenfolge", true) as CrazyPostOrderMode;
    const ghostCount = interaction.options.getInteger("ghost_count") ?? 0;
    const debug = (interaction.options.getBoolean("debug") ?? config.debugMode) || ghostCount > 0;
    const session = await createCrazyPostGameSession(context.guild, context.member, orderMode, {
      isDebugSession: debug,
      ghostCount
    });
    await interaction.editReply(`${session.isDebugSession ? "Debug-" : ""}Verrueckte-Post-Session ${session.id} erstellt. Anmeldung: <#${session.lobbyChannelId}>`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unbekannter Fehler.";
    await safeReply(interaction, message);
  }
}
