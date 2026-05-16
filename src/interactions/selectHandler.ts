import { MessageFlags, StringSelectMenuInteraction } from "discord.js";
import { recordFragwuerdigVote } from "../services/fragwuerdigService";
import { reportKill } from "../services/gameService";
import { safeReply } from "../utils/interactionResponses";
import { parseCustomId, parseScopedCustomId } from "../utils/customIds";
import { resolveInteractionGuildContext, SERVER_ONLY_INTERACTION_MESSAGE } from "../utils/guildContext";

export async function handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
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
  if (parts[0] === "frag" && parts[1] === "vote") {
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const message = await recordFragwuerdigVote(interaction, context.guild, scoped.sessionId, Number(scoped.args[0]), interaction.values);
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
    const action = scoped.action;
    const sessionId = scoped.sessionId;
    const selectedUserId = interaction.values[0];

    if (action === "kill-select") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await reportKill(context.guild, sessionId, interaction.user.id, selectedUserId);
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
