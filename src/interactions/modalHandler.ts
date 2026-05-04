import { MessageFlags, ModalSubmitInteraction } from "discord.js";
import { reportBody } from "../services/gameService";
import { parseCustomId } from "../utils/customIds";
import { safeReply } from "../utils/interactionResponses";

export async function handleModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.guild) {
    await safeReply(interaction, "Diese Interaktion funktioniert nur auf einem Server.");
    return;
  }

  const parts = parseCustomId(interaction.customId);
  if (parts[0] !== "amongus" || parts[1] !== "report-body-modal") {
    return;
  }

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const location = interaction.fields.getTextInputValue("location");
    await reportBody(interaction.guild, Number(parts[2]), interaction.user.id, location);
    await interaction.editReply("Leiche gemeldet. Meeting wurde gestartet.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unbekannter Fehler.";
    await safeReply(interaction, message);
  }
}
