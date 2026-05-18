import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  Guild,
  GuildBasedChannel,
  GuildMember,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextChannel,
  TextInputBuilder,
  TextInputStyle
} from "discord.js";
import { config } from "../config";
import { GameSession, GameType, Player, PlayerTask } from "../models/session";
import {
  addKill,
  addPlayer,
  addReport,
  addTask,
  clearFalseReportWarnings,
  clearVotes,
  createSession,
  getCrazyPostPendingPromptIds,
  getCrazyPostPlayerState,
  getCrazyPostSentences,
  getCrazyPostTexts,
  getActiveSessions,
  getAnyActiveSession,
  getActiveSession,
  getLatestActiveSession,
  getLatestSession,
  getCurrentFragwuerdigRound,
  getKillCooldown,
  getKills,
  getFalseReportWarningsForGuild,
  getFragwuerdigAnswers,
  getFragwuerdigPlayerStates,
  getFragwuerdigSettings,
  getFragwuerdigVotes,
  getPlayer,
  getPlayers,
  getReports,
  getSessionByScope,
  getSessionById,
  getTaskById,
  getTaskStepById,
  getTasks,
  getUnreportedDeadPlayers,
  getVotes,
  incrementFalseReportWarning,
  markTaskDone,
  markTaskDoneIfAllStepsDone,
  markDeathsReported,
  markTaskStepDone,
  setMeetingPhase,
  setKillCooldown,
  setLastEmergencyMeetingAt,
  setPlayerChannel,
  setPlayerRole,
  setPlayerState,
  setSessionStatus,
  setVote,
  updateSessionChannels
} from "../db/repository";
import { ids } from "../utils/customIds";
import { playerDisplay, playerLabel, progressLine } from "../utils/format";
import { logger } from "../utils/logger";
import { loadTaskCatalog, pickTasks } from "./taskService";

type Winner = "Crewmates" | "Impostors" | "nicht festgelegt";
const gameLogger = logger.scoped("GameService");

export async function createGameSession(
  guild: Guild,
  creator: GuildMember,
  counts = { short: 3, medium: 2, long: 1 },
  meetingTimes = { discussion: config.defaultDiscussionTimeMinutes, voting: config.defaultVotingTimeMinutes },
  emergencyUserId = "",
  options: { isDebugSession?: boolean; ghostCount?: number } = {}
): Promise<GameSession> {
  validateMeetingTimes(meetingTimes);
  const active = await getAnyActiveSession(guild.id);
  if (active) {
    throw new Error(`Es gibt bereits eine aktive Session: ${active.id}`);
  }

  const category = await getOrCreateAmongUsCategory(guild);
  const signup = await getOrCreateSignupChannel(guild, category.id, "amongus-anmeldung", creator.id);
  const meeting = await getOrCreateTextChannel(guild, category.id, "amongus-meeting");
  const admin = await getOrCreateAdminChannel(guild, category.id, "amongus-admin", creator.id);

  await Promise.all([
    clearBotMessages(signup),
    clearMeetingChannel(meeting),
    clearBotMessages(admin),
    clearStalePrivatePlayerChannels(guild, category.id)
  ]);

  const session = await createSession(guild.id, creator.id, emergencyUserId || null, counts, meetingTimes, options);

  if ((options.ghostCount ?? 0) > 0) {
    await createGhostPlayers(session.id, options.ghostCount ?? 0);
  }

  const joinMessage = await signup.send({
    embeds: [lobbyEmbed((await getSessionById(session.id)) as GameSession, await getPlayers(session.id))],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(joinButton(session), startButton(session))]
  });

  await updateSessionChannels(session.id, {
    categoryId: category.id,
    lobbyChannelId: signup.id,
    meetingChannelId: meeting.id,
    adminChannelId: admin.id,
    joinMessageId: joinMessage.id
  });

  const created = (await getSessionById(session.id)) as GameSession;
  gameLogger.info(options.isDebugSession ? "Debug-Runde erstellt." : "Session erstellt.", {
    sessionId: created.id,
    guildId: created.guildId,
    ghostCount: created.ghostCount
  });
  await admin.send(
    `${created.isDebugSession ? "Debug-Session" : "Session"} ${session.id} erstellt. Task-Mix: ${counts.short} short, ${counts.medium} medium, ${counts.long} long. Meeting: ${meetingTimes.discussion} Min Diskussion, ${meetingTimes.voting} Min Voting.${created.isDebugSession ? ` Ghost-Spieler: ${created.ghostCount}.` : ""}`
  );
  await sendAdminControls(admin, created);
  await sendAdminStatus(guild, session.id);
  return created;
}

export async function createDebugGameSession(
  guild: Guild,
  creator: GuildMember,
  ghostCount: number,
  counts = { short: 3, medium: 2, long: 1 },
  meetingTimes = { discussion: config.defaultDiscussionTimeMinutes, voting: config.defaultVotingTimeMinutes }
): Promise<GameSession> {
  validateGhostCount(ghostCount);
  return createGameSession(guild, creator, counts, meetingTimes, "", { isDebugSession: true, ghostCount });
}

export async function joinSession(guild: Guild, sessionId: number, member: GuildMember): Promise<void> {
  const session = await requireSession(sessionId);
  if (session.gameType !== "amongus") {
    throw new Error("Diese Session ist keine Among-Us-Session.");
  }
  if (session.guildId !== guild.id || session.status !== "lobby") {
    throw new Error("Dieser Session kann nicht mehr beigetreten werden.");
  }

  await addPlayer(session.id, member.id, member.displayName, { discordUserId: member.id, isGhost: false });
  gameLogger.debug("Spieler tritt bei.", { sessionId: session.id, userId: member.id, username: member.displayName });
  await refreshLobby(guild, session.id);
  await sendAdminStatus(guild, session.id);
}

export async function startGame(guild: Guild, sessionId: number): Promise<void> {
  const session = await requireSession(sessionId);
  assertSessionGuild(session, guild);
  if (session.gameType !== "amongus") {
    throw new Error("Diese Session ist keine Among-Us-Session.");
  }
  if (session.status !== "lobby") {
    throw new Error("Die Session ist nicht in der Anmeldephase.");
  }

  const players = await getPlayers(session.id);
  if (players.length < 3) {
    throw new Error("Mindestens 3 Spieler werden fuer V1 benoetigt.");
  }

  gameLogger.info("Spielstart.", { sessionId: session.id, playerCount: players.length, isDebugSession: session.isDebugSession });
  await setSessionStatus(session.id, "starting");
  const shuffled = [...players].sort(() => Math.random() - 0.5);
  const impostorCount = players.length >= 8 ? 2 : 1;
  const impostors = new Set(shuffled.slice(0, impostorCount).map((player) => player.userId));
  const catalog = loadTaskCatalog();

  for (const player of players) {
    const role = impostors.has(player.userId) ? "impostor" : "crewmate";
    await setPlayerRole(session.id, player.userId, role);
    for (const task of pickTasks(catalog, { short: session.shortTasks, medium: session.mediumTasks, long: session.longTasks })) {
      await addTask(session.id, player.userId, task);
    }
    gameLogger.debug("Rolle und Tasks verteilt.", { sessionId: session.id, playerId: player.userId, role });
  }

  const refreshedSession = (await getSessionById(session.id)) as GameSession;
  if (!refreshedSession.categoryId) {
    throw new Error("Session-Kategorie fehlt.");
  }

  const assignedPlayers = await getPlayers(session.id);
  for (const player of assignedPlayers) {
    if (player.isGhost || !player.discordUserId) {
      continue;
    }
    const member = await guild.members.fetch(player.userId);
    const channel = await createPrivatePlayerChannel(guild, refreshedSession.categoryId, player, member);
    await setPlayerChannel(session.id, player.userId, channel.id);
    const tasks = await getTasks(session.id, player.userId);
    await sendPlayerStartMessage(channel, { ...player, channelId: channel.id }, tasks);
  }

  await setSessionStatus(session.id, "playing");
  await refreshLobby(guild, session.id);
  await sendAdminStatus(guild, session.id);
}

export async function completeTask(guild: Guild, taskId: number, userId: string, expectedSessionId?: number): Promise<PlayerTask> {
  const existing = await getTaskById(taskId);
  if (!existing) {
    throw new Error("Task nicht gefunden.");
  }
  if (expectedSessionId !== undefined && existing.sessionId !== expectedSessionId) {
    throw new Error("Diese Session existiert nicht mehr oder gehoert zu einem anderen Server.");
  }
  if (existing.steps.length > 0) {
    throw new Error("Dieser Task hat mehrere Steps. Bitte erledige die Steps einzeln.");
  }
  if (existing.completed) {
    throw new Error("Dieser Task ist bereits abgeschlossen.");
  }

  const session = await requirePlayingSession(existing.sessionId);
  assertSessionGuild(session, guild);
  const player = await getPlayer(session.id, userId);
  if (!player) {
    throw new Error("Du bist nicht mehr Teil dieser Session.");
  }
  if (player.state === "removed") {
    throw new Error("Du bist nicht mehr Teil dieser Session.");
  }
  if (player.role !== "crewmate") {
    throw new Error("Nur Crewmates koennen echte Tasks erledigen.");
  }

  const task = await markTaskDone(taskId, userId);
  if (!task || task.userId !== userId || !task.completed) {
    throw new Error("Dieser Task gehoert nicht zu dir.");
  }

  await finishIfWinConditionReached(guild, task.sessionId);
  await sendAdminStatus(guild, task.sessionId);
  return task;
}

export async function completeTaskStep(
  guild: Guild,
  sessionId: number,
  taskId: number,
  stepRowId: number,
  userId: string
): Promise<{ task: PlayerTask; message: string }> {
  const existing = await getTaskById(taskId);
  const step = await getTaskStepById(stepRowId);
  const session = await getSessionById(sessionId);
  if (!existing || !step || step.assignedTaskId !== taskId || existing.sessionId !== sessionId || !session || session.status !== "playing") {
    throw new Error("Diese Session ist nicht mehr aktiv.");
  }
  assertSessionGuild(session, guild);

  const player = await getPlayer(session.id, userId);
  if (!player || player.state === "removed") {
    throw new Error("Du bist nicht mehr Teil dieser Session.");
  }
  if (player.role !== "crewmate") {
    throw new Error("Nur Crewmates koennen echte Tasks erledigen.");
  }
  if (existing.userId !== userId) {
    throw new Error("Dieser Step gehoert nicht zu dir.");
  }
  if (existing.completed) {
    return { task: existing, message: "Dieser Task ist bereits abgeschlossen." };
  }
  if (step.completed) {
    return { task: existing, message: "Dieser Step ist bereits erledigt." };
  }

  await markTaskStepDone(taskId, stepRowId);
  const task = await markTaskDoneIfAllStepsDone(taskId);
  if (!task) {
    throw new Error("Task nicht gefunden.");
  }

  if (task.completed) {
    await finishIfWinConditionReached(guild, task.sessionId);
    await sendAdminStatus(guild, task.sessionId);
    return { task, message: `Task abgeschlossen: ${task.title}` };
  }

  await sendAdminStatus(guild, task.sessionId);
  return { task, message: "Step als erledigt markiert." };
}

export async function killSelectMenu(guild: Guild, sessionId: number, impostorId: string): Promise<StringSelectMenuBuilder> {
  const session = await requirePlayingSession(sessionId);
  assertSessionGuild(session, guild);
  const impostor = await getPlayer(session.id, impostorId);
  if (!impostor || impostor.state === "removed") {
    throw new Error("Du bist nicht mehr Teil dieser Session.");
  }
  if (impostor.role !== "impostor" || impostor.state !== "alive") {
    throw new Error("Nur lebende Impostors koennen einen Kill melden.");
  }

  assertKillCooldownAvailable(session.id, impostorId, await getKillCooldown(session.id, impostorId));
  const targets = (await getPlayers(session.id)).filter((player) => player.role === "crewmate" && player.state === "alive");
  if (targets.length === 0) {
    throw new Error("Es gibt keine lebenden Crewmates als Ziel.");
  }

  return new StringSelectMenuBuilder()
    .setCustomId(ids.killSelect(session.guildId, session.id))
    .setPlaceholder("Getoeteten Crewmate auswaehlen")
    .addOptions(targets.slice(0, 25).map((player) => new StringSelectMenuOptionBuilder().setLabel(player.username).setValue(player.userId)));
}

export async function reportKill(guild: Guild, sessionId: number, killerId: string, victimId: string): Promise<void> {
  const session = await requirePlayingSession(sessionId);
  assertSessionGuild(session, guild);
  const killer = await getPlayer(session.id, killerId);
  const victim = await getPlayer(session.id, victimId);
  if (!killer || killer.state === "removed") {
    throw new Error("Du bist nicht mehr Teil dieser Session.");
  }
  if (killer.role !== "impostor" || killer.state !== "alive") {
    throw new Error("Nur lebende Impostors koennen einen Kill melden.");
  }
  if (!victim || victim.role !== "crewmate" || victim.state !== "alive") {
    throw new Error("Das Ziel muss ein lebender Crewmate sein.");
  }

  assertKillCooldownAvailable(session.id, killerId, await getKillCooldown(session.id, killerId));
  await setPlayerState(session.id, victim.userId, "dead");
  await addKill(session.id, killer.userId, victim.userId);
  await setKillCooldown(session.id, killer.userId, Date.now() + config.killCooldownSeconds * 1000);
  gameLogger.debug("Kill gemeldet.", { sessionId: session.id, killerId: killer.userId, victimId: victim.userId });

  await sendToPlayerChannel(
    guild,
    victim,
    "Du wurdest getoetet. Du darfst weiterhin deine Tasks erledigen, aber nicht mehr voten, keine Leichen melden und keine Spielinformationen verraten."
  );
  await sendAdminStatus(guild, session.id, `Kill gemeldet: ${playerLabel(killer)} hat ${playerLabel(victim)} getoetet.`);
  await finishIfWinConditionReached(guild, session.id);
}

export async function canOpenBodyReportModal(guild: Guild, sessionId: number, reporterId: string): Promise<boolean> {
  const session = await requirePlayingSession(sessionId);
  assertSessionGuild(session, guild);
  const reporter = await getPlayer(session.id, reporterId);
  if (!reporter || reporter.state === "removed") {
    throw new Error("Du bist nicht mehr Teil dieser Session.");
  }
  if (reporter.state !== "alive") {
    throw new Error("Nur lebende Spieler der Session koennen Leichen melden.");
  }
  return (await getUnreportedDeadPlayers(session.id)).length > 0;
}

export async function recordFalseBodyReport(guild: Guild, sessionId: number, reporterId: string): Promise<string> {
  const session = await requirePlayingSession(sessionId);
  assertSessionGuild(session, guild);
  const reporter = await getPlayer(session.id, reporterId);
  if (!reporter || reporter.state === "removed") {
    throw new Error("Du bist nicht mehr Teil dieser Session.");
  }
  if (reporter.state !== "alive") {
    throw new Error("Nur lebende Spieler der Session koennen Leichen melden.");
  }

  const warnings = await handleFalseBodyReport(guild, session, reporter);
  if (warnings >= 2) {
    return "Du wurdest wegen wiederholtem falschem Leichenmelden aus der Session entfernt.";
  }
  return "Du hast eine Leiche gemeldet, obwohl keine ungemeldete Leiche existiert. Verwarnung 1/2.";
}

export function scopedReportBodyModal(guildId: string, sessionId: number): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(ids.reportBodyModal(guildId, sessionId))
    .setTitle("Leiche melden")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("location")
          .setLabel("Wo wurde die Leiche gefunden?")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
      )
    );
}

export async function reportBody(guild: Guild, sessionId: number, reporterId: string, location: string): Promise<void> {
  const session = await requirePlayingSession(sessionId);
  assertSessionGuild(session, guild);
  const reporter = await getPlayer(session.id, reporterId);
  if (!reporter || reporter.state === "removed") {
    throw new Error("Du bist nicht mehr Teil dieser Session.");
  }
  if (reporter.state !== "alive") {
    throw new Error("Nur lebende Spieler der Session koennen Leichen melden.");
  }
  const foundBodies = await getUnreportedDeadPlayers(session.id);
  if (foundBodies.length === 0) {
    const warnings = await handleFalseBodyReport(guild, session, reporter);
    if (warnings >= 2) {
      throw new Error("Du wurdest wegen wiederholtem falschem Leichenmelden aus der Session entfernt.");
    }
    throw new Error("Du hast eine Leiche gemeldet, obwohl keine ungemeldete Leiche existiert. Verwarnung 1/2.");
  }

  for (const body of foundBodies) {
    await addReport(session.id, reporterId, location, body.userId);
  }
  gameLogger.debug("Leiche gemeldet.", { sessionId: session.id, reporterId, bodyCount: foundBodies.length, location });
  await markDeathsReported(session.id, foundBodies.map((body) => body.userId));
  await clearVotes(session.id);
  await setSessionStatus(session.id, "meeting");
  await setMeetingPhase(session.id, "called", { discussionStartedAt: null, votingStartedAt: null });
  await restartKillCooldowns(session.id);
  await sendMeetingCalledMessage(guild, session.id, buildBodyReportReason(reporterId, location, foundBodies));
  await sendAdminStatus(guild, session.id);
}

async function handleFalseBodyReport(guild: Guild, session: GameSession, reporter: Player): Promise<number> {
  const warnings = await incrementFalseReportWarning(guild.id, reporter.userId);
  if (warnings < 2) {
    gameLogger.debug("False-Report erkannt.", { sessionId: session.id, reporterId: reporter.userId, warnings });
    await sendAdminStatus(guild, session.id, `${playerLabel(reporter)} hat einen falschen Leichenreport ausgeloest. Verwarnung 1/2.`);
    return warnings;
  }

  await removePlayerForFalseReports(guild, session, reporter, warnings);
  return warnings;
}

async function removePlayerForFalseReports(guild: Guild, session: GameSession, player: Player, warnings: number): Promise<void> {
  await setPlayerState(session.id, player.userId, "removed");
  const privateChannel = await getTextChannel(guild, player.channelId);
  await privateChannel?.send("Du wurdest wegen wiederholtem falschem Leichenmelden aus der Session entfernt.").catch(() => null);
  await privateChannel?.permissionOverwrites.edit(player.userId, { ViewChannel: false }).catch((error) => {
    gameLogger.error(`Could not revoke private channel access for ${player.userId}.`, error);
  });

  const publicMessage = `${playerLabel(player)} wurde wegen wiederholtem falschem Leichenmelden aus der Session entfernt.`;
  await sendPublicSessionMessage(guild, session, publicMessage);
  await sendAdminStatus(
    guild,
    session.id,
    `${playerLabel(player)} hat erneut einen falschen Leichenreport ausgeloest und wurde automatisch aus der Session entfernt. Verwarnungen: ${warnings}/2.`
  );
  await finishIfWinConditionReached(guild, session.id);
}

export async function startAdminMeeting(guild: Guild, sessionId: number): Promise<void> {
  const session = await requirePlayingSession(sessionId);
  assertSessionGuild(session, guild);
  await clearVotes(session.id);
  await setSessionStatus(session.id, "meeting");
  await setMeetingPhase(session.id, "called", { discussionStartedAt: null, votingStartedAt: null });
  await restartKillCooldowns(session.id);
  gameLogger.debug("Meeting gestartet.", { sessionId: session.id, source: "admin" });
  await sendMeetingCalledMessage(guild, session.id, "Admin hat Meeting gestartet");
  await sendAdminStatus(guild, session.id);
}

export async function startEmergencyMeeting(guild: Guild, sessionId: number, userId: string): Promise<void> {
  const session = await requireSession(sessionId);
  assertSessionGuild(session, guild);
  if (session.status === "ended" || session.status === "cancelled") {
    throw new Error("Diese Session ist bereits beendet.");
  }
  if (session.status !== "playing") {
    throw new Error("Gerade ist kein Emergency Meeting moeglich.");
  }

  const remaining = getEmergencyCooldownRemainingSeconds(session);
  if (remaining > 0) {
    throw new Error(`Emergency Meeting ist noch im Cooldown. Verbleibend: ${formatDuration(remaining)}.`);
  }

  await clearVotes(session.id);
  await setLastEmergencyMeetingAt(session.id, Date.now());
  await setSessionStatus(session.id, "meeting");
  await setMeetingPhase(session.id, "called", { discussionStartedAt: null, votingStartedAt: null });
  await restartKillCooldowns(session.id);
  gameLogger.debug("Meeting gestartet.", { sessionId: session.id, source: "emergency", userId });
  await sendMeetingCalledMessage(guild, session.id, `Emergency Meeting wurde einberufen.\nEinberufen durch ${playerLabel({ userId, discordUserId: userId, isGhost: false, username: userId })}.`);
  await sendAdminStatus(guild, session.id);
}

export async function clearFalseReportWarningsForUser(guild: Guild, adminId: string, userId: string): Promise<void> {
  await clearFalseReportWarnings(guild.id, userId);
  const session = await getActiveSession(guild.id);
  if (session) {
    const admin = await getTextChannel(guild, session.adminChannelId);
    await admin?.send(`<@${adminId}> hat die False-Report-Verwarnungen von <@${userId}> zurueckgesetzt.`);
    await sendAdminStatus(guild, session.id);
  }
}

export async function castVote(guild: Guild, sessionId: number, voterId: string, targetUserId: string): Promise<string> {
  const session = await requireSession(sessionId);
  assertSessionGuild(session, guild);
  if (session.status === "ended" || session.status === "cancelled") {
    throw new Error("Diese Session ist bereits beendet.");
  }
  if (session.status !== "meeting") {
    throw new Error("Aktuell laeuft kein Meeting.");
  }
  if (session.meetingPhase !== "voting") {
    throw new Error("Das Voting wurde noch nicht gestartet.");
  }

  const voter = await getPlayer(session.id, voterId);
  if (!voter || voter.state === "removed") {
    throw new Error("Du bist nicht mehr Teil dieser Session.");
  }
  if (voter.state !== "alive") {
    throw new Error("Nur lebende Spieler koennen voten.");
  }

  await setVote(session.id, voterId, targetUserId);
  gameLogger.debug("Stimme abgegeben.", { sessionId: session.id, voterId, targetUserId });
  const players = await getPlayers(session.id);
  const alivePlayers = players.filter((player) => player.state === "alive");
  const votes = await getVotes(session.id);

  await sendAdminStatus(guild, session.id);
  return `Vote gespeichert (${votes.length}/${alivePlayers.length}).`;
}

export async function evaluateVoting(guild: Guild, sessionId: number): Promise<string> {
  const session = await requireSession(sessionId);
  if (session.status === "ended" || session.status === "cancelled") {
    throw new Error("Diese Session ist bereits beendet.");
  }
  if (session.status !== "meeting" || session.meetingPhase !== "voting") {
    throw new Error("Aktuell laeuft kein Voting.");
  }

  const players = await getPlayers(session.id);
  const votes = await getVotes(session.id);
  if (votes.length === 0) {
    throw new Error("Es wurden noch keine Stimmen abgegeben.");
  }
  const counts = new Map<string, number>();
  for (const vote of votes) {
    counts.set(vote.targetUserId, (counts.get(vote.targetUserId) || 0) + 1);
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [winner, topCount] = sorted[0];
  const tied = sorted.filter(([, count]) => count === topCount).length > 1;
  const meeting = await getTextChannel(guild, session.meetingChannelId);

  if (tied || winner === "skip") {
    await meeting?.send("Voting beendet: Niemand fliegt raus.");
  } else {
    await setPlayerState(session.id, winner, "ejected");
    const winnerPlayer = players.find((player) => player.userId === winner);
    await meeting?.send(`Voting beendet: ${winnerPlayer ? playerLabel(winnerPlayer) : winner} wurde rausgewaehlt.`);
  }

  await clearVotes(session.id);
  await setMeetingPhase(session.id, "result");
  const ended = await finishIfWinConditionReached(guild, session.id);
  if (!ended) {
    await setSessionStatus(session.id, "playing");
    await restartKillCooldowns(session.id);
    await meeting?.send("Das Spiel wird fortgesetzt.");
  }

  await sendAdminStatus(guild, session.id);
  gameLogger.debug("Voting ausgewertet.", { sessionId: session.id, votes: votes.length, winner });
  return "Voting abgeschlossen.";
}

export async function startMeetingDiscussion(guild: Guild, sessionId?: number): Promise<void> {
  const session = sessionId ? await requireSession(sessionId) : await requireLatestActiveSession(guild.id);
  assertSessionGuild(session, guild);
  if (session.status !== "meeting" || session.meetingPhase !== "called") {
    throw new Error("Diskussion kann nur in der Meetingphase called gestartet werden.");
  }
  const startedAt = Date.now();
  await setMeetingPhase(session.id, "discussion", { discussionStartedAt: startedAt });
  gameLogger.debug("Diskussion gestartet.", { sessionId: session.id, startedAt });
  const meeting = await getTextChannel(guild, session.meetingChannelId);
  await meeting?.send([
    "**Diskussion gestartet.**",
    `Diskussionszeit: ${session.discussionTimeMinutes} Minuten`,
    `Gestartet um: ${formatClock(startedAt)}`
  ].join("\n"));
  await sendAdminStatus(guild, session.id);
}

export async function startMeetingVoting(guild: Guild, sessionId?: number): Promise<void> {
  const session = sessionId ? await requireSession(sessionId) : await requireLatestActiveSession(guild.id);
  assertSessionGuild(session, guild);
  if (session.status !== "meeting" || (session.meetingPhase !== "discussion" && session.meetingPhase !== "called")) {
    throw new Error("Voting kann nur in einer laufenden oder aufgerufenen Meetingphase gestartet werden.");
  }
  const startedAt = Date.now();
  await clearVotes(session.id);
  await setMeetingPhase(session.id, "voting", { votingStartedAt: startedAt });
  gameLogger.debug("Voting gestartet.", { sessionId: session.id, startedAt });
  await sendVotingMessage(guild, session.id, startedAt);
  await sendAdminStatus(guild, session.id);
}

export async function startEmergencyMeetingFromWeb(guild: Guild, sessionId: number): Promise<void> {
  const session = await requireSession(sessionId);
  assertSessionGuild(session, guild);
  if (session.gameType !== "amongus") {
    throw new Error("Emergency Meetings sind nur fuer AmongUs-Sessions verfuegbar.");
  }
  if (session.status !== "playing") {
    throw new Error("Gerade ist kein Emergency Meeting moeglich.");
  }
  const remaining = getEmergencyCooldownRemainingSeconds(session);
  if (remaining > 0) {
    throw new Error(`Emergency Meeting ist noch im Cooldown. Verbleibend: ${formatDuration(remaining)}.`);
  }

  await clearVotes(session.id);
  await setLastEmergencyMeetingAt(session.id, Date.now());
  await setSessionStatus(session.id, "meeting");
  await setMeetingPhase(session.id, "called", { discussionStartedAt: null, votingStartedAt: null });
  await restartKillCooldowns(session.id);
  gameLogger.debug("Meeting gestartet.", { sessionId: session.id, source: "webpanel-emergency" });
  await sendMeetingCalledMessage(guild, session.id, "Emergency Meeting wurde einberufen.");
  await sendAdminStatus(guild, session.id);
}

export async function sendAdminStatus(guild: Guild, sessionId: number, prefix?: string): Promise<void> {
  const session = await requireSession(sessionId);
  const admin = await getTextChannel(guild, session.adminChannelId);
  if (!admin) {
    return;
  }
  if (prefix) {
    await admin.send(prefix);
  }
  await admin.send({ embeds: [await statusEmbed(session)] });
}

export async function endSessionFromAdmin(guild: Guild, gameType: GameType, sessionId: number): Promise<void> {
  const session = await getSessionByScope(guild.id, gameType, sessionId);
  if (!session) {
    throw new Error("Session wurde nicht gefunden.");
  }
  assertSessionGuild(session, guild);
  if (session.gameType === "amongus") {
    await endSession(guild, session.id);
    return;
  }

  await setSessionStatus(session.id, session.gameType === "fragwuerdig" ? "finished" : "ended");
  const admin = await getTextChannel(guild, session.adminChannelId);
  await admin?.send(`${gameLabel(session.gameType)}-Session ${session.id} wurde ueber das Adminpanel beendet.`).catch(() => null);
  gameLogger.info("Session ueber Adminpanel beendet.", { guildId: guild.id, sessionId: session.id, gameType: session.gameType });
}

export async function getPublicWebPanelStatus(guildId: string, sessionId: number): Promise<object> {
  const session = await getSessionByScope(guildId, "amongus", sessionId);
  if (!session) {
    return { active: false, message: "Diese AmongUs-Session wurde nicht gefunden." };
  }

  const votes = await getVotes(session.id);
  const players = await getPlayers(session.id);
  const tasks = await getTasks(session.id);
  const progress = await getCrewmateTaskProgress(session.id, players, tasks);
  const eligibleVoters = players.filter((player) => player.state === "alive");
  const emergencyRemainingSeconds = getEmergencyCooldownRemainingSeconds(session);
  const isActive = session.status !== "ended" && session.status !== "cancelled";

  return {
    active: isActive,
    message: isActive ? undefined : "Session beendet.",
    session: {
      id: session.id,
      guildId: session.guildId,
      status: session.status,
      meetingStatus: session.status === "meeting" ? session.meetingPhase : "none",
      meetingPhase: session.meetingPhase,
      discussionStartedAt: session.discussionStartedAt,
      votingStartedAt: session.votingStartedAt,
      discussionTimeMinutes: session.discussionTimeMinutes,
      votingTimeMinutes: session.votingTimeMinutes,
      endedAt: session.endedAt
    },
    taskProgress: progress,
    emergency: {
      cooldownReady: emergencyRemainingSeconds === 0,
      cooldownRemainingSeconds: emergencyRemainingSeconds,
      cooldownSeconds: session.emergencyCooldownSeconds,
      lastEmergencyMeetingAt: session.lastEmergencyMeetingAt
    },
    voting: {
      startedAt: session.votingStartedAt,
      votesCast: votes.length,
      eligibleVoters: eligibleVoters.length
    },
    meeting: {
      phase: session.meetingPhase,
      reason: session.status === "meeting" ? "Siehe Meeting-Kanal." : null,
      discussionStartedAt: session.discussionStartedAt,
      votingStartedAt: session.votingStartedAt,
      discussionTimeMinutes: session.discussionTimeMinutes,
      votingTimeMinutes: session.votingTimeMinutes
    }
  };
}

export async function getAdminSessionStatus(guildId: string, gameType: GameType, sessionId: number): Promise<object> {
  const session = await getSessionByScope(guildId, gameType, sessionId);
  if (!session) {
    return { active: false, message: "Session wurde nicht gefunden." };
  }

  const players = await getPlayers(session.id);
  const isActive = session.status !== "ended" && session.status !== "cancelled";
  const base = {
    active: isActive,
    message: isActive ? undefined : "Session beendet.",
    guildId: session.guildId,
    sessionId: session.id,
    gameType: session.gameType,
    status: session.status,
    debug: session.isDebugSession,
    createdAt: session.createdAt,
    updatedAt: session.endedAt ?? session.createdAt,
    session: {
      id: session.id,
      guildId: session.guildId,
      gameType: session.gameType,
      status: session.status,
      meetingStatus: session.status === "meeting" ? session.meetingPhase : "none",
      meetingPhase: session.meetingPhase,
      discussionStartedAt: session.discussionStartedAt,
      votingStartedAt: session.votingStartedAt,
      discussionTimeMinutes: session.discussionTimeMinutes,
      votingTimeMinutes: session.votingTimeMinutes,
      endedAt: session.endedAt,
      isDebugSession: session.isDebugSession,
      ghostCount: session.ghostCount
    }
  };

  if (session.gameType === "amongus") {
    return { ...base, ...(await buildAmongUsAdminSession(session, players)) };
  }
  if (session.gameType === "crazy_post") {
    return { ...base, ...(await buildCrazyPostAdminSession(session, players)) };
  }
  if (session.gameType === "fragwuerdig") {
    return { ...base, ...(await buildFragwuerdigAdminSession(session, players)) };
  }

  return { ...base, ...buildFallbackAdminSession(session, players) };
}

async function buildAmongUsAdminSession(session: GameSession, players: Player[]): Promise<object> {
  const tasks = await getTasks(session.id);
  const votes = await getVotes(session.id);
  const progress = await getCrewmateTaskProgress(session.id, players, tasks);
  const eligibleVoters = players.filter((player) => player.state === "alive");
  const emergencyRemainingSeconds = getEmergencyCooldownRemainingSeconds(session);
  return {
    summary: {
      phase: session.meetingPhase === "none" ? session.status : session.meetingPhase,
      votesCurrent: votes.length,
      votesRequired: eligibleVoters.length,
      emergencyCooldown: emergencyRemainingSeconds,
      aliveCount: players.filter((player) => player.state === "alive").length,
      deadCount: players.filter((player) => player.state === "dead").length,
      removedCount: players.filter((player) => player.state === "removed").length
    },
    players: {
      total: players.length,
      alive: players.filter((player) => player.state === "alive").length,
      dead: players.filter((player) => player.state === "dead").length,
      removed: players.filter((player) => player.state === "removed").length,
      list: players.map((player) => ({
        userId: player.userId,
        isGhost: player.isGhost,
        discordUserId: player.discordUserId,
        username: player.username,
        role: player.role,
        state: player.state,
        tasks: playerProgress(tasks.filter((task) => task.userId === player.userId)),
        votes: votes.filter((vote) => vote.voterId === player.userId).length
      }))
    },
    actions: ["start_discussion", "start_voting", "evaluate_voting", "end_session", "kick_player"],
    taskProgress: progress,
    emergency: {
      cooldownReady: emergencyRemainingSeconds === 0,
      cooldownRemainingSeconds: emergencyRemainingSeconds,
      cooldownSeconds: session.emergencyCooldownSeconds,
      lastEmergencyMeetingAt: session.lastEmergencyMeetingAt
    },
    voting: {
      startedAt: session.votingStartedAt,
      votesCast: votes.length,
      eligibleVoters: eligibleVoters.length
    },
    meeting: {
      phase: session.meetingPhase,
      reason: session.status === "meeting" ? "Siehe Meeting-Kanal." : null,
      discussionStartedAt: session.discussionStartedAt,
      votingStartedAt: session.votingStartedAt,
      discussionTimeMinutes: session.discussionTimeMinutes,
      votingTimeMinutes: session.votingTimeMinutes
    }
  };
}

async function buildCrazyPostAdminSession(session: GameSession, players: Player[]): Promise<object> {
  const texts = await getCrazyPostTexts(session.id);
  const sentencesByText = new Map<number, Awaited<ReturnType<typeof getCrazyPostSentences>>>();
  for (const text of texts) {
    sentencesByText.set(text.id, await getCrazyPostSentences(text.id));
  }

  const list = [];
  let totalQueuedSentences = 0;
  let totalPendingSubmissions = 0;
  for (const player of players) {
    const state = await getCrazyPostPlayerState(session.id, player.userId);
    const queuedIds = await getCrazyPostPendingPromptIds(session.id, player.userId);
    const submittedSentences = [...sentencesByText.values()].flat().filter((sentence) => sentence.authorId === player.userId);
    totalQueuedSentences += queuedIds.length;
    if (state?.activeTextId) {
      totalPendingSubmissions += 1;
    }
    list.push({
      userId: player.userId,
      isGhost: player.isGhost,
      discordUserId: player.discordUserId,
      username: player.username,
      state: crazyPostPlayerStatus(player, Boolean(state?.activeTextId), queuedIds.length, texts.length > 0 && texts.every((text) => text.finished)),
      removed: player.state === "removed",
      activeTextId: state?.activeTextId ?? null,
      hasOpenAnswer: Boolean(state?.activeTextId),
      queuedSentenceCount: queuedIds.length,
      submittedSentenceCount: submittedSentences.length,
      lastSubmissionAt: submittedSentences.length > 0 ? submittedSentences[submittedSentences.length - 1].createdAt : null
    });
  }

  return {
    summary: {
      phase: session.status,
      totalStories: texts.length,
      finishedStories: texts.filter((text) => text.finished).length,
      activeStories: texts.filter((text) => !text.finished).length,
      totalQueuedSentences,
      totalPendingSubmissions,
      textCollectionChannelId: null,
      adminLogChannelId: session.adminChannelId
    },
    players: {
      total: players.length,
      active: players.filter((player) => player.state !== "removed").length,
      removed: players.filter((player) => player.state === "removed").length,
      list
    },
    actions: ["end_session", "kick_player"]
  };
}

async function buildFragwuerdigAdminSession(session: GameSession, players: Player[]): Promise<object> {
  const settings = await getFragwuerdigSettings(session.id);
  const states = await getFragwuerdigPlayerStates(session.id);
  const stateByPlayer = new Map(states.map((state) => [state.userId, state]));
  const round = await getCurrentFragwuerdigRound(session.id);
  const answers = round ? await getFragwuerdigAnswers(round.id) : [];
  const votes = round ? await getFragwuerdigVotes(round.id) : [];
  const answerByPlayer = new Set(answers.map((answer) => answer.playerId));
  const impostorIds = new Set(round?.impostorIds ?? []);

  return {
    summary: {
      phase: session.status,
      answersSubmitted: answers.length,
      playerCount: players.length,
      waitingQueueCount: states.filter((state) => state.queueState === "waiting").length,
      impostorCount: settings?.impostorCount ?? 0,
      votingActive: round?.status === "voting" || session.status === "voting",
      votesCurrent: votes.length
    },
    players: {
      total: players.length,
      active: players.filter((player) => player.state !== "removed").length,
      removed: players.filter((player) => player.state === "removed").length,
      list: players.map((player) => {
        const state = stateByPlayer.get(player.userId);
        const answered = answerByPlayer.has(player.userId);
        return {
          userId: player.userId,
          isGhost: player.isGhost,
          discordUserId: player.discordUserId,
          username: player.username,
          state: fragwuerdigPlayerStatus(player, state?.queueState ?? null, answered),
          removed: player.state === "removed",
          answered,
          queueState: state?.queueState ?? null,
          isImpostor: impostorIds.has(player.userId)
        };
      })
    },
    actions: ["end_session", "kick_player"]
  };
}

function buildFallbackAdminSession(session: GameSession, players: Player[]): object {
  return {
    warning: "Für diesen Spieltyp gibt es noch keine spezifische Adminansicht.",
    summary: {
      guildId: session.guildId,
      gameType: session.gameType,
      status: session.status,
      playerCount: players.length,
      debug: session.isDebugSession,
      channels: {
        lobbyChannelId: session.lobbyChannelId,
        meetingChannelId: session.meetingChannelId,
        adminChannelId: session.adminChannelId,
        emergencyChannelId: session.emergencyChannelId
      }
    },
    players: {
      total: players.length,
      list: players.map((player) => ({
        userId: player.userId,
        username: player.username,
        state: player.state,
        isGhost: player.isGhost
      }))
    },
    actions: ["end_session"]
  };
}

function crazyPostPlayerStatus(player: Player, hasOpenAnswer: boolean, queuedCount: number, allFinished: boolean): string {
  if (player.state === "removed") return "entfernt";
  if (hasOpenAnswer) return "schreibt gerade";
  if (queuedCount > 0) return "wartet";
  if (allFinished) return "fertig";
  return "aktiv";
}

function fragwuerdigPlayerStatus(player: Player, queueState: string | null, answered: boolean): string {
  if (player.state === "removed") return "entfernt";
  if (queueState === "waiting") return "in Warteschlange";
  if (answered) return "hat geantwortet";
  if (queueState === "active") return "aktiv";
  if (queueState === "left") return "entfernt";
  return "wartet";
}

export async function getAdminPanelOverview(
  guildIds: string[],
  guildNameResolver: (guildId: string) => Promise<string | null>
): Promise<object> {
  const sessions = await getActiveSessions(guildIds);
  const guildNames = new Map<string, string | null>();
  const visibleGuildIds = [...new Set([...guildIds, ...sessions.map((session) => session.guildId)])];
  for (const guildId of visibleGuildIds) {
    guildNames.set(guildId, await guildNameResolver(guildId));
  }

  const rows = [];
  for (const session of sessions) {
    const players = await getPlayers(session.id);
    const detail = await getAdminSessionStatus(session.guildId, session.gameType, session.id) as { summary?: object };
    rows.push({
      guildId: session.guildId,
      guildName: guildNames.get(session.guildId) ?? null,
      gameType: session.gameType,
      sessionId: session.id,
      status: session.status,
      meetingPhase: session.meetingPhase,
      playerCount: players.length,
      activePlayers: players.filter((player) => player.state !== "removed").length,
      ghostCount: players.filter((player) => player.isGhost).length,
      isDebugSession: session.isDebugSession,
      createdAt: session.createdAt,
      runtimeSeconds: Math.max(0, Math.floor((Date.now() - new Date(session.createdAt).getTime()) / 1000)),
      channels: {
        lobbyChannelId: session.lobbyChannelId,
        meetingChannelId: session.meetingChannelId,
        adminChannelId: session.adminChannelId,
        emergencyChannelId: session.emergencyChannelId
      },
      summary: detail.summary ?? null
    });
  }

  return {
    ok: true,
    guilds: visibleGuildIds.map((guildId) => ({ guildId, guildName: guildNames.get(guildId) ?? null })),
    sessions: rows
  };
}

export async function sendAdminControlsForSession(guild: Guild, sessionId: number): Promise<void> {
  const session = await requireSession(sessionId);
  assertSessionGuild(session, guild);
  const admin = await getTextChannel(guild, session.adminChannelId);
  if (admin) {
    await sendAdminControls(admin, session);
  }
}

export async function endSession(guild: Guild, sessionId: number): Promise<void> {
  await finishSession(guild, sessionId, "nicht festgelegt", "Admin hat Spiel beendet");
}

export async function cancelAndDeleteSession(guild: Guild, sessionId: number): Promise<string> {
  const session = await requireSession(sessionId);
  assertSessionGuild(session, guild);
  if (session.status !== "ended") {
    await setSessionStatus(session.id, "cancelled");
  }
  await sendAdminStatus(guild, session.id, "Session wird geloescht.");
  return deleteSessionChannels(guild, session.id);
}

export async function deleteSessionChannels(guild: Guild, sessionId: number): Promise<string> {
  const session = await requireSession(sessionId);
  assertSessionGuild(session, guild);
  const idsToDelete = [
    session.lobbyChannelId,
    session.meetingChannelId,
    session.emergencyChannelId,
    session.adminChannelId,
    ...(await getPlayers(session.id)).map((player) => player.channelId)
  ].filter(Boolean) as string[];

  const failed: string[] = [];
  for (const channelId of idsToDelete) {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      continue;
    }
    const deleted = await channel.delete("Among Us Session aufgeraeumt").then(() => true).catch((error) => {
      gameLogger.error(`Session channel ${channelId} could not be deleted.`, error);
      return false;
    });
    if (!deleted) {
      failed.push(channelId);
    }
  }

  const category = session.categoryId ? await guild.channels.fetch(session.categoryId).catch(() => null) : null;
  if (category?.type === ChannelType.GuildCategory && category.children.cache.size === 0) {
    await category.delete("Among Us Session aufgeraeumt").catch((error) => {
      failed.push(category.id);
      gameLogger.error(`Session category ${category.id} could not be deleted.`, error);
    });
  }

  return failed.length
    ? `Einige Session-Kanaele konnten nicht geloescht werden: ${failed.map((id) => `<#${id}>`).join(", ")}`
    : "Session aufgeraeumt. Alle Session-Kanaele wurden geloescht.";
}

export async function refreshLobby(guild: Guild, sessionId: number): Promise<void> {
  const session = await requireSession(sessionId);
  assertSessionGuild(session, guild);
  // Historisches DB-Feld: lobbyChannelId steht fachlich fuer den Anmeldekanal.
  const registration = await getTextChannel(guild, session.lobbyChannelId);
  if (!registration || !session.joinMessageId) {
    return;
  }

  const players = await getPlayers(session.id);
  const message = await registration.messages.fetch(session.joinMessageId).catch(() => null);
  await message?.edit({
    embeds: [lobbyEmbed(session, players)],
    components:
      session.status === "lobby"
        ? [new ActionRowBuilder<ButtonBuilder>().addComponents(joinButton(session), startButton(session))]
        : []
  });
}

export async function listDebugPlayers(sessionId: number): Promise<string> {
  const session = await requireDebugSession(sessionId);
  const players = await getPlayers(session.id);
  const tasks = await getTasks(session.id);
  const ghosts = players.filter((player) => player.isGhost);
  if (ghosts.length === 0) {
    return "Keine Ghost-Spieler vorhanden.";
  }

  return ghosts.map((player) => {
    const playerTasks = tasks.filter((task) => task.userId === player.userId);
    return `${player.username} | ID: ${player.userId} | Rolle: ${player.role ?? "-"} | Status: ${player.state} | Tasks: ${playerProgress(playerTasks).done}/${playerTasks.length}`;
  }).join("\n");
}

export async function debugCompleteTask(guild: Guild, sessionId: number, identifier: string): Promise<string> {
  const session = await requireDebugSession(sessionId);
  if (session.status !== "playing") {
    throw new Error("Ghost-Tasks koennen nur waehrend des Spiels abgeschlossen werden.");
  }

  const player = await resolveGhostPlayer(session.id, identifier);
  if (player.role !== "crewmate") {
    throw new Error("Nur Ghost-Crewmates koennen ueber diesen Command Tasks erledigen.");
  }

  const tasks = await getTasks(session.id, player.userId);
  const nextTask = tasks.find((task) => !task.completed);
  if (!nextTask) {
    throw new Error("Dieser Ghost-Spieler hat keine offenen Tasks mehr.");
  }

  const nextStep = nextTask.steps.find((step) => !step.completed);
  if (nextStep) {
    await markTaskStepDone(nextTask.id, nextStep.id);
    const updatedTask = await markTaskDoneIfAllStepsDone(nextTask.id);
    await finishIfWinConditionReached(guild, session.id);
    await sendAdminStatus(guild, session.id, `Ghost-Task-Step erledigt: ${player.username} -> ${nextTask.title} / ${nextStep.title}`);
    gameLogger.debug("Multi-Step-Task-Step erledigt.", { sessionId, playerId: player.userId, taskId: nextTask.id, stepId: nextStep.id });
    return updatedTask?.completed
      ? `${player.username} hat den letzten Step erledigt. Task abgeschlossen: ${nextTask.title}.`
      : `${player.username} hat den Step "${nextStep.title}" erledigt.`;
  }

  await markTaskDone(nextTask.id, player.userId);
  await finishIfWinConditionReached(guild, session.id);
  await sendAdminStatus(guild, session.id, `Ghost-Task erledigt: ${player.username} -> ${nextTask.title}`);
  gameLogger.debug("Task erledigt.", { sessionId, playerId: player.userId, taskId: nextTask.id });
  return `${player.username} hat den Task "${nextTask.title}" erledigt.`;
}

export async function debugKillPlayer(guild: Guild, sessionId: number, identifier: string): Promise<string> {
  const session = await requireDebugSession(sessionId);
  if (session.status !== "playing") {
    throw new Error("Ghost-Kills koennen nur waehrend des Spiels simuliert werden.");
  }

  const victim = await resolveGhostPlayer(session.id, identifier);
  if (victim.state !== "alive") {
    throw new Error("Dieser Ghost-Spieler lebt nicht mehr.");
  }

  await setPlayerState(session.id, victim.userId, "dead");
  await addKill(session.id, "debug:system", victim.userId);
  await sendAdminStatus(guild, session.id, `Debug-Kill: ${victim.username} wurde als tot markiert.`);
  await finishIfWinConditionReached(guild, session.id);
  gameLogger.debug("Ghost-Spieler getoetet.", { sessionId, victimId: victim.userId });
  return `${victim.username} wurde als ungemeldete Leiche markiert.`;
}

export async function debugVote(guild: Guild, sessionId: number, voterIdentifier: string, targetIdentifier: string): Promise<string> {
  const session = await requireDebugSession(sessionId);
  if (session.status !== "meeting" || session.meetingPhase !== "voting") {
    throw new Error("Ghost-Stimmen koennen nur waehrend einer Votingphase abgegeben werden.");
  }

  const voter = await resolveGhostPlayer(session.id, voterIdentifier);
  if (voter.state !== "alive") {
    throw new Error("Nur lebende Ghost-Spieler koennen abstimmen.");
  }

  const targetId = targetIdentifier.toLowerCase() === "skip"
    ? "skip"
    : (await resolvePlayerByIdentifier(session.id, targetIdentifier)).userId;

  await setVote(session.id, voter.userId, targetId);
  await sendAdminStatus(guild, session.id, `Ghost-Vote: ${voter.username} -> ${targetId === "skip" ? "skip" : labelForPlayerId(await getPlayers(session.id), targetId)}`);
  gameLogger.debug("Ghost-Stimme abgegeben.", { sessionId, voterId: voter.userId, targetId });
  const votes = await getVotes(session.id);
  const players = await getPlayers(session.id);
  return `Vote gespeichert (${votes.length}/${players.filter((player) => player.state === "alive").length}).`;
}

export async function kickPlayerFromAdmin(guild: Guild, sessionId: number, playerId: string): Promise<string> {
  const session = await requireSession(sessionId);
  assertSessionGuild(session, guild);
  const player = await getPlayer(session.id, playerId);
  if (!player) {
    throw new Error("Spieler ist nicht Teil der aktiven Session.");
  }
  if (player.state === "removed") {
    throw new Error("Dieser Spieler wurde bereits entfernt.");
  }

  await setPlayerState(session.id, player.userId, "removed");
  const privateChannel = await getTextChannel(guild, player.channelId);
  await privateChannel?.send("Du wurdest aus der Session entfernt.").catch(() => null);
  if (privateChannel) {
    await privateChannel.delete("Spieler ueber Adminpanel aus der Session entfernt").catch((error) => {
      gameLogger.error(`Private player channel ${privateChannel.id} could not be deleted after kick.`, error);
    });
  }

  const message = `${playerLabel(player)}${player.isGhost ? " (Ghost)" : ""} wurde ueber das Adminpanel aus der Session entfernt.`;
  if (session.gameType === "amongus") {
    await sendAdminStatus(guild, session.id, message);
    await finishIfWinConditionReached(guild, session.id);
  } else {
    const admin = await getTextChannel(guild, session.adminChannelId);
    await admin?.send(message).catch(() => null);
  }
  gameLogger.info("Spieler ueber Adminpanel entfernt.", { sessionId: session.id, playerId: player.userId, isGhost: player.isGhost });
  return message;
}

async function finishIfWinConditionReached(guild: Guild, sessionId: number): Promise<boolean> {
  const session = await requireSession(sessionId);
  if (session.status === "ended" || session.status === "cancelled" || session.status === "lobby" || session.status === "starting") {
    return session.status === "ended" || session.status === "cancelled";
  }

  const players = await getPlayers(sessionId);
  const tasks = await getTasks(sessionId);
  const crewmates = players.filter((player) => player.role === "crewmate" && player.state !== "removed");
  const aliveCrewmates = crewmates.filter((player) => player.state === "alive");
  const aliveImpostors = players.filter((player) => player.role === "impostor" && player.state === "alive");
  const crewmateIds = new Set(crewmates.map((player) => player.userId));
  const realTasks = tasks.filter((task) => crewmateIds.has(task.userId));

  if (realTasks.length > 0 && realTasks.every((task) => task.completed)) {
    gameLogger.debug("Siegbedingungen geprueft.", { sessionId, result: "CrewmatesTasks" });
    await finishSession(guild, sessionId, "Crewmates", "alle Tasks erledigt");
    return true;
  }

  if (aliveImpostors.length === 0) {
    gameLogger.debug("Siegbedingungen geprueft.", { sessionId, result: "CrewmatesImpostorsOut" });
    await finishSession(guild, sessionId, "Crewmates", "alle Impostors ausgeschieden");
    return true;
  }

  if (aliveImpostors.length >= aliveCrewmates.length) {
    gameLogger.debug("Siegbedingungen geprueft.", { sessionId, result: "ImpostorsParity", aliveImpostors: aliveImpostors.length, aliveCrewmates: aliveCrewmates.length });
    await finishSession(guild, sessionId, "Impostors", "Impostors haben zahlenmaessige Mehrheit/Gleichstand erreicht");
    return true;
  }

  gameLogger.debug("Siegbedingungen geprueft.", { sessionId, result: "continue", aliveImpostors: aliveImpostors.length, aliveCrewmates: aliveCrewmates.length });
  return false;
}

async function requireDebugSession(sessionId: number): Promise<GameSession> {
  const session = await requireSession(sessionId);
  if (!session.isDebugSession) {
    throw new Error("Diese Funktion ist nur in Debug-Runden verfuegbar.");
  }
  return session;
}

async function resolveGhostPlayer(sessionId: number, identifier: string): Promise<Player> {
  const player = await resolvePlayerByIdentifier(sessionId, identifier);
  if (!player.isGhost) {
    throw new Error("Bitte einen Ghost-Spieler angeben.");
  }
  return player;
}

async function resolvePlayerByIdentifier(sessionId: number, identifier: string): Promise<Player> {
  const players = await getPlayers(sessionId);
  const normalized = identifier.trim().toLowerCase();
  const match = players.find((player) => player.userId.toLowerCase() === normalized || player.username.toLowerCase() === normalized);
  if (!match) {
    throw new Error(`Spieler nicht gefunden: ${identifier}`);
  }
  return match;
}

async function createGhostPlayers(sessionId: number, ghostCount: number): Promise<void> {
  for (let index = 1; index <= ghostCount; index += 1) {
    const userId = `ghost:${sessionId}:${index}`;
    const username = `Ghost ${index}`;
    await addPlayer(sessionId, userId, username, { discordUserId: null, isGhost: true });
    gameLogger.debug("Ghost-Spieler hinzugefuegt.", { sessionId, userId, username });
  }
}

async function finishSession(guild: Guild, sessionId: number, winner: Winner, reason: string): Promise<void> {
  const current = await requireSession(sessionId);
  assertSessionGuild(current, guild);
  if (current.status === "ended") {
    return;
  }

  await setSessionStatus(sessionId, "ended");
  const session = (await getSessionById(sessionId)) as GameSession;
  const embed = await endSummaryEmbed(session, winner, reason);
  const admin = await getTextChannel(guild, session.adminChannelId);
  const registration = await getTextChannel(guild, session.lobbyChannelId);
  const meeting = await getTextChannel(guild, session.meetingChannelId);
  const endText =
    winner === "nicht festgelegt"
      ? "Spiel beendet. Gewinner: nicht festgelegt."
      : `Spiel beendet. Die ${winner} haben gewonnen.`;
  const deleteRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(ids.confirmEnd(session.guildId, session.id)).setLabel("Session aufraeumen").setStyle(ButtonStyle.Danger)
  );

  await admin?.send({ content: endText, embeds: [embed], components: [deleteRow] });
  await registration?.send({ content: endText, embeds: [embed] });
  if (meeting && meeting.id !== registration?.id) {
    await meeting.send({ content: endText, embeds: [embed] });
  }
  gameLogger.info("Spiel beendet.", { sessionId, winner, reason });
  await refreshLobby(guild, sessionId);
  await sendAdminStatus(guild, sessionId);
}

function buildBodyReportReason(reporterId: string, location: string, foundBodies: Player[]): string {
  return [
    "Leiche gemeldet",
    "",
    `Gemeldet von: ${reporterId}`,
    `Fundort: ${location}`,
    "",
    foundBodies.length === 1 ? "Gefundene Leiche:" : "Gefundene Leichen:",
    ...foundBodies.map((body) => `- ${playerLabel(body)}`)
  ].join("\n");
}

async function sendMeetingCalledMessage(guild: Guild, sessionId: number, reason: string): Promise<void> {
  const session = await requireSession(sessionId);
  const meeting = await getTextChannel(guild, session.meetingChannelId);
  if (!meeting) {
    return;
  }

  await clearMeetingChannel(meeting);
  const progress = await getCrewmateTaskProgress(session.id);
  await meeting.send({
    content: [
      "**Meeting wurde ausgeloest.**",
      "",
      `Grund: ${reason}`,
      "",
      "Bitte versammelt euch.",
      "Die Diskussionszeit startet, sobald die Spielleitung sie im Webpanel startet.",
      "",
      "Task-Fortschritt:",
      `${progress.done} / ${progress.total} erledigt`,
      `${progress.percent} %`
    ].join("\n")
  });
}

async function sendVotingMessage(guild: Guild, sessionId: number, startedAt: number): Promise<void> {
  const session = await requireSession(sessionId);
  const meeting = await getTextChannel(guild, session.meetingChannelId);
  if (!meeting) {
    return;
  }
  const players = (await getPlayers(sessionId)).filter((player) => player.state === "alive");
  const voteButtons = [
    ...players.map((player) =>
      new ButtonBuilder().setCustomId(ids.vote(session.guildId, sessionId, player.userId)).setLabel(player.username.slice(0, 80)).setStyle(ButtonStyle.Secondary)
    ),
    new ButtonBuilder().setCustomId(ids.skipVote(session.guildId, sessionId)).setLabel("Skip").setStyle(ButtonStyle.Primary)
  ];

  await meeting.send({
    content: [
      "**Voting gestartet.**",
      `Votingzeit: ${session.votingTimeMinutes} Minuten`,
      `Gestartet um: ${formatClock(startedAt)}`
    ].join("\n"),
    components: chunkButtons(voteButtons)
  });
}

async function sendPlayerStartMessage(channel: TextChannel, player: Player, tasks: PlayerTask[]): Promise<void> {
  await channel.send(
    `Deine Rolle: **${player.role}**\nDeine Tasks:\n${tasks.map((task, index) => `${index + 1}. [${task.taskType}] ${task.title} - Ort: ${taskLocation(task)}`).join("\n")}`
  );

  for (const task of tasks) {
    await channel.send(taskMessageOptions(task, player.role === "crewmate", channel.guild.id));
  }

  const actionButtons = [new ButtonBuilder().setCustomId(ids.reportBody(channel.guild.id, player.sessionId)).setLabel("Leiche melden").setStyle(ButtonStyle.Danger)];
  if (player.role === "impostor") {
    actionButtons.push(new ButtonBuilder().setCustomId(ids.killPlayer(channel.guild.id, player.sessionId)).setLabel("Kill melden").setStyle(ButtonStyle.Secondary));
  }

  await channel.send({
    content: "Spielaktionen",
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(actionButtons)]
  });
}

export function taskMessageOptions(task: PlayerTask, canComplete: boolean, guildId: string) {
  const content = task.steps.length > 0 ? multiStepTaskContent(task) : singleStepTaskContent(task);
  if (!canComplete) {
    return { content, components: [] };
  }
  if (task.steps.length === 0) {
    return {
      content,
      components: task.completed
        ? []
        : [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder().setCustomId(ids.taskDone(guildId, task.sessionId, task.id)).setLabel("Erledigt").setStyle(ButtonStyle.Success)
            )
          ]
    };
  }

  const buttons = task.steps.map((step, index) =>
    new ButtonBuilder()
      .setCustomId(ids.taskStepDone(guildId, task.sessionId, task.id, step.id))
      .setLabel(`Step ${index + 1} erledigt`)
      .setStyle(step.completed ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setDisabled(task.completed || step.completed)
  );
  return { content, components: chunkButtons(buttons) };
}

function singleStepTaskContent(task: PlayerTask): string {
  return [
    `${taskTypeLabel(task.taskType)}: ${task.title}`,
    task.description !== task.title ? task.description : "",
    `Ort: ${taskLocation(task)}`,
    task.completed ? "Status: erledigt" : ""
  ].filter(Boolean).join("\n");
}

function multiStepTaskContent(task: PlayerTask): string {
  const done = task.steps.filter((step) => step.completed).length;
  return [
    `${taskTypeLabel(task.taskType)}: ${task.title}`,
    task.description,
    `Ort: ${taskLocation(task)}`,
    "",
    "Steps:",
    ...task.steps.map((step) => `${step.completed ? "[x]" : "[ ]"} ${step.title}${step.description ? ` - ${step.description}` : ""}`),
    "",
    `Fortschritt: ${done}/${task.steps.length} Steps`
  ].filter((line, index, lines) => line !== "" || lines[index - 1] !== "").join("\n");
}

function taskLocation(task: PlayerTask): string {
  return task.location?.trim() || "Unbekannter Ort";
}

function taskTypeLabel(taskType: PlayerTask["taskType"]): string {
  if (taskType === "short") {
    return "Short Task";
  }
  if (taskType === "medium") {
    return "Medium Task";
  }
  return "Long Task";
}

function playerProgress(tasks: PlayerTask[]): { done: number; total: number } {
  return { done: tasks.filter((task) => task.completed).length, total: tasks.length };
}

function labelForPlayerId(players: Player[], playerId: string | null): string {
  if (!playerId) {
    return "-";
  }
  if (playerId === "skip") {
    return "skip";
  }
  if (playerId === "debug:system") {
    return "Debug";
  }
  const player = players.find((entry) => entry.userId === playerId);
  if (!player) {
    return playerId;
  }
  return `${playerLabel(player)}${player.isGhost ? " (Ghost)" : ""}`;
}

function gameLabel(gameType: GameType): string {
  if (gameType === "amongus") {
    return "AmongUs";
  }
  if (gameType === "crazy_post") {
    return "Verrueckte Post";
  }
  return "Fragwuerdig";
}

async function statusEmbed(session: GameSession, revealRoles = true): Promise<EmbedBuilder> {
  const players = await getPlayers(session.id);
  const allTasks = await getTasks(session.id);
  const reports = await getReports(session.id);
  const kills = await getKills(session.id);
  const warningMap = await getFalseReportWarningsForGuild(session.guildId);
  const lines = players.map((player) => {
    const warningText = ` - False Reports: ${warningMap.get(player.userId) ?? 0}/2`;
    return `${playerDisplay(player, allTasks.filter((task) => task.userId === player.userId), revealRoles)}${warningText}`;
  });
  const progress = await getCrewmateTaskProgress(session.id, players, allTasks);
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: "Spieler", value: lines.length ? lines.join("\n") : "Noch keine Spieler." },
    { name: "Gesamtfortschritt Crewmates", value: progressLine(progress.done, progress.total), inline: true }
  ];

  if (session.isDebugSession) {
    fields.push({ name: "Debug", value: `Ghost-Spieler: ${players.filter((player) => player.isGhost).length}`, inline: true });
  }

  fields.push(
    {
      name: "Emergency",
      value: [
        `Cooldown: ${formatEmergencyCooldown(session)}`,
        `Webpanel: http://localhost:${config.webPanelPort}`,
        "Emergency Meetings werden ueber das lokale Webpanel ausgeloest."
      ].join("\n"),
      inline: false
    },
    { name: "Kills", value: kills.length ? kills.map((kill) => `${labelForPlayerId(players, kill.killerId)} -> ${labelForPlayerId(players, kill.victimId)}`).join("\n") : "Keine", inline: false },
    {
      name: "Leichenmeldungen",
      value: reports.length ? reports.map((report) => `${labelForPlayerId(players, report.reporterId)} - ${report.location}${report.victimId ? ` - ${labelForPlayerId(players, report.victimId)}` : ""}`).join("\n") : "Keine",
      inline: false
    },
    {
      name: "Falsche Leichenmeldungen",
      value: warningMap.size > 0
        ? [...warningMap.entries()].map(([userId, warnings]) => `${labelForPlayerId(players, userId)}: ${warnings}/2`).join("\n")
        : "Keine",
      inline: false
    }
  );

  return new EmbedBuilder()
    .setTitle(`AmongUs Session ${session.id}`)
    .setDescription(`Status: ${session.status}${session.isDebugSession ? "\nDebug-Runde aktiv" : ""}`)
    .addFields(...fields);
}

async function endSummaryEmbed(session: GameSession, winner: Winner, reason: string): Promise<EmbedBuilder> {
  const players = await getPlayers(session.id);
  const allTasks = await getTasks(session.id);
  const kills = await getKills(session.id);
  const progress = await getCrewmateTaskProgress(session.id, players, allTasks);

  return new EmbedBuilder()
    .setTitle("Spiel beendet")
    .setDescription(`Gewinner: ${winner}\nGrund: ${reason}`)
    .addFields(
      { name: "Rollen", value: players.map((player) => `${playerLabel(player)}${player.isGhost ? " (Ghost)" : ""} - ${player.role ?? "unbekannt"} - ${player.state}`).join("\n") },
      { name: "Taskfortschritt", value: `Crewmates: ${progressLine(progress.done, progress.total)}` },
      { name: "Kills", value: kills.length ? kills.map((kill) => `${labelForPlayerId(players, kill.killerId)} -> ${labelForPlayerId(players, kill.victimId)}`).join("\n") : "Keine" }
    );
}

function lobbyEmbed(session: GameSession, players: Player[]): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`AmongUs Anmeldung ${session.id}`)
    .setDescription(`Status: ${session.status}\nSpieler: ${players.length}${session.isDebugSession ? `\nDebug-Runde mit ${session.ghostCount} Ghost-Spielern` : ""}`)
    .addFields({ name: "Angemeldet", value: players.length ? players.map((player) => `${playerLabel(player)}${player.isGhost ? " (Ghost)" : ""}`).join("\n") : "Noch niemand." });
}

async function sendAdminControls(channel: TextChannel, session: GameSession): Promise<void> {
  await channel.send({
    content: "Admin-Controls",
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(ids.deletePrompt(session.guildId, session.id)).setLabel("Session aufraeumen").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(ids.adminStatus(session.guildId, session.id)).setLabel("Status aktualisieren").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(ids.start(session.guildId, session.id)).setLabel("Spiel starten").setStyle(ButtonStyle.Success)
      )
    ]
  });
}

async function getOrCreateAmongUsCategory(guild: Guild): Promise<GuildBasedChannel> {
  const existing = guild.channels.cache.find((channel) => channel.type === ChannelType.GuildCategory && channel.name === "Among Us");
  if (existing) {
    return existing;
  }

  return guild.channels.create({ name: "Among Us", type: ChannelType.GuildCategory });
}

async function getOrCreateTextChannel(guild: Guild, parent: string, name: string): Promise<TextChannel> {
  const existing = guild.channels.cache.find((channel) => channel.type === ChannelType.GuildText && channel.name === name);
  if (existing?.type === ChannelType.GuildText) {
    if (existing.parentId !== parent) {
      await existing.setParent(parent).catch((error) => gameLogger.error(`Could not move ${name}.`, error));
    }
    return existing as TextChannel;
  }

  return guild.channels.create({ name, type: ChannelType.GuildText, parent }) as Promise<TextChannel>;
}

async function getOrCreateSignupChannel(guild: Guild, parent: string, name: string, creatorId: string): Promise<TextChannel> {
  const channel = await getOrCreateTextChannel(guild, parent, name);
  await channel.permissionOverwrites.set(signupPermissionOverwrites(guild, creatorId)).catch((error) => {
    gameLogger.error("Signup channel permissions could not be updated.", error);
  });
  return channel;
}

async function getOrCreateAdminChannel(guild: Guild, parent: string, name: string, creatorId: string): Promise<TextChannel> {
  const channel = await getOrCreateTextChannel(guild, parent, name);
  await channel.permissionOverwrites.set(adminPermissionOverwrites(guild, creatorId)).catch((error) => {
    gameLogger.error("Admin channel permissions could not be updated.", error);
  });
  return channel;
}

async function clearMeetingChannel(channel: TextChannel): Promise<void> {
  const messages = await channel.messages.fetch({ limit: 50 }).catch((error) => {
    gameLogger.error("Meeting messages could not be fetched.", error);
    return null;
  });
  if (!messages || messages.size === 0) {
    return;
  }

  await channel.bulkDelete(messages, true).catch(async (error) => {
    gameLogger.error("Meeting bulk delete failed.", error);
    for (const message of messages.values()) {
      await message.delete().catch((deleteError) => {
        gameLogger.error(`Meeting message ${message.id} could not be deleted.`, deleteError);
      });
    }
  });
}

async function clearBotMessages(channel: TextChannel): Promise<void> {
  const messages = await channel.messages.fetch({ limit: 50 }).catch((error) => {
    gameLogger.error(`Messages in ${channel.name} could not be fetched.`, error);
    return null;
  });
  if (!messages) {
    return;
  }
  const botMessages = messages.filter((message) => message.author.id === channel.client.user.id);
  if (botMessages.size === 0) {
    return;
  }
  await channel.bulkDelete(botMessages, true).catch(async (error) => {
    gameLogger.error(`Bot message bulk delete failed in ${channel.name}.`, error);
    for (const message of botMessages.values()) {
      await message.delete().catch((deleteError) => gameLogger.error(`Bot message ${message.id} could not be deleted.`, deleteError));
    }
  });
}

async function clearStalePrivatePlayerChannels(guild: Guild, categoryId: string): Promise<void> {
  const staleChannels = guild.channels.cache.filter(
    (channel) => channel.type === ChannelType.GuildText && channel.parentId === categoryId && channel.name.startsWith("player-")
  );

  for (const channel of staleChannels.values()) {
    await channel.delete("Alten Among-Us-Spielerkanal vor neuer Session entfernt").catch((error) => {
      gameLogger.error(`Stale private channel ${channel.id} could not be deleted.`, error);
    });
  }
}

async function getCrewmateTaskProgress(
  sessionId: number,
  players?: Player[],
  tasks?: PlayerTask[]
): Promise<{ done: number; total: number; percent: number }> {
  const sessionPlayers = players ?? (await getPlayers(sessionId));
  const sessionTasks = tasks ?? (await getTasks(sessionId));
  const crewmateIds = new Set(
    sessionPlayers.filter((player) => player.role === "crewmate" && player.state !== "removed").map((player) => player.userId)
  );
  const realTasks = sessionTasks.filter((task) => crewmateIds.has(task.userId));
  const done = realTasks.filter((task) => task.completed).length;
  const percent = realTasks.length === 0 ? 0 : Math.round((done / realTasks.length) * 100);
  return { done, total: realTasks.length, percent };
}

function validateMeetingTimes(meetingTimes: { discussion: number; voting: number }): void {
  if (!isValidMeetingTime(meetingTimes.discussion) || !isValidMeetingTime(meetingTimes.voting)) {
    throw new Error("Diskussionszeit und Votingzeit muessen zwischen 1 und 15 Minuten liegen.");
  }
}

function validateGhostCount(ghostCount: number): void {
  if (!Number.isInteger(ghostCount) || ghostCount < 1) {
    throw new Error("Bitte gib mindestens 1 Ghost-Spieler an.");
  }
  if (ghostCount > config.debugMaxGhostPlayers) {
    throw new Error(`Maximal ${config.debugMaxGhostPlayers} Ghost-Spieler sind erlaubt.`);
  }
}

function isValidMeetingTime(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 15;
}

async function createTextChannel(guild: Guild, parent: string, name: string, adminOnly = false, creatorId?: string): Promise<TextChannel> {
  const overwrites = adminOnly
    ? adminPermissionOverwrites(guild, creatorId || guild.ownerId)
    : undefined;

  const channel = await guild.channels.create({ name, type: ChannelType.GuildText, parent, permissionOverwrites: overwrites });
  return channel as TextChannel;
}

function adminPermissionOverwrites(guild: Guild, creatorId: string) {
  const overwrites = dedupePermissionOverwrites([
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: guild.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    { id: creatorId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    { id: guild.ownerId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
  ]);

  const adminRole = config.adminRole ? guild.roles.cache.find((role) => role.id === config.adminRole || role.name === config.adminRole) : null;
  if (adminRole) {
    overwrites.push({ id: adminRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
  }

  return overwrites;
}

function signupPermissionOverwrites(guild: Guild, creatorId: string) {
  const overwrites = dedupePermissionOverwrites([
    {
      id: guild.roles.everyone.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
      deny: [PermissionFlagsBits.SendMessages]
    },
    {
      id: guild.client.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages]
    },
    {
      id: creatorId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages]
    },
    {
      id: guild.ownerId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages]
    }
  ]);

  const adminRole = config.adminRole ? guild.roles.cache.find((role) => role.id === config.adminRole || role.name === config.adminRole) : null;
  if (adminRole) {
    overwrites.push({
      id: adminRole.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages]
    });
  }

  return overwrites;
}

function dedupePermissionOverwrites<T extends { id: string }>(overwrites: T[]): T[] {
  const seen = new Set<string>();
  return overwrites.filter((overwrite) => {
    if (seen.has(overwrite.id)) {
      return false;
    }
    seen.add(overwrite.id);
    return true;
  });
}

async function createPrivatePlayerChannel(guild: Guild, parent: string, player: Player, member: GuildMember): Promise<TextChannel> {
  const overwrites = dedupePermissionOverwrites([
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: player.userId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    { id: guild.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    { id: guild.ownerId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
  ]);

  const adminRole = config.adminRole ? guild.roles.cache.find((role) => role.id === config.adminRole || role.name === config.adminRole) : null;
  if (adminRole) {
    overwrites.push({ id: adminRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
  }

  const channel = await guild.channels.create({
    name: `player-${safeChannelName(member.displayName)}`,
    type: ChannelType.GuildText,
    parent,
    permissionOverwrites: overwrites
  });
  return channel as TextChannel;
}

async function restartKillCooldowns(sessionId: number): Promise<void> {
  const nextKillAt = Date.now() + config.killCooldownSeconds * 1000;
  const impostors = (await getPlayers(sessionId)).filter((player) => player.role === "impostor" && player.state === "alive");
  for (const impostor of impostors) {
    await setKillCooldown(sessionId, impostor.userId, nextKillAt);
  }
}

async function sendToPlayerChannel(guild: Guild, player: Player, content: string): Promise<void> {
  const channel = await getTextChannel(guild, player.channelId);
  await channel?.send(content);
}

async function sendPublicSessionMessage(guild: Guild, session: GameSession, content: string): Promise<void> {
  const registration = await getTextChannel(guild, session.lobbyChannelId);
  const meeting = await getTextChannel(guild, session.meetingChannelId);
  await registration?.send(content).catch(() => null);
  if (meeting && meeting.id !== registration?.id) {
    await meeting.send(content).catch(() => null);
  }
}

function assertKillCooldownAvailable(sessionId: number, impostorId: string, nextKillAt: number): void {
  const remainingSeconds = Math.ceil((nextKillAt - Date.now()) / 1000);
  if (remainingSeconds > 0) {
    throw new Error(`Kill-Cooldown aktiv. Du musst noch ${remainingSeconds} Sekunden warten.`);
  }
}

function getEmergencyCooldownRemainingSeconds(session: GameSession): number {
  if (!session.lastEmergencyMeetingAt) {
    return 0;
  }

  const elapsedSeconds = Math.floor((Date.now() - session.lastEmergencyMeetingAt) / 1000);
  return Math.max(0, session.emergencyCooldownSeconds - elapsedSeconds);
}

function formatEmergencyCooldown(session: GameSession): string {
  const remaining = getEmergencyCooldownRemainingSeconds(session);
  return remaining > 0 ? `${formatDuration(remaining)} verbleibend` : "bereit";
}

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function joinButton(session: GameSession): ButtonBuilder {
  return new ButtonBuilder().setCustomId(ids.join(session.guildId, session.id)).setLabel("Beitreten").setStyle(ButtonStyle.Primary);
}

function startButton(session: GameSession): ButtonBuilder {
  return new ButtonBuilder().setCustomId(ids.start(session.guildId, session.id)).setLabel("Spiel starten").setStyle(ButtonStyle.Success);
}

function chunkButtons(buttons: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let index = 0; index < buttons.length; index += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(index, index + 5)));
  }
  return rows.slice(0, 5);
}

async function getTextChannel(guild: Guild, channelId: string | null): Promise<TextChannel | null> {
  if (!channelId) {
    return null;
  }
  const channel = (await guild.channels.fetch(channelId).catch(() => null)) as GuildBasedChannel | null;
  return channel?.type === ChannelType.GuildText ? (channel as TextChannel) : null;
}

async function requireSession(sessionId: number): Promise<GameSession> {
  const session = await getSessionById(sessionId);
  if (!session) {
    throw new Error("Session nicht gefunden.");
  }
  return session;
}

async function requireLatestActiveSession(guildId: string): Promise<GameSession> {
  const session = await getLatestActiveSession(guildId);
  if (!session) {
    throw new Error("Keine aktive Session gefunden.");
  }
  return session;
}

function assertSessionGuild(session: GameSession, guild: Guild): void {
  if (session.guildId !== guild.id) {
    throw new Error("Diese Session existiert nicht mehr oder gehoert zu einem anderen Server.");
  }
}

async function requireMutableSession(sessionId: number): Promise<GameSession> {
  const session = await requireSession(sessionId);
  if (session.status === "ended" || session.status === "cancelled") {
    throw new Error("Diese Session ist bereits beendet.");
  }
  return session;
}

async function requirePlayingSession(sessionId: number): Promise<GameSession> {
  const session = await requireMutableSession(sessionId);
  if (session.status !== "playing") {
    throw new Error("Diese Aktion ist nur waehrend des Spiels moeglich.");
  }
  return session;
}

function safeChannelName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "spieler";
}
