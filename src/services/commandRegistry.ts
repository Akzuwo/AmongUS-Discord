import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { config } from "../config";

export const amongUsCommand = new SlashCommandBuilder()
  .setName("amongus")
  .setDescription("Real-Life Among Us Session verwalten")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("create")
      .setDescription("Neue Session erstellen")
      .addUserOption((option) =>
        option.setName("emergency_user").setDescription("User, der Emergency Meetings ausloesen darf").setRequired(true)
      )
      .addIntegerOption((option) =>
        option.setName("short").setDescription("Short Tasks pro Spieler").setMinValue(0).setMaxValue(10)
      )
      .addIntegerOption((option) =>
        option.setName("medium").setDescription("Medium Tasks pro Spieler").setMinValue(0).setMaxValue(10)
      )
      .addIntegerOption((option) =>
        option.setName("long").setDescription("Long Tasks pro Spieler").setMinValue(0).setMaxValue(10)
      )
      .addIntegerOption((option) =>
        option.setName("discussion_time").setDescription("Diskussionszeit in Minuten").setMinValue(1).setMaxValue(15)
      )
      .addIntegerOption((option) =>
        option.setName("voting_time").setDescription("Votingzeit in Minuten").setMinValue(1).setMaxValue(15)
      )
  )
  .addSubcommand((subcommand) => subcommand.setName("start").setDescription("Aktuelle Session starten"))
  .addSubcommand((subcommand) => subcommand.setName("meeting").setDescription("Admin-Meeting starten"))
  .addSubcommand((subcommand) =>
    subcommand
      .setName("clear-warns")
      .setDescription("False-Report-Verwarnungen eines Users zuruecksetzen")
      .addUserOption((option) => option.setName("user").setDescription("Spieler").setRequired(true))
  )
  .addSubcommand((subcommand) => subcommand.setName("status").setDescription("Status der aktuellen Session anzeigen"))
  .addSubcommand((subcommand) => subcommand.setName("end").setDescription("Aktuelle Session beenden"));

export async function registerCommands(): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(config.token);
  const body = [amongUsCommand.toJSON()];

  if (config.guildId) {
    await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body });
    return;
  }

  await rest.put(Routes.applicationCommands(config.clientId), { body });
}
