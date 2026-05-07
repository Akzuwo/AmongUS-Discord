import { ActionRowBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle, GuildMember, MessageFlags } from "discord.js";
import { getActiveSession } from "../db/repository";
import { isAdminInteraction } from "../services/authService";
import { cancelCrazyPostSession, joinCrazyPostSession, startCrazyPostGame } from "../services/crazyPostService";
import {
  endFragwuerdigByHost,
  joinFragwuerdigSession,
  markFragwuerdigContinue,
  startFragwuerdigRound
} from "../services/fragwuerdigService";
import {
  cancelAndDeleteSession,
  canOpenBodyReportModal,
  castVote,
  completeTask,
  completeTaskStep,
  deleteSessionChannels,
  endSession,
  joinSession,
  killSelectMenu,
  recordFalseBodyReport,
  reportBodyModal,
  sendAdminStatus,
  startEmergencyMeeting,
  startGame,
  taskMessageOptions
} from "../services/gameService";
import { ids } from "../utils/customIds";
import { parseCustomId } from "../utils/customIds";
import { safeReply } from "../utils/interactionResponses";

export async function handleButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild || !(interaction.member instanceof GuildMember)) {
    await safeReply(interaction, "Diese Interaktion funktioniert nur auf einem Server.");
    return;
  }

  const parts = parseCustomId(interaction.customId);
  if (parts[0] === "post") {
    await handleCrazyPostButton(interaction, parts);
    return;
  }

  if (parts[0] === "frag") {
    await handleFragwuerdigButton(interaction, parts);
    return;
  }

  if (parts[0] !== "amongus") {
    return;
  }

  try {
    const action = parts[1];

    if (action === "join") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await joinSession(interaction.guild, Number(parts[2]), interaction.member);
      await interaction.editReply("Du bist der Session beigetreten.");
      return;
    }

    if (action === "start") {
      if (!isAdminInteraction(interaction)) {
        await safeReply(interaction, "Nur die Spielleitung kann das Spiel starten.");
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await startGame(interaction.guild, Number(parts[2]));
      await interaction.editReply("Spiel gestartet.");
      return;
    }

    if (action === "admin-status") {
      if (!isAdminInteraction(interaction)) {
        await safeReply(interaction, "Nur die Spielleitung kann den Status aktualisieren.");
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await sendAdminStatus(interaction.guild, Number(parts[2]));
      await interaction.editReply("Status wurde aktualisiert.");
      return;
    }

    if (action === "delete-prompt") {
      if (!isAdminInteraction(interaction)) {
        await safeReply(interaction, "Nur die Spielleitung kann die Session aufraeumen.");
        return;
      }
      await interaction.reply({
        content: "Willst du diese Session wirklich aufraeumen?",
        flags: MessageFlags.Ephemeral,
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(ids.deleteConfirm(Number(parts[2]))).setLabel("Ja, Session aufraeumen").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(ids.deleteCancel(Number(parts[2]))).setLabel("Abbrechen").setStyle(ButtonStyle.Secondary)
          )
        ]
      });
      return;
    }

    if (action === "delete-cancel") {
      await safeReply(interaction, "Abgebrochen. Es wurde nichts geloescht.");
      return;
    }

    if (action === "delete-confirm") {
      if (!isAdminInteraction(interaction)) {
        await safeReply(interaction, "Nur die Spielleitung kann die Session aufraeumen.");
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await cancelAndDeleteSession(interaction.guild, Number(parts[2]));
      await interaction.editReply(result);
      return;
    }

    if (action === "emergency") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await startEmergencyMeeting(interaction.guild, Number(parts[2]), interaction.user.id);
      await interaction.editReply("Emergency Meeting wurde einberufen.");
      return;
    }

    if (action === "task-done") {
      await interaction.deferUpdate();
      await completeTask(interaction.guild, Number(parts[2]), interaction.user.id);
      await interaction.message.edit({ components: [] });
      await interaction.followUp({ content: "Task als erledigt markiert.", flags: MessageFlags.Ephemeral });
      return;
    }

    if (action === "task-step") {
      await interaction.deferUpdate();
      const result = await completeTaskStep(interaction.guild, Number(parts[2]), Number(parts[3]), Number(parts[4]), interaction.user.id);
      await interaction.message.edit(taskMessageOptions(result.task, true));
      await interaction.followUp({ content: result.message, flags: MessageFlags.Ephemeral });
      return;
    }

    if (action === "kill") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const menu = await killSelectMenu(interaction.guild, Number(parts[2]), interaction.user.id);
      await interaction.editReply({
        content: "Wen hast du getoetet?",
        components: [new ActionRowBuilder<typeof menu>().addComponents(menu)]
      });
      return;
    }

    if (action === "report-body") {
      const hasUnreportedBody = await canOpenBodyReportModal(interaction.guild, Number(parts[2]), interaction.user.id);
      if (!hasUnreportedBody) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const message = await recordFalseBodyReport(interaction.guild, Number(parts[2]), interaction.user.id);
        await interaction.editReply(message);
        return;
      }
      await interaction.showModal(reportBodyModal(Number(parts[2])));
      return;
    }

    if (action === "vote") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const target = parts[3];
      const message = await castVote(interaction.guild, Number(parts[2]), interaction.user.id, target);
      await interaction.editReply(message);
      return;
    }

    if (action === "end") {
      if (!isAdminInteraction(interaction)) {
        await safeReply(interaction, "Nur die Spielleitung kann die Session beenden.");
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const session = await getActiveSession(interaction.guild.id);
      if (!session) {
        await interaction.editReply("Keine aktive Session gefunden.");
        return;
      }
      await endSession(interaction.guild, session.id);
      await interaction.editReply("Session beendet.");
      return;
    }

    if (action === "confirm-end") {
      if (!isAdminInteraction(interaction)) {
        await safeReply(interaction, "Nur die Spielleitung kann die Session aufraeumen.");
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await deleteSessionChannels(interaction.guild, Number(parts[2]));
      await interaction.editReply(result);
      return;
    }

    await safeReply(interaction, "Diese Interaktion ist nicht mehr aktiv.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unbekannter Fehler.";
    await safeReply(interaction, message);
  }
}

async function handleFragwuerdigButton(interaction: ButtonInteraction, parts: string[]): Promise<void> {
  try {
    const action = parts[1];
    const sessionId = Number(parts[2]);

    if (action === "join") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const message = await joinFragwuerdigSession(interaction.guild!, sessionId, interaction.member as GuildMember);
      await interaction.editReply(message);
      return;
    }

    if (action === "start" || action === "next") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await startFragwuerdigRound(interaction.guild!, sessionId, interaction.user.id, isAdminInteraction(interaction));
      await interaction.editReply("Fragwuerdig-Runde gestartet.");
      return;
    }

    if (action === "continue") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const message = await markFragwuerdigContinue(interaction.guild!, sessionId, interaction.user.id, true);
      await interaction.editReply(message);
      return;
    }

    if (action === "stop") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const message = await markFragwuerdigContinue(interaction.guild!, sessionId, interaction.user.id, false);
      await interaction.editReply(message);
      return;
    }

    if (action === "cancel" || action === "end") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const message = await endFragwuerdigByHost(interaction.guild!, sessionId, interaction.user.id, isAdminInteraction(interaction));
      await interaction.editReply(message);
      return;
    }

    await safeReply(interaction, "Diese Interaktion ist nicht mehr aktiv.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unbekannter Fehler.";
    await safeReply(interaction, message);
  }
}

async function handleCrazyPostButton(interaction: ButtonInteraction, parts: string[]): Promise<void> {
  try {
    const action = parts[1];
    const sessionId = Number(parts[2]);

    if (action === "join") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await joinCrazyPostSession(interaction.guild!, sessionId, interaction.member as GuildMember);
      await interaction.editReply("Du bist der Verrueckte-Post-Session beigetreten.");
      return;
    }

    if (action === "start") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await startCrazyPostGame(interaction.guild!, sessionId, interaction.user.id, isAdminInteraction(interaction));
      await interaction.editReply("Verrueckte Post gestartet.");
      return;
    }

    if (action === "delete") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await cancelCrazyPostSession(interaction.guild!, sessionId, interaction.user.id, isAdminInteraction(interaction));
      await interaction.editReply(result);
      return;
    }

    await safeReply(interaction, "Diese Interaktion ist nicht mehr aktiv.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unbekannter Fehler.";
    await safeReply(interaction, message);
  }
}
