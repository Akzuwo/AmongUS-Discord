import { ChatInputCommandInteraction, MessageFlags } from "discord.js";
import { config } from "../config";
import { getActiveSession } from "../db/repository";
import { isAdminMember } from "../services/authService";
import {
  clearFalseReportWarningsForUser,
  createDebugGameSession,
  createGameSession,
  debugCompleteTask,
  debugKillPlayer,
  debugVote,
  endSession,
  listDebugPlayers,
  sendAdminStatus,
  startAdminMeeting,
  startGame
} from "../services/gameService";
import { logger } from "../utils/logger";
import { safeReply } from "../utils/interactionResponses";
import { resolveCommandGuildContext } from "../utils/guildContext";

const commandLogger = logger.scoped("Command");

export async function handleAmongUsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const context = await resolveCommandGuildContext(interaction);
  if (!context.ok) {
    await safeReply(interaction, context.message);
    return;
  }

  if (!isAdminMember(context.member)) {
    await safeReply(interaction, "Nur die Spielleitung kann diesen Command benutzen.");
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  try {
    if (subcommand === "create") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const discussionTime = interaction.options.getInteger("discussion_time") ?? configDefaultDiscussion();
      const votingTime = interaction.options.getInteger("voting_time") ?? configDefaultVoting();
      if (!isValidMeetingTime(discussionTime) || !isValidMeetingTime(votingTime)) {
        await interaction.editReply("Diskussionszeit und Votingzeit muessen zwischen 1 und 15 Minuten liegen.");
        return;
      }
      const session = await createGameSession(context.guild, context.member, {
        short: interaction.options.getInteger("short") ?? 3,
        medium: interaction.options.getInteger("medium") ?? 2,
        long: interaction.options.getInteger("long") ?? 1
      }, {
        discussion: discussionTime,
        voting: votingTime
      });
      await interaction.editReply(`Session ${session.id} erstellt. Anmeldung: <#${session.lobbyChannelId}>`);
      return;
    }

    if (subcommand === "debug-create") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const discussionTime = interaction.options.getInteger("discussion_time") ?? configDefaultDiscussion();
      const votingTime = interaction.options.getInteger("voting_time") ?? configDefaultVoting();
      if (!isValidMeetingTime(discussionTime) || !isValidMeetingTime(votingTime)) {
        await interaction.editReply("Diskussionszeit und Votingzeit muessen zwischen 1 und 15 Minuten liegen.");
        return;
      }
      const ghostCount = interaction.options.getInteger("ghost_count", true);
      const session = await createDebugGameSession(context.guild, context.member, ghostCount, {
        short: interaction.options.getInteger("short") ?? 3,
        medium: interaction.options.getInteger("medium") ?? 2,
        long: interaction.options.getInteger("long") ?? 1
      }, {
        discussion: discussionTime,
        voting: votingTime
      });
      commandLogger.info("Debug-Runde erstellt.", { sessionId: session.id, ghostCount });
      await interaction.editReply(`Debug-Session ${session.id} erstellt. Anmeldung: <#${session.lobbyChannelId}>`);
      return;
    }

    if (subcommand === "clear-warns") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const user = interaction.options.getUser("user", true);
      await clearFalseReportWarningsForUser(context.guild, interaction.user.id, user.id);
      await interaction.editReply(`Verwarnungen fuer <@${user.id}> wurden zurueckgesetzt.`);
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const session = await getActiveSession(context.guildId);
    if (!session) {
      await interaction.editReply("Keine aktive Session gefunden.");
      return;
    }
    if (session.gameType !== "amongus") {
      await interaction.editReply(`Aktuell laeuft Session ${session.id}, aber sie ist keine Among-Us-Session.`);
      return;
    }

    if (subcommand === "debug-list") {
      await interaction.editReply(await listDebugPlayers(session.id));
      return;
    }

    if (subcommand === "debug-complete-task") {
      const player = interaction.options.getString("player", true);
      await interaction.editReply(await debugCompleteTask(context.guild, session.id, player));
      return;
    }

    if (subcommand === "debug-kill") {
      const victim = interaction.options.getString("victim", true);
      await interaction.editReply(await debugKillPlayer(context.guild, session.id, victim));
      return;
    }

    if (subcommand === "debug-vote") {
      const voter = interaction.options.getString("voter", true);
      const target = interaction.options.getString("target", true);
      await interaction.editReply(await debugVote(context.guild, session.id, voter, target));
      return;
    }

    if (subcommand === "start") {
      await startGame(context.guild, session.id);
      await interaction.editReply(`Session ${session.id} gestartet.`);
      return;
    }

    if (subcommand === "status") {
      await sendAdminStatus(context.guild, session.id);
      await interaction.editReply(`Status wurde in <#${session.adminChannelId}> geschrieben.`);
      return;
    }

    if (subcommand === "meeting") {
      await startAdminMeeting(context.guild, session.id);
      await interaction.editReply("Meeting wurde gestartet.");
      return;
    }

    if (subcommand === "end") {
      await endSession(context.guild, session.id);
      await interaction.editReply(`Session ${session.id} wurde beendet.`);
    }
  } catch (error) {
    commandLogger.warn("Slash Command fehlgeschlagen.", error instanceof Error ? error.message : error);
    const message = error instanceof Error ? error.message : "Unbekannter Fehler.";
    await safeReply(interaction, message);
  }
}

function configDefaultDiscussion(): number {
  return config.defaultDiscussionTimeMinutes;
}

function configDefaultVoting(): number {
  return config.defaultVotingTimeMinutes;
}

function isValidMeetingTime(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 15;
}
