import { ActionRowBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle, Guild, GuildMember, MessageFlags } from "discord.js";
import { getActiveSession } from "../db/repository";
import { isAdminMember } from "../services/authService";
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
  scopedReportBodyModal,
  sendAdminStatus,
  startEmergencyMeeting,
  startGame,
  taskMessageOptions
} from "../services/gameService";
import { ids } from "../utils/customIds";
import { parseCustomId, parseScopedCustomId } from "../utils/customIds";
import { resolveInteractionGuildContext, SERVER_ONLY_INTERACTION_MESSAGE } from "../utils/guildContext";
import { safeReply } from "../utils/interactionResponses";

type ButtonGuildContext = { guild: Guild; member: GuildMember; guildId: string };

export async function handleButton(interaction: ButtonInteraction): Promise<void> {
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
  if (parts[0] === "post") {
    await handleCrazyPostButton(interaction, scoped, context);
    return;
  }

  if (parts[0] === "frag") {
    await handleFragwuerdigButton(interaction, scoped, context);
    return;
  }

  if (parts[0] !== "amongus") {
    return;
  }

  try {
    const { action, sessionId, args } = scoped;

    if (action === "join") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await joinSession(context.guild, sessionId, context.member);
      await interaction.editReply("Du bist der Session beigetreten.");
      return;
    }

    if (action === "start") {
      if (!isAdminMember(context.member)) {
        await safeReply(interaction, "Nur die Spielleitung kann das Spiel starten.");
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await startGame(context.guild, sessionId);
      await interaction.editReply("Spiel gestartet.");
      return;
    }

    if (action === "admin-status") {
      if (!isAdminMember(context.member)) {
        await safeReply(interaction, "Nur die Spielleitung kann den Status aktualisieren.");
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await sendAdminStatus(context.guild, sessionId);
      await interaction.editReply("Status wurde aktualisiert.");
      return;
    }

    if (action === "delete-prompt") {
      if (!isAdminMember(context.member)) {
        await safeReply(interaction, "Nur die Spielleitung kann die Session aufraeumen.");
        return;
      }
      await interaction.reply({
        content: "Willst du diese Session wirklich aufraeumen?",
        flags: MessageFlags.Ephemeral,
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(ids.deleteConfirm(context.guildId, sessionId)).setLabel("Ja, Session aufraeumen").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(ids.deleteCancel(context.guildId, sessionId)).setLabel("Abbrechen").setStyle(ButtonStyle.Secondary)
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
      if (!isAdminMember(context.member)) {
        await safeReply(interaction, "Nur die Spielleitung kann die Session aufraeumen.");
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await cancelAndDeleteSession(context.guild, sessionId);
      await interaction.editReply(result);
      return;
    }

    if (action === "emergency") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await startEmergencyMeeting(context.guild, sessionId, interaction.user.id);
      await interaction.editReply("Emergency Meeting wurde einberufen.");
      return;
    }

    if (action === "task-done") {
      await interaction.deferUpdate();
      await completeTask(context.guild, Number(args[0]), interaction.user.id, sessionId);
      await interaction.message.edit({ components: [] });
      await interaction.followUp({ content: "Task als erledigt markiert.", flags: MessageFlags.Ephemeral });
      return;
    }

    if (action === "task-step") {
      await interaction.deferUpdate();
      const result = await completeTaskStep(context.guild, sessionId, Number(args[0]), Number(args[1]), interaction.user.id);
      await interaction.message.edit(taskMessageOptions(result.task, true, context.guildId));
      await interaction.followUp({ content: result.message, flags: MessageFlags.Ephemeral });
      return;
    }

    if (action === "kill") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const menu = await killSelectMenu(context.guild, sessionId, interaction.user.id);
      await interaction.editReply({
        content: "Wen hast du getoetet?",
        components: [new ActionRowBuilder<typeof menu>().addComponents(menu)]
      });
      return;
    }

    if (action === "report-body") {
      const hasUnreportedBody = await canOpenBodyReportModal(context.guild, sessionId, interaction.user.id);
      if (!hasUnreportedBody) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const message = await recordFalseBodyReport(context.guild, sessionId, interaction.user.id);
        await interaction.editReply(message);
        return;
      }
      await interaction.showModal(scopedReportBodyModal(context.guildId, sessionId));
      return;
    }

    if (action === "vote") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const target = args[0];
      const message = await castVote(context.guild, sessionId, interaction.user.id, target);
      await interaction.editReply(message);
      return;
    }

    if (action === "end") {
      if (!isAdminMember(context.member)) {
        await safeReply(interaction, "Nur die Spielleitung kann die Session beenden.");
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const session = await getActiveSession(context.guildId);
      if (!session) {
        await interaction.editReply("Keine aktive Session gefunden.");
        return;
      }
      if (session.id !== sessionId) {
        await interaction.editReply("Diese Session existiert nicht mehr oder gehoert zu einem anderen Server.");
        return;
      }
      await endSession(context.guild, sessionId);
      await interaction.editReply("Session beendet.");
      return;
    }

    if (action === "confirm-end") {
      if (!isAdminMember(context.member)) {
        await safeReply(interaction, "Nur die Spielleitung kann die Session aufraeumen.");
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await deleteSessionChannels(context.guild, sessionId);
      await interaction.editReply(result);
      return;
    }

    await safeReply(interaction, "Diese Interaktion ist nicht mehr aktiv.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unbekannter Fehler.";
    await safeReply(interaction, message);
  }
}

async function handleFragwuerdigButton(
  interaction: ButtonInteraction,
  scoped: { action: string; sessionId: number; args: string[] },
  context: ButtonGuildContext
): Promise<void> {
  try {
    const { action, sessionId } = scoped;

    if (action === "join") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const message = await joinFragwuerdigSession(context.guild, sessionId, context.member);
      await interaction.editReply(message);
      return;
    }

    if (action === "start" || action === "next") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await startFragwuerdigRound(context.guild, sessionId, interaction.user.id, isAdminMember(context.member));
      await interaction.editReply("Fragwuerdig-Runde gestartet.");
      return;
    }

    if (action === "continue") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const message = await markFragwuerdigContinue(context.guild, sessionId, interaction.user.id, true);
      await interaction.editReply(message);
      return;
    }

    if (action === "stop") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const message = await markFragwuerdigContinue(context.guild, sessionId, interaction.user.id, false);
      await interaction.editReply(message);
      return;
    }

    if (action === "cancel" || action === "end") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const message = await endFragwuerdigByHost(context.guild, sessionId, interaction.user.id, isAdminMember(context.member));
      await interaction.editReply(message);
      return;
    }

    await safeReply(interaction, "Diese Interaktion ist nicht mehr aktiv.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unbekannter Fehler.";
    await safeReply(interaction, message);
  }
}

async function handleCrazyPostButton(
  interaction: ButtonInteraction,
  scoped: { action: string; sessionId: number; args: string[] },
  context: ButtonGuildContext
): Promise<void> {
  try {
    const { action, sessionId } = scoped;

    if (action === "join") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await joinCrazyPostSession(context.guild, sessionId, context.member);
      await interaction.editReply("Du bist der Verrueckte-Post-Session beigetreten.");
      return;
    }

    if (action === "start") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await startCrazyPostGame(context.guild, sessionId, interaction.user.id, isAdminMember(context.member));
      await interaction.editReply("Verrueckte Post gestartet.");
      return;
    }

    if (action === "delete") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await cancelCrazyPostSession(context.guild, sessionId, interaction.user.id, isAdminMember(context.member));
      await interaction.editReply(result);
      return;
    }

    await safeReply(interaction, "Diese Interaktion ist nicht mehr aktiv.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unbekannter Fehler.";
    await safeReply(interaction, message);
  }
}
