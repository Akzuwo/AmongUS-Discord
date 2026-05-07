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
  TextChannel
} from "discord.js";
import { config } from "../config";
import {
  addCrazyPostSentence,
  addCrazyPostText,
  addPlayer,
  advanceCrazyPostText,
  createCrazyPostSession,
  ensureCrazyPostPlayerState,
  getAnyActiveSession,
  getActiveCrazyPostSessionByChannel,
  getCrazyPostPlayerState,
  getCrazyPostSentences,
  getCrazyPostTextById,
  getCrazyPostTexts,
  getNextCrazyPostTextForPlayer,
  getPlayer,
  getPlayers,
  getSessionById,
  setCrazyPostPlayerState,
  setPlayerChannel,
  setSessionStatus,
  updateSessionChannels
} from "../db/repository";
import { CrazyPostOrderMode, GameSession, Player } from "../models/session";
import { ids } from "../utils/customIds";

const WAITING_TEXT =
  "Aktuell gibt es keinen Text fuer dich zum Weiterschreiben. Du bekommst automatisch eine neue Aufgabe, sobald ein Text verfuegbar ist.";

export async function createCrazyPostGameSession(
  guild: Guild,
  creator: GuildMember,
  orderMode: CrazyPostOrderMode
): Promise<GameSession> {
  const active = await getAnyActiveSession();
  if (active) {
    throw new Error(`Es gibt bereits eine aktive Session: ${active.id}`);
  }

  const category = await getOrCreateMinigamesCategory(guild);
  const signup = await getOrCreateSignupChannel(guild, category.id, "verrueckte-post-anmeldung", creator.id);
  const admin = await getOrCreateAdminChannel(guild, category.id, "verrueckte-post-admin", creator.id);

  await Promise.all([
    clearBotMessages(signup),
    clearBotMessages(admin),
    clearStaleCrazyPostPlayerChannels(guild, category.id)
  ]);

  const session = await createCrazyPostSession(guild.id, creator.id, orderMode);
  const joinMessage = await signup.send({
    embeds: [crazyPostLobbyEmbed(session, [])],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(joinButton(session), startButton(session), cancelButton(session))]
  });

  await updateSessionChannels(session.id, {
    categoryId: category.id,
    lobbyChannelId: signup.id,
    adminChannelId: admin.id,
    joinMessageId: joinMessage.id
  });

  const created = (await getSessionById(session.id)) as GameSession;
  await admin.send(`Verrueckte-Post-Session ${session.id} erstellt. Reihenfolge: ${formatOrderMode(orderMode)}.`);
  await sendCrazyPostAdminControls(admin, created);
  return created;
}

export async function joinCrazyPostSession(guild: Guild, sessionId: number, member: GuildMember): Promise<void> {
  const session = await requireCrazyPostSession(sessionId);
  if (session.guildId !== guild.id || session.status !== "lobby") {
    throw new Error("Dieser Session kann nicht mehr beigetreten werden.");
  }

  await addPlayer(session.id, member.id, member.displayName);
  await refreshCrazyPostLobby(guild, session.id);
}

export async function startCrazyPostGame(guild: Guild, sessionId: number, userId: string, isAdmin: boolean): Promise<void> {
  const session = await requireCrazyPostSession(sessionId);
  assertHostOrAdmin(session, userId, isAdmin, "Nur Host oder Spielleitung kann das Spiel starten.");
  if (session.status !== "lobby") {
    throw new Error("Die Session ist nicht in der Anmeldephase.");
  }

  const players = await getPlayers(session.id);
  if (players.length < 3) {
    throw new Error("Mindestens 3 Spieler werden fuer Verrueckte Post benoetigt.");
  }
  if (!session.categoryId) {
    throw new Error("Session-Kategorie fehlt.");
  }

  await setSessionStatus(session.id, "starting");

  for (const player of players) {
    const member = await guild.members.fetch(player.userId);
    const channel = await createPrivateCrazyPostChannel(guild, session.categoryId, player, member);
    await setPlayerChannel(session.id, player.userId, channel.id);
    await ensureCrazyPostPlayerState(session.id, player.userId);
  }

  for (let index = 0; index < players.length; index += 1) {
    const origin = players[index];
    const route = session.orderMode === "random"
      ? [origin.userId, ...shuffle(players.filter((player) => player.userId !== origin.userId).map((player) => player.userId))]
      : [...players.slice(index), ...players.slice(0, index)].map((player) => player.userId);
    await addCrazyPostText(session.id, origin.userId, route);
  }

  await setSessionStatus(session.id, "playing");
  await refreshCrazyPostLobby(guild, session.id);

  for (const player of await getPlayers(session.id)) {
    await showNextCrazyPostTask(guild, session.id, player.userId);
  }
}

export async function handleCrazyPostPlayerMessage(message: Message): Promise<boolean> {
  if (!message.guild || message.author.bot || message.channel.type !== ChannelType.GuildText) {
    return false;
  }

  const session = await getActiveCrazyPostSessionByChannel(message.channel.id);
  if (!session) {
    return false;
  }

  const player = await getPlayer(session.id, message.author.id);
  if (!player || player.channelId !== message.channel.id) {
    return false;
  }

  const state = await getCrazyPostPlayerState(session.id, player.userId);
  if (!state?.activeTextId) {
    await message.reply("Gerade wartet keine Aufgabe auf dich.").catch(() => null);
    return true;
  }

  const content = normalizeSentence(message.content);
  if (!content) {
    await message.reply("Bitte schreibe genau einen Satz als normale Textnachricht.").catch(() => null);
    return true;
  }

  const text = await getCrazyPostTextById(state.activeTextId);
  if (!text || text.finished || text.route[text.currentStepIndex] !== player.userId) {
    await showNextCrazyPostTask(message.guild, session.id, player.userId);
    return true;
  }

  await deleteActiveMessage(message.guild, player, state.activeMessageId);
  await setCrazyPostPlayerState(session.id, player.userId, { activeMessageId: null, activeTextId: null });
  await message.delete().catch(() => null);

  await addCrazyPostSentence(text.id, player.userId, content);
  const nextStepIndex = text.currentStepIndex + 1;
  const finished = nextStepIndex >= text.route.length;
  await advanceCrazyPostText(text.id, nextStepIndex, finished);

  if (!finished) {
    await showNextCrazyPostTask(message.guild, session.id, text.route[nextStepIndex]);
  }

  await showNextCrazyPostTask(message.guild, session.id, player.userId);
  await finishCrazyPostIfComplete(message.guild, session.id);
  return true;
}

export async function cancelCrazyPostSession(guild: Guild, sessionId: number, userId: string, isAdmin: boolean): Promise<string> {
  const session = await requireCrazyPostSession(sessionId);
  assertHostOrAdmin(session, userId, isAdmin, "Nur Host oder Spielleitung kann diese Session abbrechen.");
  if (session.status !== "ended") {
    await setSessionStatus(session.id, "cancelled");
  }
  await refreshCrazyPostLobby(guild, session.id);
  return deleteCrazyPostChannels(guild, session.id);
}

export async function refreshCrazyPostLobby(guild: Guild, sessionId: number): Promise<void> {
  const session = await requireCrazyPostSession(sessionId);
  const registration = await getTextChannel(guild, session.lobbyChannelId);
  if (!registration || !session.joinMessageId) {
    return;
  }

  const players = await getPlayers(session.id);
  const message = await registration.messages.fetch(session.joinMessageId).catch(() => null);
  await message?.edit({
    embeds: [crazyPostLobbyEmbed(session, players)],
    components:
      session.status === "lobby"
        ? [new ActionRowBuilder<ButtonBuilder>().addComponents(joinButton(session), startButton(session), cancelButton(session))]
        : []
  });
}

async function showNextCrazyPostTask(guild: Guild, sessionId: number, userId: string): Promise<void> {
  const player = await getPlayer(sessionId, userId);
  if (!player) {
    return;
  }
  const channel = await getTextChannel(guild, player.channelId);
  if (!channel) {
    return;
  }

  const state = await getCrazyPostPlayerState(sessionId, userId);
  await deleteActiveMessage(guild, player, state?.activeMessageId ?? null);

  const text = await getNextCrazyPostTextForPlayer(sessionId, userId);
  if (!text) {
    const waiting = await channel.send(WAITING_TEXT);
    await setCrazyPostPlayerState(sessionId, userId, { activeMessageId: waiting.id, activeTextId: null });
    return;
  }

  const sentences = await getCrazyPostSentences(text.id);
  const lastSentence = sentences.at(-1)?.content;
  const content = lastSentence
    ? ["**Schreibe genau einen neuen Satz weiter.**", "", "Letzter Satz:", `> ${lastSentence}`].join("\n")
    : "**Starte deinen eigenen Text mit genau einem ersten Satz.**";
  const taskMessage = await channel.send(content);
  await setCrazyPostPlayerState(sessionId, userId, { activeMessageId: taskMessage.id, activeTextId: text.id });
}

async function finishCrazyPostIfComplete(guild: Guild, sessionId: number): Promise<void> {
  const session = await requireCrazyPostSession(sessionId);
  if (session.status !== "playing") {
    return;
  }
  const texts = await getCrazyPostTexts(sessionId);
  if (!texts.length || texts.some((text) => !text.finished)) {
    return;
  }

  await setSessionStatus(sessionId, "ended");
  await refreshCrazyPostLobby(guild, sessionId);
  for (const player of await getPlayers(sessionId)) {
    const state = await getCrazyPostPlayerState(sessionId, player.userId);
    await deleteActiveMessage(guild, player, state?.activeMessageId ?? null);
    await setCrazyPostPlayerState(sessionId, player.userId, { activeMessageId: null, activeTextId: null });
  }
  for (const text of texts) {
    await sendFinishedTextToOrigin(guild, sessionId, text.id);
  }
  const signup = await getTextChannel(guild, session.lobbyChannelId);
  const admin = await getTextChannel(guild, session.adminChannelId);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(ids.crazyPostDelete(session.id)).setLabel("Session aufraeumen").setStyle(ButtonStyle.Danger)
  );
  await signup?.send("Verrueckte Post ist fertig. Alle Spieler haben ihren vollstaendigen Text erhalten.").catch(() => null);
  await admin?.send({ content: "Verrueckte-Post-Session beendet.", components: [row] }).catch(() => null);
}

async function sendFinishedTextToOrigin(guild: Guild, sessionId: number, textId: number): Promise<void> {
  const text = await getCrazyPostTextById(textId);
  if (!text) {
    return;
  }
  const origin = await getPlayer(sessionId, text.originUserId);
  if (!origin) {
    return;
  }
  const channel = await getTextChannel(guild, origin.channelId);
  if (!channel) {
    return;
  }
  const sentences = await getCrazyPostSentences(textId);
  await channel.send([
    "Verrueckte Post ist fertig! Hier ist dein vollstaendiger Text. Lies ihn jetzt im Voicechat vor.",
    "",
    ...sentences.map((sentence, index) => `${index + 1}. ${sentence.content}`)
  ].join("\n"));
}

async function deleteCrazyPostChannels(guild: Guild, sessionId: number): Promise<string> {
  const session = await requireCrazyPostSession(sessionId);
  const idsToDelete = [
    session.lobbyChannelId,
    session.adminChannelId,
    ...(await getPlayers(session.id)).map((player) => player.channelId)
  ].filter(Boolean) as string[];

  const failed: string[] = [];
  for (const channelId of idsToDelete) {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      continue;
    }
    const deleted = await channel.delete("Verrueckte-Post-Session aufgeraeumt").then(() => true).catch((error) => {
      console.error(`Crazy Post channel ${channelId} could not be deleted`, error);
      return false;
    });
    if (!deleted) {
      failed.push(channelId);
    }
  }

  return failed.length
    ? `Einige Session-Kanaele konnten nicht geloescht werden: ${failed.map((id) => `<#${id}>`).join(", ")}`
    : "Session aufgeraeumt. Alle Verrueckte-Post-Kanaele wurden geloescht.";
}

async function deleteActiveMessage(guild: Guild, player: Player, messageId: string | null): Promise<void> {
  if (!messageId) {
    return;
  }
  const channel = await getTextChannel(guild, player.channelId);
  if (!channel) {
    return;
  }
  const message = await channel.messages.fetch(messageId).catch(() => null);
  await message?.delete().catch(() => null);
}

async function getOrCreateMinigamesCategory(guild: Guild): Promise<GuildBasedChannel> {
  const existing = guild.channels.cache.find((channel) => channel.type === ChannelType.GuildCategory && channel.name === "Minigames");
  if (existing) {
    return existing;
  }
  return guild.channels.create({ name: "Minigames", type: ChannelType.GuildCategory });
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
    console.error("Crazy Post signup channel permissions could not be updated", error);
  });
  return channel;
}

async function getOrCreateAdminChannel(guild: Guild, parent: string, name: string, creatorId: string): Promise<TextChannel> {
  const channel = await getOrCreateTextChannel(guild, parent, name);
  await channel.permissionOverwrites.set(adminPermissionOverwrites(guild, creatorId)).catch((error) => {
    console.error("Crazy Post admin channel permissions could not be updated", error);
  });
  return channel;
}

async function createPrivateCrazyPostChannel(guild: Guild, parent: string, player: Player, member: GuildMember): Promise<TextChannel> {
  const overwrites = dedupePermissionOverwrites([
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: player.userId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    {
      id: guild.client.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages]
    },
    { id: guild.ownerId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
  ]);

  const adminRole = config.adminRole ? guild.roles.cache.find((role) => role.id === config.adminRole || role.name === config.adminRole) : null;
  if (adminRole) {
    overwrites.push({ id: adminRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
  }

  const channel = await guild.channels.create({
    name: `post-${safeChannelName(member.displayName)}`,
    type: ChannelType.GuildText,
    parent,
    permissionOverwrites: overwrites
  });
  return channel as TextChannel;
}

async function clearStaleCrazyPostPlayerChannels(guild: Guild, categoryId: string): Promise<void> {
  const staleChannels = guild.channels.cache.filter(
    (channel) => channel.type === ChannelType.GuildText && channel.parentId === categoryId && channel.name.startsWith("post-")
  );
  for (const channel of staleChannels.values()) {
    await channel.delete("Alten Verrueckte-Post-Spielerkanal vor neuer Session entfernt").catch((error) => {
      console.error(`Stale Crazy Post channel ${channel.id} could not be deleted`, error);
    });
  }
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
  await channel.bulkDelete(botMessages, true).catch(async () => {
    for (const message of botMessages.values()) {
      await message.delete().catch(() => null);
    }
  });
}

function crazyPostLobbyEmbed(session: GameSession, players: Player[]): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`Verrueckte Post Anmeldung ${session.id}`)
    .setDescription(`Status: ${session.status}\nReihenfolge: ${formatOrderMode(session.orderMode)}\nSpieler: ${players.length}`)
    .addFields({ name: "Angemeldet", value: players.length ? players.map((player) => `<@${player.userId}>`).join("\n") : "Noch niemand." });
}

async function sendCrazyPostAdminControls(channel: TextChannel, session: GameSession): Promise<void> {
  await channel.send({
    content: "Admin-Controls",
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(ids.crazyPostDelete(session.id)).setLabel("Session aufraeumen").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(ids.crazyPostStart(session.id)).setLabel("Spiel starten").setStyle(ButtonStyle.Success)
      )
    ]
  });
}

function joinButton(session: GameSession): ButtonBuilder {
  return new ButtonBuilder().setCustomId(ids.crazyPostJoin(session.id)).setLabel("Beitreten").setStyle(ButtonStyle.Primary);
}

function startButton(session: GameSession): ButtonBuilder {
  return new ButtonBuilder().setCustomId(ids.crazyPostStart(session.id)).setLabel("Spiel starten").setStyle(ButtonStyle.Success);
}

function cancelButton(session: GameSession): ButtonBuilder {
  return new ButtonBuilder().setCustomId(ids.crazyPostDelete(session.id)).setLabel("Abbrechen").setStyle(ButtonStyle.Danger);
}

function normalizeSentence(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 1000);
}

function formatOrderMode(orderMode: CrazyPostOrderMode | null): string {
  return orderMode === "random" ? "zufaellig" : "statisch";
}

function assertHostOrAdmin(session: GameSession, userId: string, isAdmin: boolean, message: string): void {
  if (isAdmin || session.createdBy === userId) {
    return;
  }
  throw new Error(message);
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

async function getTextChannel(guild: Guild, channelId: string | null): Promise<TextChannel | null> {
  if (!channelId) {
    return null;
  }
  const channel = (await guild.channels.fetch(channelId).catch(() => null)) as GuildBasedChannel | null;
  return channel?.type === ChannelType.GuildText ? (channel as TextChannel) : null;
}

async function requireCrazyPostSession(sessionId: number): Promise<GameSession> {
  const session = await getSessionById(sessionId);
  if (!session) {
    throw new Error("Session nicht gefunden.");
  }
  if (session.gameType !== "crazy_post") {
    throw new Error("Diese Session ist keine Verrueckte-Post-Session.");
  }
  return session;
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
