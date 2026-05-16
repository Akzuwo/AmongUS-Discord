import { ChatInputCommandInteraction, Guild, GuildMember, Interaction, Message } from "discord.js";
import { isGuildAllowed, NOT_ALLOWED_MESSAGE } from "../services/guildAccessService";
import { logger } from "./logger";

export const SERVER_ONLY_COMMAND_MESSAGE = "Dieser Command funktioniert nur auf einem Server.";
export const SERVER_ONLY_INTERACTION_MESSAGE = "Diese Interaktion funktioniert nur auf einem Server.";

const guildContextLogger = logger.scoped("GuildContext");

export function interactionGuildId(interaction: Interaction): string | null {
  return interaction.guildId ?? interaction.guild?.id ?? null;
}

export function messageGuildId(message: Message): string | null {
  return message.guildId ?? message.guild?.id ?? null;
}

export function logBlockedInteraction(interaction: Interaction, reason: "keine guildId" | "Guild nicht erlaubt"): void {
  guildContextLogger.warn("Interaction blockiert.", {
    commandName: interaction.isChatInputCommand() ? interaction.commandName : undefined,
    customId: "customId" in interaction ? interaction.customId : undefined,
    userId: interaction.user.id,
    guildId: interactionGuildId(interaction),
    reason
  });
}

export function logBlockedMessage(message: Message, reason: "keine guildId" | "Guild nicht erlaubt"): void {
  guildContextLogger.warn("Message blockiert.", {
    userId: message.author.id,
    guildId: messageGuildId(message),
    reason
  });
}

export function guildAllowedOrMessage(guildId: string | null): { ok: true } | { ok: false; message: string; reason: "keine guildId" | "Guild nicht erlaubt" } {
  if (!guildId) {
    return { ok: false, message: SERVER_ONLY_COMMAND_MESSAGE, reason: "keine guildId" };
  }
  if (!isGuildAllowed(guildId)) {
    return { ok: false, message: NOT_ALLOWED_MESSAGE, reason: "Guild nicht erlaubt" };
  }
  return { ok: true };
}

export async function resolveCommandGuildContext(
  interaction: ChatInputCommandInteraction
): Promise<{ ok: true; guild: Guild; member: GuildMember; guildId: string } | { ok: false; message: string; reason: "keine guildId" | "Guild nicht erlaubt" }> {
  return resolveInteractionGuildContext(interaction, SERVER_ONLY_COMMAND_MESSAGE);
}

export async function resolveInteractionGuildContext(
  interaction: Interaction,
  serverOnlyMessage = SERVER_ONLY_INTERACTION_MESSAGE
): Promise<{ ok: true; guild: Guild; member: GuildMember; guildId: string } | { ok: false; message: string; reason: "keine guildId" | "Guild nicht erlaubt" }> {
  const guildId = interactionGuildId(interaction);
  const allowed = guildAllowedOrMessage(guildId);
  if (!allowed.ok) {
    logBlockedInteraction(interaction, allowed.reason);
    return { ...allowed, message: allowed.reason === "keine guildId" ? serverOnlyMessage : allowed.message };
  }
  const checkedGuildId = guildId as string;

  const guild = interaction.guild ?? await interaction.client.guilds.fetch(checkedGuildId).catch(() => null);
  if (!guild) {
    logBlockedInteraction(interaction, "keine guildId");
    return { ok: false, message: serverOnlyMessage, reason: "keine guildId" };
  }

  const member = interaction.member instanceof GuildMember
    ? interaction.member
    : await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) {
    logBlockedInteraction(interaction, "keine guildId");
    return { ok: false, message: serverOnlyMessage, reason: "keine guildId" };
  }

  return { ok: true, guild, member, guildId: checkedGuildId };
}
