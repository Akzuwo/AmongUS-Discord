import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { config } from "../config";

export const amongUsCommand = new SlashCommandBuilder()
  .setName("amongus")
  .setDescription("Real-Life Among Us Session verwalten")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("create")
      .setDescription("Neue Session erstellen")
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
  .addSubcommand((subcommand) =>
    subcommand
      .setName("debug-create")
      .setDescription("Debug-Runde mit Ghost-Spielern erstellen")
      .addIntegerOption((option) =>
        option.setName("ghost_count").setDescription("Anzahl Ghost-Spieler").setRequired(true).setMinValue(1).setMaxValue(config.debugMaxGhostPlayers)
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
  .addSubcommand((subcommand) => subcommand.setName("debug-list").setDescription("Ghost-Spieler der Debug-Runde anzeigen"))
  .addSubcommand((subcommand) =>
    subcommand
      .setName("debug-complete-task")
      .setDescription("Naechsten offenen Ghost-Task oder Step abschliessen")
      .addStringOption((option) => option.setName("player").setDescription("Ghost-Name oder ID").setRequired(true))
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("debug-kill")
      .setDescription("Ghost-Spieler als tot markieren")
      .addStringOption((option) => option.setName("victim").setDescription("Ghost-Name oder ID").setRequired(true))
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("debug-vote")
      .setDescription("Ghost-Stimme abgeben")
      .addStringOption((option) => option.setName("voter").setDescription("Ghost-Name oder ID").setRequired(true))
      .addStringOption((option) => option.setName("target").setDescription("Spielername, Spieler-ID oder skip").setRequired(true))
  )
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
