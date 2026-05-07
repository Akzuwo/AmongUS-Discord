import { ChatInputCommandInteraction, GuildMember, MessageFlags } from "discord.js";
import { isAdminInteraction } from "../services/authService";
import { createCrazyPostGameSession } from "../services/crazyPostService";
import { CrazyPostOrderMode } from "../models/session";
import { safeReply } from "../utils/interactionResponses";

export async function handleCrazyPostCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild || !(interaction.member instanceof GuildMember)) {
    await safeReply(interaction, "Dieser Command funktioniert nur auf einem Server.");
    return;
  }

  if (!isAdminInteraction(interaction)) {
    await safeReply(interaction, "Nur die Spielleitung kann diesen Command benutzen.");
    return;
  }

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const orderMode = interaction.options.getString("reihenfolge", true) as CrazyPostOrderMode;
    const session = await createCrazyPostGameSession(interaction.guild, interaction.member, orderMode);
    await interaction.editReply(`Verrueckte-Post-Session ${session.id} erstellt. Anmeldung: <#${session.lobbyChannelId}>`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unbekannter Fehler.";
    await safeReply(interaction, message);
  }
}
