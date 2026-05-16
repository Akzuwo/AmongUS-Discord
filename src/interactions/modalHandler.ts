import { MessageFlags, ModalSubmitInteraction } from "discord.js";
import { reportBody } from "../services/gameService";
import { parseCustomId, parseScopedCustomId } from "../utils/customIds";
import { resolveInteractionGuildContext, SERVER_ONLY_INTERACTION_MESSAGE } from "../utils/guildContext";
import { safeReply } from "../utils/interactionResponses";

export async function handleModal(interaction: ModalSubmitInteraction): Promise<void> {
  const context = await resolveInteractionGuildContext(interaction, SERVER_ONLY_INTERACTION_MESSAGE);
  if (!context.ok) {
    await safeReply(interaction, context.message);
    return;
  }

  const parts = parseCustomId(interaction.customId);
  const scoped = parseScopedCustomId(parts, context.guildId);
  if (!scoped) {
    await safeReply(interaction, "Diese Session existiert nicht mehr oder gehoert zu einem anderen Server.");
    return;
  }
  if (parts[0] !== "amongus" || parts[1] !== "report-body-modal") {
    return;
  }

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const location = interaction.fields.getTextInputValue("location");
    await reportBody(context.guild, scoped.sessionId, interaction.user.id, location);
    await interaction.editReply("Leiche gemeldet. Meeting wurde ausgeloest.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unbekannter Fehler.";
    await safeReply(interaction, message);
  }
}
