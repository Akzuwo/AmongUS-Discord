import { ChatInputCommandInteraction, GuildMember, MessageFlags } from "discord.js";
import { isAdminInteraction } from "../services/authService";
import { createFragwuerdigGameSession } from "../services/fragwuerdigService";
import { safeReply } from "../utils/interactionResponses";

export async function handleGameCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild || !(interaction.member instanceof GuildMember)) {
    await safeReply(interaction, "Dieser Command funktioniert nur auf einem Server.");
    return;
  }
  if (!isAdminInteraction(interaction)) {
    await safeReply(interaction, "Nur die Spielleitung kann diesen Command benutzen.");
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand !== "start") {
    await safeReply(interaction, "Dieser Game-Command ist nicht bekannt.");
    return;
  }

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const game = interaction.options.getString("spiel", true);
    if (game !== "fragwuerdig") {
      await interaction.editReply("Dieses Spiel ist hier noch nicht hinterlegt.");
      return;
    }
    const impostorCount = interaction.options.getInteger("impostor_anzahl", true);
    if (impostorCount !== 1 && impostorCount !== 2) {
      await interaction.editReply("impostor_anzahl muss 1 oder 2 sein.");
      return;
    }
    const session = await createFragwuerdigGameSession(interaction.guild, interaction.member, impostorCount);
    await interaction.editReply(`Fragwuerdig-Session ${session.id} erstellt. Anmeldung: <#${session.lobbyChannelId}>`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unbekannter Fehler.";
    await safeReply(interaction, message);
  }
}
