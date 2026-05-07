import { MessageFlags, StringSelectMenuInteraction } from "discord.js";
import { recordFragwuerdigVote } from "../services/fragwuerdigService";
import { reportKill } from "../services/gameService";
import { safeReply } from "../utils/interactionResponses";
import { parseCustomId } from "../utils/customIds";

export async function handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!interaction.guild) {
    await safeReply(interaction, "Diese Interaktion funktioniert nur auf einem Server.");
    return;
  }

  const parts = parseCustomId(interaction.customId);
  if (parts[0] === "frag" && parts[1] === "vote") {
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const message = await recordFragwuerdigVote(interaction, Number(parts[2]), Number(parts[3]), interaction.values);
      await interaction.editReply(message);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unbekannter Fehler.";
      await safeReply(interaction, message);
    }
    return;
  }

  if (parts[0] !== "amongus") {
    return;
  }

  try {
    const action = parts[1];
    const sessionId = Number(parts[2]);
    const selectedUserId = interaction.values[0];

    if (action === "kill-select") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await reportKill(interaction.guild, sessionId, interaction.user.id, selectedUserId);
      await interaction.editReply("Kill wurde gemeldet.");
      return;
    }

    if (action === "report-body-select") {
      await safeReply(interaction, "Dieser Leichenmelden-Ablauf ist veraltet. Bitte druecke erneut auf \"Leiche melden\" und gib nur den Fundort an.");
      return;
    }

    await safeReply(interaction, "Diese Interaktion ist nicht mehr aktiv.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unbekannter Fehler.";
    await safeReply(interaction, message);
  }
}
