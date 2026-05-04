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
import { GameSession, Player, PlayerTask } from "../models/session";
import {
  addKill,
  addPlayer,
  addReport,
  addTask,
  clearFalseReportWarnings,
  clearVotes,
  createSession,
  getActiveSession,
  getKillCooldown,
  getKills,
  getFalseReportWarningsForGuild,
  getPlayer,
  getPlayers,
  getReports,
  getSessionById,
  getTaskById,
  getTasks,
  getUnreportedDeadPlayers,
  getVotes,
  incrementFalseReportWarning,
  markTaskDone,
  markDeathsReported,
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
import { playerDisplay, progressLine } from "../utils/format";
import { loadTaskCatalog, pickTasks } from "./taskService";

type Winner = "Crewmates" | "Impostors" | "nicht festgelegt";

export async function createGameSession(
  guild: Guild,
  creator: GuildMember,
  counts = { short: 3, medium: 2, long: 1 },
  meetingTimes = { discussion: config.defaultDiscussionTimeMinutes, voting: config.defaultVotingTimeMinutes },
  emergencyUserId = ""
): Promise<GameSession> {
  validateMeetingTimes(meetingTimes);
  if (!emergencyUserId) {
    throw new Error("Bitte gib einen Emergency-User an.");
  }
  const active = await getActiveSession(guild.id);
  if (active) {
    throw new Error(`Es gibt bereits eine aktive Session: ${active.id}`);
  }

  const category = await getOrCreateAmongUsCategory(guild);
  const signup = await getOrCreateSignupChannel(guild, category.id, "amongus-anmeldung", creator.id);
  const meeting = await getOrCreateTextChannel(guild, category.id, "amongus-meeting");
  const admin = await getOrCreateAdminChannel(guild, category.id, "amongus-admin", creator.id);
  const emergency = await getOrCreateEmergencyChannel(guild, category.id, "amongus-emergency", emergencyUserId, creator.id);

  await Promise.all([
    clearBotMessages(signup),
    clearMeetingChannel(meeting),
    clearBotMessages(admin),
    clearBotMessages(emergency),
    clearStalePrivatePlayerChannels(guild, category.id)
  ]);

  const session = await createSession(guild.id, creator.id, emergencyUserId, counts, meetingTimes);

  const joinMessage = await signup.send({
    embeds: [lobbyEmbed(session, [])],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(joinButton(session), startButton(session))]
  });

  await updateSessionChannels(session.id, {
    categoryId: category.id,
    lobbyChannelId: signup.id,
    meetingChannelId: meeting.id,
    adminChannelId: admin.id,
    emergencyChannelId: emergency.id,
    joinMessageId: joinMessage.id
  });

  const created = (await getSessionById(session.id)) as GameSession;
  await sendEmergencyPanel(emergency, created);
  await admin.send(
    `Session ${session.id} erstellt. Task-Mix: ${counts.short} short, ${counts.medium} medium, ${counts.long} long. Meeting: ${meetingTimes.discussion} Min Diskussion, ${meetingTimes.voting} Min Voting.`
  );
  await sendAdminControls(admin, created);
  await sendAdminStatus(guild, session.id);
  return created;
}

export async function joinSession(guild: Guild, sessionId: number, member: GuildMember): Promise<void> {
  const session = await requireSession(sessionId);
  if (session.guildId !== guild.id || session.status !== "lobby") {
    throw new Error("Dieser Session kann nicht mehr beigetreten werden.");
  }
  if (member.id === session.emergencyUserId) {
    throw new Error("Du bist fuer diese Session als Emergency-User festgelegt und nimmst nicht als normaler Spieler teil.");
  }

  await addPlayer(session.id, member.id, member.displayName);
  await refreshLobby(guild, session.id);
  await sendAdminStatus(guild, session.id);
}

export async function startGame(guild: Guild, sessionId: number): Promise<void> {
  const session = await requireSession(sessionId);
  if (session.status !== "lobby") {
    throw new Error("Die Session ist nicht in der Anmeldephase.");
  }

  const players = await getPlayers(session.id);
  if (players.length < 3) {
    throw new Error("Mindestens 3 Spieler werden fuer V1 benoetigt.");
  }

  await setSessionStatus(session.id, "starting");
  const shuffled = [...players].sort(() => Math.random() - 0.5);
  const impostorCount = players.length >= 8 ? 2 : 1;
  const impostors = new Set(shuffled.slice(0, impostorCount).map((player) => player.userId));
  const catalog = loadTaskCatalog();

  for (const player of players) {
    const role = impostors.has(player.userId) ? "impostor" : "crewmate";
    await setPlayerRole(session.id, player.userId, role);
    for (const task of pickTasks(catalog, { short: session.shortTasks, medium: session.mediumTasks, long: session.longTasks })) {
      await addTask(session.id, player.userId, task.type, task.description);
    }
  }

  const refreshedSession = (await getSessionById(session.id)) as GameSession;
  if (!refreshedSession.categoryId) {
    throw new Error("Session-Kategorie fehlt.");
  }

  const assignedPlayers = await getPlayers(session.id);
  for (const player of assignedPlayers) {
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

export async function completeTask(guild: Guild, taskId: number, userId: string): Promise<PlayerTask> {
  const existing = await getTaskById(taskId);
  if (!existing) {
    throw new Error("Task nicht gefunden.");
  }

  const session = await requireMutableSession(existing.sessionId);
  const player = await getPlayer(session.id, userId);
  if (!player) {
    throw new Error("Du bist nicht mehr Teil dieser Session.");
  }
  if (player.state === "removed") {
    throw new Error("Du bist nicht mehr Teil dieser Session.");
  }
  if (player.role !== "crewmate" || player.state !== "alive") {
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

export async function killSelectMenu(guild: Guild, sessionId: number, impostorId: string): Promise<StringSelectMenuBuilder> {
  const session = await requirePlayingSession(sessionId);
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
    .setCustomId(ids.killSelect(session.id))
    .setPlaceholder("Getoeteten Crewmate auswaehlen")
    .addOptions(targets.slice(0, 25).map((player) => new StringSelectMenuOptionBuilder().setLabel(player.username).setValue(player.userId)));
}

export async function reportKill(guild: Guild, sessionId: number, killerId: string, victimId: string): Promise<void> {
  const session = await requirePlayingSession(sessionId);
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

  await sendToPlayerChannel(guild, victim, "Du bist tot. Bitte nimm nicht mehr aktiv am Spiel teil, bis die Spielleitung etwas anderes sagt.");
  await sendAdminStatus(guild, session.id, `Kill gemeldet: <@${killer.userId}> hat <@${victim.userId}> getoetet.`);
  await finishIfWinConditionReached(guild, session.id);
}

export async function canOpenBodyReportModal(guild: Guild, sessionId: number, reporterId: string): Promise<boolean> {
  const session = await requirePlayingSession(sessionId);
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

export function reportBodyModal(sessionId: number): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(ids.reportBodyModal(sessionId))
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
  await markDeathsReported(session.id, foundBodies.map((body) => body.userId));
  await clearVotes(session.id);
  await setSessionStatus(session.id, "meeting");
  await restartKillCooldowns(session.id);
  await sendMeetingMessage(guild, session.id, reporterId, location, foundBodies);
  await sendAdminStatus(guild, session.id);
}

async function handleFalseBodyReport(guild: Guild, session: GameSession, reporter: Player): Promise<number> {
  const warnings = await incrementFalseReportWarning(guild.id, reporter.userId);
  if (warnings < 2) {
    await sendAdminStatus(guild, session.id, `<@${reporter.userId}> hat einen falschen Leichenreport ausgeloest. Verwarnung 1/2.`);
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
    console.error(`Could not revoke private channel access for ${player.userId}`, error);
  });

  const publicMessage = `<@${player.userId}> wurde wegen wiederholtem falschem Leichenmelden aus der Session entfernt.`;
  await sendPublicSessionMessage(guild, session, publicMessage);
  await sendAdminStatus(
    guild,
    session.id,
    `<@${player.userId}> hat erneut einen falschen Leichenreport ausgeloest und wurde automatisch aus der Session entfernt. Verwarnungen: ${warnings}/2.`
  );
  await finishIfWinConditionReached(guild, session.id);
}

export async function startAdminMeeting(guild: Guild, sessionId: number): Promise<void> {
  const session = await requirePlayingSession(sessionId);
  await clearVotes(session.id);
  await setSessionStatus(session.id, "meeting");
  await restartKillCooldowns(session.id);
  await sendMeetingMessage(guild, session.id, "Admin hat Meeting gestartet");
  await sendAdminStatus(guild, session.id);
}

export async function startEmergencyMeeting(guild: Guild, sessionId: number, userId: string): Promise<void> {
  const session = await requireSession(sessionId);
  if (userId !== session.emergencyUserId) {
    throw new Error("Nur der festgelegte Emergency-User kann diesen Button verwenden.");
  }
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
  await restartKillCooldowns(session.id);
  await sendMeetingMessage(guild, session.id, `Emergency Meeting wurde einberufen.\nEinberufen durch <@${userId}>.`);
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
  if (session.status === "ended" || session.status === "cancelled") {
    throw new Error("Diese Session ist bereits beendet.");
  }
  if (session.status !== "meeting") {
    throw new Error("Aktuell laeuft kein Meeting.");
  }

  const voter = await getPlayer(session.id, voterId);
  if (!voter || voter.state === "removed") {
    throw new Error("Du bist nicht mehr Teil dieser Session.");
  }
  if (voter.state !== "alive") {
    throw new Error("Nur lebende Spieler koennen voten.");
  }

  await setVote(session.id, voterId, targetUserId);
  const players = await getPlayers(session.id);
  const alivePlayers = players.filter((player) => player.state === "alive");
  const votes = await getVotes(session.id);

  if (votes.length < alivePlayers.length) {
    await sendAdminStatus(guild, session.id);
    return `Vote gespeichert (${votes.length}/${alivePlayers.length}).`;
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
    await meeting?.send(`Voting beendet: <@${winner}> wurde rausgewaehlt.`);
  }

  await clearVotes(session.id);
  const ended = await finishIfWinConditionReached(guild, session.id);
  if (!ended) {
    await setSessionStatus(session.id, "playing");
    await restartKillCooldowns(session.id);
    await meeting?.send("Das Spiel wird fortgesetzt.");
  }

  await sendAdminStatus(guild, session.id);
  return "Voting abgeschlossen.";
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

export async function sendAdminControlsForSession(guild: Guild, sessionId: number): Promise<void> {
  const session = await requireSession(sessionId);
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
  if (session.status !== "ended") {
    await setSessionStatus(session.id, "cancelled");
  }
  await sendAdminStatus(guild, session.id, "Session wird geloescht.");
  return deleteSessionChannels(guild, session.id);
}

export async function deleteSessionChannels(guild: Guild, sessionId: number): Promise<string> {
  const session = await requireSession(sessionId);
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
      console.error(`Session channel ${channelId} could not be deleted`, error);
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
      console.error(`Session category ${category.id} could not be deleted`, error);
    });
  }

  return failed.length
    ? `Einige Session-Kanaele konnten nicht geloescht werden: ${failed.map((id) => `<#${id}>`).join(", ")}`
    : "Session aufgeraeumt. Alle Session-Kanaele wurden geloescht.";
}

export async function refreshLobby(guild: Guild, sessionId: number): Promise<void> {
  const session = await requireSession(sessionId);
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
    await finishSession(guild, sessionId, "Crewmates", "alle Tasks erledigt");
    return true;
  }

  if (aliveImpostors.length === 0) {
    await finishSession(guild, sessionId, "Crewmates", "alle Impostors ausgeschieden");
    return true;
  }

  if (aliveImpostors.length >= aliveCrewmates.length) {
    await finishSession(guild, sessionId, "Impostors", "Impostors haben zahlenmaessige Mehrheit/Gleichstand erreicht");
    return true;
  }

  return false;
}

async function finishSession(guild: Guild, sessionId: number, winner: Winner, reason: string): Promise<void> {
  const current = await requireSession(sessionId);
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
    new ButtonBuilder().setCustomId(ids.confirmEnd(session.id)).setLabel("Session aufraeumen").setStyle(ButtonStyle.Danger)
  );

  await admin?.send({ content: endText, embeds: [embed], components: [deleteRow] });
  await registration?.send({ content: endText, embeds: [embed] });
  if (meeting && meeting.id !== registration?.id) {
    await meeting.send({ content: endText, embeds: [embed] });
  }
  await refreshLobby(guild, sessionId);
  await sendAdminStatus(guild, sessionId);
}

async function sendMeetingMessage(guild: Guild, sessionId: number, reason: string): Promise<void>;
async function sendMeetingMessage(guild: Guild, sessionId: number, reporterId: string, location: string, foundBodies: Player[]): Promise<void>;
async function sendMeetingMessage(guild: Guild, sessionId: number, first: string, second?: string, foundBodies?: Player[]): Promise<void> {
  const session = await requireSession(sessionId);
  const meeting = await getTextChannel(guild, session.meetingChannelId);
  if (!meeting) {
    return;
  }

  await clearMeetingChannel(meeting);
  const progress = await getCrewmateTaskProgress(session.id);
  const reason = second && foundBodies
    ? [
        "Leiche gemeldet",
        "",
        `Gemeldet von: <@${first}>`,
        `Fundort: ${second}`,
        "",
        foundBodies.length === 1 ? "Gefundene Leiche:" : "Gefundene Leichen:",
        ...foundBodies.map((body) => `- <@${body.userId}>`)
      ].join("\n")
    : first;
  const players = (await getPlayers(sessionId)).filter((player) => player.state === "alive");
  const voteButtons = [
    ...players.map((player) =>
      new ButtonBuilder().setCustomId(ids.vote(sessionId, player.userId)).setLabel(player.username.slice(0, 80)).setStyle(ButtonStyle.Secondary)
    ),
    new ButtonBuilder().setCustomId(ids.skipVote(sessionId)).setLabel("Skip").setStyle(ButtonStyle.Primary)
  ];

  await meeting.send({
    content: [
      "**Meeting gestartet**",
      "",
      `Grund: ${reason}`,
      "",
      `Diskussionszeit: ${session.discussionTimeMinutes} Minuten`,
      `Votingzeit: ${session.votingTimeMinutes} Minuten`,
      "",
      "Task-Fortschritt:",
      `${progress.done} / ${progress.total} erledigt`,
      `${progress.percent} %`
    ].join("\n"),
    components: chunkButtons(voteButtons)
  });
}

async function sendPlayerStartMessage(channel: TextChannel, player: Player, tasks: PlayerTask[]): Promise<void> {
  await channel.send(
    `Deine Rolle: **${player.role}**\nDeine Tasks:\n${tasks.map((task, index) => `${index + 1}. [${task.taskType}] ${task.description}`).join("\n")}`
  );

  if (player.role === "crewmate") {
    for (const task of tasks) {
      await channel.send({
        content: `[${task.taskType}] ${task.description}`,
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(ids.taskDone(task.id)).setLabel("Erledigt").setStyle(ButtonStyle.Success)
          )
        ]
      });
    }
  }

  const actionButtons = [new ButtonBuilder().setCustomId(ids.reportBody(player.sessionId)).setLabel("Leiche melden").setStyle(ButtonStyle.Danger)];
  if (player.role === "impostor") {
    actionButtons.push(new ButtonBuilder().setCustomId(ids.killPlayer(player.sessionId)).setLabel("Kill melden").setStyle(ButtonStyle.Secondary));
  }

  await channel.send({
    content: "Spielaktionen",
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(actionButtons)]
  });
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

  return new EmbedBuilder()
    .setTitle(`AmongUs Session ${session.id}`)
    .setDescription(`Status: ${session.status}`)
    .addFields(
      { name: "Spieler", value: lines.length ? lines.join("\n") : "Noch keine Spieler." },
      { name: "Gesamtfortschritt Crewmates", value: progressLine(progress.done, progress.total), inline: true },
      {
        name: "Emergency",
        value: `User: <@${session.emergencyUserId}>\nKanal: ${session.emergencyChannelId ? `<#${session.emergencyChannelId}>` : "nicht erstellt"}\nCooldown: ${formatEmergencyCooldown(session)}`,
        inline: false
      },
      { name: "Kills", value: kills.length ? kills.map((kill) => `<@${kill.killerId}> -> <@${kill.victimId}>`).join("\n") : "Keine", inline: false },
      {
        name: "Leichenmeldungen",
        value: reports.length ? reports.map((report) => `<@${report.reporterId}> - ${report.location}${report.victimId ? ` - <@${report.victimId}>` : ""}`).join("\n") : "Keine",
        inline: false
      },
      {
        name: "Falsche Leichenmeldungen",
        value: warningMap.size > 0
          ? [...warningMap.entries()].map(([userId, warnings]) => `<@${userId}>: ${warnings}/2`).join("\n")
          : "Keine",
        inline: false
      }
    );
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
      { name: "Rollen", value: players.map((player) => `<@${player.userId}> - ${player.role ?? "unbekannt"} - ${player.state}`).join("\n") },
      { name: "Taskfortschritt", value: `Crewmates: ${progressLine(progress.done, progress.total)}` },
      { name: "Kills", value: kills.length ? kills.map((kill) => `<@${kill.killerId}> -> <@${kill.victimId}>`).join("\n") : "Keine" }
    );
}

function lobbyEmbed(session: GameSession, players: Player[]): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`AmongUs Anmeldung ${session.id}`)
    .setDescription(`Status: ${session.status}\nSpieler: ${players.length}`)
    .addFields({ name: "Angemeldet", value: players.length ? players.map((player) => `<@${player.userId}>`).join("\n") : "Noch niemand." });
}

async function sendAdminControls(channel: TextChannel, session: GameSession): Promise<void> {
  await channel.send({
    content: "Admin-Controls",
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(ids.deletePrompt(session.id)).setLabel("Session aufraeumen").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(ids.adminStatus(session.id)).setLabel("Status aktualisieren").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(ids.start(session.id)).setLabel("Spiel starten").setStyle(ButtonStyle.Success)
      )
    ]
  });
}

async function sendEmergencyPanel(channel: TextChannel, session: GameSession): Promise<void> {
  await channel.send({
    content: [
      "**Emergency Meeting**",
      "",
      "Du bist der Emergency-User dieser Session.",
      `Cooldown: ${formatEmergencyCooldown(session)}`
    ].join("\n"),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(ids.emergencyMeeting(session.id)).setLabel("Emergency Meeting einberufen").setStyle(ButtonStyle.Danger)
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
      await existing.setParent(parent).catch((error) => console.error(`Could not move ${name}`, error));
    }
    return existing as TextChannel;
  }

  return guild.channels.create({ name, type: ChannelType.GuildText, parent }) as Promise<TextChannel>;
}

async function getOrCreateSignupChannel(guild: Guild, parent: string, name: string, creatorId: string): Promise<TextChannel> {
  const channel = await getOrCreateTextChannel(guild, parent, name);
  await channel.permissionOverwrites.set(signupPermissionOverwrites(guild, creatorId)).catch((error) => {
    console.error("Signup channel permissions could not be updated", error);
  });
  return channel;
}

async function getOrCreateAdminChannel(guild: Guild, parent: string, name: string, creatorId: string): Promise<TextChannel> {
  const channel = await getOrCreateTextChannel(guild, parent, name);
  await channel.permissionOverwrites.set(adminPermissionOverwrites(guild, creatorId)).catch((error) => {
    console.error("Admin channel permissions could not be updated", error);
  });
  return channel;
}

async function getOrCreateEmergencyChannel(
  guild: Guild,
  parent: string,
  name: string,
  emergencyUserId: string,
  creatorId: string
): Promise<TextChannel> {
  const channel = await getOrCreateTextChannel(guild, parent, name);
  await channel.permissionOverwrites.set(emergencyPermissionOverwrites(guild, emergencyUserId, creatorId)).catch((error) => {
    console.error("Emergency channel permissions could not be updated", error);
  });
  return channel;
}

async function clearMeetingChannel(channel: TextChannel): Promise<void> {
  const messages = await channel.messages.fetch({ limit: 50 }).catch((error) => {
    console.error("Meeting messages could not be fetched", error);
    return null;
  });
  if (!messages || messages.size === 0) {
    return;
  }

  await channel.bulkDelete(messages, true).catch(async (error) => {
    console.error("Meeting bulk delete failed", error);
    for (const message of messages.values()) {
      await message.delete().catch((deleteError) => {
        console.error(`Meeting message ${message.id} could not be deleted`, deleteError);
      });
    }
  });
}

async function clearBotMessages(channel: TextChannel): Promise<void> {
  const messages = await channel.messages.fetch({ limit: 50 }).catch((error) => {
    console.error(`Messages in ${channel.name} could not be fetched`, error);
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
    console.error(`Bot message bulk delete failed in ${channel.name}`, error);
    for (const message of botMessages.values()) {
      await message.delete().catch((deleteError) => console.error(`Bot message ${message.id} could not be deleted`, deleteError));
    }
  });
}

async function clearStalePrivatePlayerChannels(guild: Guild, categoryId: string): Promise<void> {
  const staleChannels = guild.channels.cache.filter(
    (channel) => channel.type === ChannelType.GuildText && channel.parentId === categoryId && channel.name.startsWith("player-")
  );

  for (const channel of staleChannels.values()) {
    await channel.delete("Alten Among-Us-Spielerkanal vor neuer Session entfernt").catch((error) => {
      console.error(`Stale private channel ${channel.id} could not be deleted`, error);
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

function emergencyPermissionOverwrites(guild: Guild, emergencyUserId: string, creatorId: string) {
  const overwrites = adminPermissionOverwrites(guild, creatorId);
  if (!overwrites.some((overwrite) => overwrite.id === emergencyUserId)) {
    overwrites.push({
      id: emergencyUserId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
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

function joinButton(session: GameSession): ButtonBuilder {
  return new ButtonBuilder().setCustomId(ids.join(session.id)).setLabel("Beitreten").setStyle(ButtonStyle.Primary);
}

function startButton(session: GameSession): ButtonBuilder {
  return new ButtonBuilder().setCustomId(ids.start(session.id)).setLabel("Spiel starten").setStyle(ButtonStyle.Success);
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
