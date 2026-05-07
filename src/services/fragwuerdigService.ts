import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  Guild,
  GuildBasedChannel,
  GuildMember,
  Message,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
  TextChannel
} from "discord.js";
import { config } from "../config";
import { fragwuerdigQuestionPairs } from "../data/fragwuerdigQuestions";
import {
  addFragwuerdigAnswer,
  addFragwuerdigVote,
  addPlayer,
  createFragwuerdigRound,
  createFragwuerdigSession,
  ensureFragwuerdigPlayerState,
  getActiveFragwuerdigSessionByChannel,
  getAnyActiveSession,
  getCurrentFragwuerdigRound,
  getFragwuerdigAnswers,
  getFragwuerdigPlayerState,
  getFragwuerdigPlayerStates,
  getFragwuerdigSettings,
  getFragwuerdigVotes,
  getPlayer,
  getPlayers,
  getSessionById,
  promoteFragwuerdigWaitingPlayers,
  resetFragwuerdigContinueMarks,
  setFragwuerdigPlayerActiveMessage,
  setFragwuerdigPlayerQueueState,
  setFragwuerdigRoundStatus,
  setFragwuerdigWantsToContinue,
  setPlayerChannel,
  setSessionStatus,
  updateFragwuerdigSettings,
  updateSessionChannels
} from "../db/repository";
import { FragwuerdigAnswerType, FragwuerdigQuestionPair, FragwuerdigRound, GameSession, Player } from "../models/session";
import { ids } from "../utils/customIds";

export async function createFragwuerdigGameSession(guild: Guild, creator: GuildMember, impostorCount: 1 | 2): Promise<GameSession> {
  const active = await getAnyActiveSession();
  if (active) {
    throw new Error(`Es gibt bereits eine aktive Session: ${active.id}`);
  }

  const category = await getOrCreateMinigamesCategory(guild);
  const signup = await getOrCreateSignupChannel(guild, category.id, "fragwuerdig-anmeldung", creator.id);
  const meeting = await getOrCreateTextChannel(guild, category.id, "fragwuerdig-meeting");
  const admin = await getOrCreateAdminChannel(guild, category.id, "fragwuerdig-admin", creator.id);

  await Promise.all([clearBotMessages(signup), clearBotMessages(meeting), clearBotMessages(admin), clearStaleFragwuerdigPlayerChannels(guild, category.id)]);

  const session = await createFragwuerdigSession(guild.id, creator.id, impostorCount);
  const joinMessage = await signup.send({
    embeds: [await fragwuerdigLobbyEmbed(session)],
    components: [lobbyButtonRow(session)]
  });

  await updateSessionChannels(session.id, {
    categoryId: category.id,
    lobbyChannelId: signup.id,
    meetingChannelId: meeting.id,
    adminChannelId: admin.id,
    joinMessageId: joinMessage.id
  });

  const created = (await getSessionById(session.id)) as GameSession;
  await admin.send(`Fragwuerdig-Session ${session.id} erstellt. Impostors: ${impostorCount}.`);
  await sendFragwuerdigAdminControls(admin, created);
  return created;
}

export async function joinFragwuerdigSession(guild: Guild, sessionId: number, member: GuildMember): Promise<string> {
  const session = await requireFragwuerdigSession(sessionId);
  if (session.guildId !== guild.id || session.status === "finished" || session.status === "ended" || session.status === "cancelled") {
    throw new Error("Dieser Session kann nicht mehr beigetreten werden.");
  }

  await addPlayer(session.id, member.id, member.displayName);
  if (session.status === "lobby") {
    await ensureFragwuerdigPlayerState(session.id, member.id, "active");
    await refreshFragwuerdigLobby(guild, session.id);
    return "Du bist der Fragwuerdig-Session beigetreten.";
  }

  await ensureFragwuerdigPlayerState(session.id, member.id, "waiting");
  await setFragwuerdigPlayerQueueState(session.id, member.id, "waiting");
  await refreshFragwuerdigLobby(guild, session.id);
  return "Du bist in der Warteschlange und bist ab der naechsten Runde dabei, falls weitergespielt wird.";
}

export async function startFragwuerdigRound(guild: Guild, sessionId: number, userId: string, isAdmin: boolean): Promise<void> {
  const session = await requireFragwuerdigSession(sessionId);
  assertHostOrAdmin(session, userId, isAdmin, "Nur Host oder Spielleitung kann die Runde starten.");
  if (!["lobby", "round_finished"].includes(session.status)) {
    throw new Error("Gerade kann keine neue Fragwuerdig-Runde gestartet werden.");
  }
  if (!session.categoryId) {
    throw new Error("Session-Kategorie fehlt.");
  }

  if (session.status === "round_finished") {
    await promoteFragwuerdigWaitingPlayers(session.id);
  }

  const settings = await requireFragwuerdigSettings(session.id);
  const activePlayers = await getFragwuerdigPlayers(session.id, "active");
  const minPlayers = settings.impostorCount === 2 ? 5 : 3;
  if (activePlayers.length < minPlayers) {
    if (session.status === "round_finished") {
      await finishFragwuerdigSession(guild, session.id, `Zu wenige Spieler fuer ${settings.impostorCount} Impostor.`);
    }
    throw new Error(`Fuer ${settings.impostorCount} Impostor werden mindestens ${minPlayers} aktive Spieler benoetigt.`);
  }

  try {
    await resetFragwuerdigContinueMarks(session.id);
    await ensurePrivateChannels(guild, session, activePlayers);

    const questionPair = pickQuestionPair(settings.usedQuestionPairIds);
    const roundNumber = settings.roundNumber + 1;
    const impostorIds = shuffle(activePlayers.map((player) => player.userId)).slice(0, settings.impostorCount);
    const round = await createFragwuerdigRound(session.id, roundNumber, questionPair, impostorIds);
    await updateFragwuerdigSettings(session.id, {
      roundNumber,
      usedQuestionPairIds: nextUsedQuestionIds(settings.usedQuestionPairIds, questionPair.id)
    });

    await setSessionStatus(session.id, "answering");
    await clearMeetingForRound(guild, session);
    for (const player of activePlayers) {
      await sendQuestionToPlayer(guild, session.id, player, round);
    }
  } catch (error) {
    await finishFragwuerdigSession(guild, session.id, "Rundenstart fehlgeschlagen. Bitte pruefe die Bot-Berechtigungen.");
    throw error;
  }
  await refreshFragwuerdigLobby(guild, session.id);
}

export async function handleFragwuerdigPlayerMessage(message: Message): Promise<boolean> {
  if (!message.guild || message.author.bot || message.channel.type !== ChannelType.GuildText) {
    return false;
  }

  const session = await getActiveFragwuerdigSessionByChannel(message.channel.id);
  if (!session || session.status !== "answering") {
    return false;
  }
  const player = await getPlayer(session.id, message.author.id);
  const playerState = await getFragwuerdigPlayerState(session.id, message.author.id);
  if (!player || player.channelId !== message.channel.id || playerState?.queueState !== "active") {
    return false;
  }

  const round = await getCurrentFragwuerdigRound(session.id);
  if (!round || round.status !== "answering") {
    return true;
  }
  const existingAnswers = await getFragwuerdigAnswers(round.id);
  if (existingAnswers.some((answer) => answer.playerId === player.userId)) {
    await message.reply("Deine Antwort wurde bereits gespeichert.").catch(() => null);
    return true;
  }

  const normalized = normalizeAnswer(message.content, round.answerType);
  if (!normalized.ok) {
    await message.reply(normalized.message).catch(() => null);
    return true;
  }

  await deleteActivePlayerMessage(message.guild, player, playerState.activeMessageId);
  await message.delete().catch(() => null);
  const stored = await addFragwuerdigAnswer(round.id, player.userId, normalized.value);
  if (!stored) {
    await message.reply("Deine Antwort wurde bereits gespeichert.").catch(() => null);
    return true;
  }
  const saved = await (message.channel as TextChannel).send("Antwort gespeichert. Warte auf die anderen Spieler.");
  await setFragwuerdigPlayerActiveMessage(session.id, player.userId, saved.id);

  await maybeStartVoting(message.guild, session.id, round.id);
  return true;
}

export async function recordFragwuerdigVote(
  interaction: StringSelectMenuInteraction,
  sessionId: number,
  roundId: number,
  targetPlayerIds: string[]
): Promise<string> {
  const session = await requireFragwuerdigSession(sessionId);
  if (session.status !== "voting") {
    throw new Error("Aktuell laeuft kein Fragwuerdig-Voting.");
  }
  const round = await getCurrentFragwuerdigRound(session.id);
  if (!round || round.id !== roundId || round.status !== "voting") {
    throw new Error("Dieses Voting ist nicht mehr aktiv.");
  }
  const settings = await requireFragwuerdigSettings(session.id);
  if (targetPlayerIds.length !== settings.impostorCount) {
    throw new Error(`Bitte waehle genau ${settings.impostorCount} Spieler.`);
  }

  const activePlayers = await getFragwuerdigPlayers(session.id, "active");
  const activeIds = new Set(activePlayers.map((player) => player.userId));
  if (!activeIds.has(interaction.user.id) || targetPlayerIds.some((id) => !activeIds.has(id))) {
    throw new Error("Nur aktive Spieler der aktuellen Runde koennen abstimmen.");
  }

  const stored = await addFragwuerdigVote(round.id, interaction.user.id, targetPlayerIds);
  if (!stored) {
    throw new Error("Deine Stimme wurde bereits gespeichert.");
  }

  const votes = await getFragwuerdigVotes(round.id);
  if (votes.length >= activePlayers.length) {
    await revealFragwuerdigRound(interaction.guild!, session, round);
    return "Stimme gespeichert. Alle Stimmen sind da.";
  }
  return `Stimme gespeichert (${votes.length}/${activePlayers.length}).`;
}

export async function markFragwuerdigContinue(guild: Guild, sessionId: number, userId: string, wantsToContinue: boolean): Promise<string> {
  const session = await requireFragwuerdigSession(sessionId);
  if (session.status !== "round_finished") {
    throw new Error("Diese Entscheidung ist gerade nicht aktiv.");
  }
  const state = await getFragwuerdigPlayerState(session.id, userId);
  if (!state || state.queueState !== "active") {
    throw new Error("Nur aktive Spieler der letzten Runde koennen das entscheiden.");
  }
  await setFragwuerdigWantsToContinue(session.id, userId, wantsToContinue);
  if (!wantsToContinue) {
    await setFragwuerdigPlayerQueueState(session.id, userId, "left");
  }
  await refreshFragwuerdigLobby(guild, session.id);
  return wantsToContinue ? "Du bist fuer die naechste Runde vorgemerkt." : "Du bist ab der naechsten Runde raus.";
}

export async function endFragwuerdigByHost(guild: Guild, sessionId: number, userId: string, isAdmin: boolean): Promise<string> {
  const session = await requireFragwuerdigSession(sessionId);
  assertHostOrAdmin(session, userId, isAdmin, "Nur Host oder Spielleitung kann diese Session beenden.");
  await finishFragwuerdigSession(guild, session.id, "Session wurde beendet.");
  return "Fragwuerdig-Session beendet.";
}

export async function refreshFragwuerdigLobby(guild: Guild, sessionId: number): Promise<void> {
  const session = await requireFragwuerdigSession(sessionId);
  const registration = await getTextChannel(guild, session.lobbyChannelId);
  if (!registration || !session.joinMessageId) {
    return;
  }
  const message = await registration.messages.fetch(session.joinMessageId).catch(() => null);
  await message?.edit({
    embeds: [await fragwuerdigLobbyEmbed(session)],
    components: session.status === "finished" || session.status === "ended" || session.status === "cancelled" ? [] : [lobbyButtonRow(session)]
  });
}

async function maybeStartVoting(guild: Guild, sessionId: number, roundId: number): Promise<void> {
  const session = await requireFragwuerdigSession(sessionId);
  const round = await getCurrentFragwuerdigRound(sessionId);
  if (!round || round.id !== roundId || round.status !== "answering") {
    return;
  }
  const activePlayers = await getFragwuerdigPlayers(sessionId, "active");
  const answers = await getFragwuerdigAnswers(round.id);
  if (answers.length < activePlayers.length) {
    return;
  }

  await setFragwuerdigRoundStatus(round.id, "voting");
  await setSessionStatus(sessionId, "voting");
  for (const player of activePlayers) {
    const state = await getFragwuerdigPlayerState(sessionId, player.userId);
    await deleteActivePlayerMessage(guild, player, state?.activeMessageId ?? null);
    await setFragwuerdigPlayerActiveMessage(sessionId, player.userId, null);
  }

  const meeting = await getTextChannel(guild, session.meetingChannelId);
  if (!meeting) {
    throw new Error("Meeting-Lobby fehlt.");
  }
  await meeting.send({
    content: [
      "Alle Antworten sind da.",
      "",
      "Originalfrage:",
      round.mainQuestion,
      "",
      "Antworten:",
      ...formatAnswers(activePlayers, answers, true),
      "",
      "Stimmt jetzt ab:",
      "Wer hatte eine andere Frage?"
    ].join("\n"),
    components: [voteSelectRow(session.id, round, activePlayers)]
  });
}

async function revealFragwuerdigRound(guild: Guild, session: GameSession, round: FragwuerdigRound): Promise<void> {
  await setFragwuerdigRoundStatus(round.id, "revealed");
  await setSessionStatus(session.id, "round_finished");
  const activePlayers = await getFragwuerdigPlayers(session.id, "active");
  const answers = await getFragwuerdigAnswers(round.id);
  const votes = await getFragwuerdigVotes(round.id);
  const meeting = await getTextChannel(guild, session.meetingChannelId);
  if (!meeting) {
    return;
  }

  const voteCounts = countVotes(votes);
  const selected = topVotedPlayers(voteCounts, round.impostorIds.length);
  const impostorSet = new Set(round.impostorIds);
  const groupFound = selected.length === round.impostorIds.length && selected.every((id) => impostorSet.has(id));

  await meeting.send({
    content: [
      "Aufloesung",
      "",
      "Hauptfrage:",
      round.mainQuestion,
      "",
      "Impostor-Frage:",
      round.impostorQuestion,
      "",
      round.impostorIds.length === 1 ? "Impostor:" : "Impostors:",
      round.impostorIds.map((id) => playerName(activePlayers, id)).join(", "),
      "",
      "Antworten:",
      ...formatAnswers(activePlayers, answers, false),
      "",
      "Voting-Ergebnis:",
      ...formatVoteCounts(activePlayers, voteCounts),
      "",
      groupFound ? "Die Gruppe hat den Impostor gefunden." : "Die Gruppe hat den Impostor nicht eindeutig gefunden."
    ].join("\n"),
    components: [roundDecisionRow(session.id), hostDecisionRow(session.id)]
  });
  await refreshFragwuerdigLobby(guild, session.id);
}

async function finishFragwuerdigSession(guild: Guild, sessionId: number, reason: string): Promise<void> {
  const session = await requireFragwuerdigSession(sessionId);
  if (session.status === "finished") {
    return;
  }
  await setSessionStatus(session.id, "finished");
  await refreshFragwuerdigLobby(guild, session.id);
  for (const player of await getPlayers(session.id)) {
    const state = await getFragwuerdigPlayerState(session.id, player.userId);
    await deleteActivePlayerMessage(guild, player, state?.activeMessageId ?? null);
    await setFragwuerdigPlayerActiveMessage(session.id, player.userId, null);
    const channel = await getTextChannel(guild, player.channelId);
    await channel?.send(`Fragwuerdig beendet. ${reason}`).catch(() => null);
  }
  const meeting = await getTextChannel(guild, session.meetingChannelId);
  const admin = await getTextChannel(guild, session.adminChannelId);
  await meeting?.send(`Fragwuerdig beendet. ${reason}`).catch(() => null);
  await admin?.send(`Fragwuerdig beendet. ${reason}`).catch(() => null);
}

async function sendQuestionToPlayer(guild: Guild, sessionId: number, player: Player, round: FragwuerdigRound): Promise<void> {
  const channel = await getTextChannel(guild, player.channelId);
  if (!channel) {
    throw new Error(`Privater Spielerkanal fuer ${player.username} fehlt.`);
  }
  const state = await getFragwuerdigPlayerState(sessionId, player.userId);
  await deleteActivePlayerMessage(guild, player, state?.activeMessageId ?? null);
  const question = round.impostorIds.includes(player.userId) ? round.impostorQuestion : round.mainQuestion;
  const message = await channel.send(questionMessage(question, round.answerType));
  await setFragwuerdigPlayerActiveMessage(sessionId, player.userId, message.id);
}

async function ensurePrivateChannels(guild: Guild, session: GameSession, players: Player[]): Promise<void> {
  if (!session.categoryId) {
    throw new Error("Session-Kategorie fehlt.");
  }
  for (const player of players) {
    if (player.channelId && await getTextChannel(guild, player.channelId)) {
      continue;
    }
    const member = await guild.members.fetch(player.userId);
    const channel = await createPrivateFragwuerdigChannel(guild, session.categoryId, player, member);
    await setPlayerChannel(session.id, player.userId, channel.id);
    player.channelId = channel.id;
  }
}

async function getFragwuerdigPlayers(sessionId: number, queueState: "active" | "waiting" | "left"): Promise<Player[]> {
  const states = await getFragwuerdigPlayerStates(sessionId, queueState);
  const stateIds = new Set(states.map((state) => state.userId));
  return (await getPlayers(sessionId)).filter((player) => stateIds.has(player.userId));
}

async function clearMeetingForRound(guild: Guild, session: GameSession): Promise<void> {
  const meeting = await getTextChannel(guild, session.meetingChannelId);
  if (meeting) {
    await clearBotMessages(meeting);
    await meeting.send("Neue Fragwuerdig-Runde gestartet. Wartet auf alle Antworten.");
  }
}

function questionMessage(question: string, answerType: FragwuerdigAnswerType): string {
  const base = ["Fragwuerdig", "", "Deine Frage:", question, ""];
  if (answerType === "number") {
    base.push("Wichtig:", "Bitte schreibe nur die Zahl, ohne Masseinheit oder Zusatztext.", 'Also z. B. "2" statt "2 Liter".', "", "Antworte jetzt mit deiner Zahl.");
    return base.join("\n");
  }
  if (answerType === "rating") {
    base.push("Antworte mit einer Zahl von 1 bis 10.");
    return base.join("\n");
  }
  base.push("Antworte mit einer kurzen Antwort.");
  return base.join("\n");
}

function normalizeAnswer(value: string, answerType: FragwuerdigAnswerType): { ok: true; value: string } | { ok: false; message: string } {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return { ok: false, message: "Bitte schreibe eine kurze Antwort." };
  }
  if (answerType === "number" || answerType === "rating") {
    if (!/^\d+(?:[,.]\d+)?$/.test(trimmed)) {
      return { ok: false, message: "Bitte schreibe nur die Zahl, ohne Masseinheit oder Zusatztext." };
    }
    const normalized = trimmed.replace(",", ".");
    if (answerType === "rating") {
      const rating = Number(normalized);
      if (!Number.isFinite(rating) || rating < 1 || rating > 10) {
        return { ok: false, message: "Bitte schreibe eine Zahl von 1 bis 10." };
      }
    }
    return { ok: true, value: normalized };
  }
  return { ok: true, value: trimmed.slice(0, 120) };
}

function pickQuestionPair(usedIds: string[]): FragwuerdigQuestionPair {
  const unused = fragwuerdigQuestionPairs.filter((pair) => !usedIds.includes(pair.id));
  const pool = unused.length ? unused : fragwuerdigQuestionPairs;
  return pool[Math.floor(Math.random() * pool.length)];
}

function nextUsedQuestionIds(usedIds: string[], questionPairId: string): string[] {
  const next = usedIds.length >= fragwuerdigQuestionPairs.length ? [] : [...usedIds];
  next.push(questionPairId);
  return [...new Set(next)];
}

function voteSelectRow(sessionId: number, round: FragwuerdigRound, players: Player[]): ActionRowBuilder<StringSelectMenuBuilder> {
  const impostorCount = round.impostorIds.length;
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(ids.fragwuerdigVote(sessionId, round.id))
      .setPlaceholder(impostorCount === 1 ? "Wer hatte eine andere Frage?" : "Wer hatte andere Fragen?")
      .setMinValues(impostorCount)
      .setMaxValues(impostorCount)
      .addOptions(players.slice(0, 25).map((player) => new StringSelectMenuOptionBuilder().setLabel(player.username.slice(0, 100)).setValue(player.userId)))
  );
}

function lobbyButtonRow(session: GameSession): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(ids.fragwuerdigJoin(session.id)).setLabel("Beitreten").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(ids.fragwuerdigStart(session.id)).setLabel("Spiel starten").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(ids.fragwuerdigCancel(session.id)).setLabel("Abbrechen").setStyle(ButtonStyle.Danger)
  );
}

function roundDecisionRow(sessionId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(ids.fragwuerdigContinue(sessionId)).setLabel("Weiterspielen").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(ids.fragwuerdigStop(sessionId)).setLabel("Aufhoeren").setStyle(ButtonStyle.Secondary)
  );
}

function hostDecisionRow(sessionId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(ids.fragwuerdigNextRound(sessionId)).setLabel("Naechste Runde starten").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(ids.fragwuerdigEnd(sessionId)).setLabel("Session beenden").setStyle(ButtonStyle.Danger)
  );
}

function countVotes(votes: Awaited<ReturnType<typeof getFragwuerdigVotes>>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const vote of votes) {
    for (const target of vote.targetPlayerIds) {
      counts.set(target, (counts.get(target) ?? 0) + 1);
    }
  }
  return counts;
}

function topVotedPlayers(counts: Map<string, number>, amount: number): string[] {
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length < amount) {
    return [];
  }
  const cutoff = sorted[amount - 1][1];
  if (sorted.filter(([, count]) => count === cutoff).length > sorted.slice(0, amount).filter(([, count]) => count === cutoff).length) {
    return [];
  }
  return sorted.slice(0, amount).map(([id]) => id);
}

function formatAnswers(players: Player[], answers: Awaited<ReturnType<typeof getFragwuerdigAnswers>>, numbered: boolean): string[] {
  return answers.map((answer, index) => `${numbered ? `${index + 1}. ` : ""}${playerName(players, answer.playerId)}: ${answer.answerText}`);
}

function formatVoteCounts(players: Player[], counts: Map<string, number>): string[] {
  if (counts.size === 0) {
    return ["Keine Stimmen."];
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id, count]) => `${playerName(players, id)}: ${count} Stimme${count === 1 ? "" : "n"}`);
}

function playerName(players: Player[], userId: string): string {
  return players.find((player) => player.userId === userId)?.username ?? `<@${userId}>`;
}

async function fragwuerdigLobbyEmbed(session: GameSession): Promise<EmbedBuilder> {
  const settings = await getFragwuerdigSettings(session.id);
  const active = await getFragwuerdigPlayers(session.id, "active");
  const waiting = await getFragwuerdigPlayers(session.id, "waiting");
  return new EmbedBuilder()
    .setTitle(`Fragwuerdig Anmeldung ${session.id}`)
    .setDescription(`Status: ${session.status}\nImpostors: ${settings?.impostorCount ?? "?"}\nAktive Spieler: ${active.length}\nWarteschlange: ${waiting.length}`)
    .addFields(
      { name: "Aktiv", value: active.length ? active.map((player) => `<@${player.userId}>`).join("\n") : "Noch niemand." },
      { name: "Warteschlange", value: waiting.length ? waiting.map((player) => `<@${player.userId}>`).join("\n") : "Leer." }
    );
}

async function sendFragwuerdigAdminControls(channel: TextChannel, session: GameSession): Promise<void> {
  await channel.send({
    content: "Admin-Controls",
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(ids.fragwuerdigStart(session.id)).setLabel("Spiel starten").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(ids.fragwuerdigEnd(session.id)).setLabel("Session beenden").setStyle(ButtonStyle.Danger)
    )]
  });
}

async function getOrCreateMinigamesCategory(guild: Guild): Promise<GuildBasedChannel> {
  const existing = guild.channels.cache.find((channel) => channel.type === ChannelType.GuildCategory && channel.name === "Minigames");
  return existing ?? guild.channels.create({ name: "Minigames", type: ChannelType.GuildCategory });
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
  await channel.permissionOverwrites.set(signupPermissionOverwrites(guild, creatorId)).catch((error) => console.error("Fragwuerdig signup permissions failed", error));
  return channel;
}

async function getOrCreateAdminChannel(guild: Guild, parent: string, name: string, creatorId: string): Promise<TextChannel> {
  const channel = await getOrCreateTextChannel(guild, parent, name);
  await channel.permissionOverwrites.set(adminPermissionOverwrites(guild, creatorId)).catch((error) => console.error("Fragwuerdig admin permissions failed", error));
  return channel;
}

async function createPrivateFragwuerdigChannel(guild: Guild, parent: string, player: Player, member: GuildMember): Promise<TextChannel> {
  const overwrites = dedupePermissionOverwrites([
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: player.userId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    { id: guild.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] },
    { id: guild.ownerId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
  ]);
  const adminRole = config.adminRole ? guild.roles.cache.find((role) => role.id === config.adminRole || role.name === config.adminRole) : null;
  if (adminRole) {
    overwrites.push({ id: adminRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
  }
  return guild.channels.create({
    name: `frag-${safeChannelName(member.displayName)}`,
    type: ChannelType.GuildText,
    parent,
    permissionOverwrites: overwrites
  }) as Promise<TextChannel>;
}

async function clearStaleFragwuerdigPlayerChannels(guild: Guild, categoryId: string): Promise<void> {
  const staleChannels = guild.channels.cache.filter(
    (channel) => channel.type === ChannelType.GuildText && channel.parentId === categoryId && channel.name.startsWith("frag-")
  );
  for (const channel of staleChannels.values()) {
    await channel.delete("Alten Fragwuerdig-Spielerkanal vor neuer Session entfernt").catch((error) => console.error(`Stale Fragwuerdig channel ${channel.id} could not be deleted`, error));
  }
}

async function clearBotMessages(channel: TextChannel): Promise<void> {
  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (!messages) {
    return;
  }
  const botMessages = messages.filter((message) => message.author.id === channel.client.user.id);
  await channel.bulkDelete(botMessages, true).catch(async () => {
    for (const message of botMessages.values()) {
      await message.delete().catch(() => null);
    }
  });
}

async function deleteActivePlayerMessage(guild: Guild, player: Player, messageId: string | null): Promise<void> {
  if (!messageId) {
    return;
  }
  const channel = await getTextChannel(guild, player.channelId);
  const message = await channel?.messages.fetch(messageId).catch(() => null);
  await message?.delete().catch(() => null);
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
    { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
    { id: guild.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] },
    { id: creatorId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] },
    { id: guild.ownerId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] }
  ]);
  const adminRole = config.adminRole ? guild.roles.cache.find((role) => role.id === config.adminRole || role.name === config.adminRole) : null;
  if (adminRole) {
    overwrites.push({ id: adminRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] });
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

async function getTextChannel(guild: Guild, channelId: string | null): Promise<TextChannel | null> {
  if (!channelId) {
    return null;
  }
  const channel = (await guild.channels.fetch(channelId).catch(() => null)) as GuildBasedChannel | null;
  return channel?.type === ChannelType.GuildText ? (channel as TextChannel) : null;
}

async function requireFragwuerdigSession(sessionId: number): Promise<GameSession> {
  const session = await getSessionById(sessionId);
  if (!session) {
    throw new Error("Session nicht gefunden.");
  }
  if (session.gameType !== "fragwuerdig") {
    throw new Error("Diese Session ist keine Fragwuerdig-Session.");
  }
  return session;
}

async function requireFragwuerdigSettings(sessionId: number) {
  const settings = await getFragwuerdigSettings(sessionId);
  if (!settings) {
    throw new Error("Fragwuerdig-Einstellungen fehlen.");
  }
  return settings;
}

function assertHostOrAdmin(session: GameSession, userId: string, isAdmin: boolean, message: string): void {
  if (isAdmin || session.createdBy === userId) {
    return;
  }
  throw new Error(message);
}

function safeChannelName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "spieler";
}

function shuffle<T>(values: T[]): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}
