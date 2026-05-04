import { ChatInputCommandInteraction, GuildMember, Interaction, PermissionFlagsBits } from "discord.js";
import { config } from "../config";

export function isAdminInteraction(interaction: ChatInputCommandInteraction | Interaction): boolean {
  if (!interaction.inGuild() || !interaction.member) {
    return false;
  }

  const member = interaction.member as GuildMember;
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return true;
  }

  if (!config.adminRole) {
    return false;
  }

  return member.roles.cache.some((role) => role.id === config.adminRole || role.name === config.adminRole);
}
