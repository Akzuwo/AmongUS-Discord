import "dotenv/config";

const DISCORD_ID_PATTERN = /^\d{17,20}$/;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function parseAllowedGuilds(): { allowedGuilds: string[]; invalidAllowedGuilds: string[]; emptyAllowedGuildEntries: number } {
  const rawEntries = (process.env.ALLOWED_GUILDS || "").split(",");
  const emptyAllowedGuildEntries = rawEntries.filter((entry) => entry.trim().length === 0).length;
  const unique = [...new Set(rawEntries.map((entry) => entry.trim()).filter(Boolean))];
  return {
    allowedGuilds: unique.filter((value) => DISCORD_ID_PATTERN.test(value)),
    invalidAllowedGuilds: unique.filter((value) => !DISCORD_ID_PATTERN.test(value)),
    emptyAllowedGuildEntries
  };
}

const guildConfig = parseAllowedGuilds();
const botEnv = (process.env.BOT_ENV || process.env.NODE_ENV || "development").toLowerCase();

export const config = {
  token: required("DISCORD_TOKEN"),
  clientId: required("CLIENT_ID"),
  rawAllowedGuilds: process.env.ALLOWED_GUILDS || "",
  allowedGuilds: guildConfig.allowedGuilds,
  invalidAllowedGuilds: guildConfig.invalidAllowedGuilds,
  emptyAllowedGuildEntries: guildConfig.emptyAllowedGuildEntries,
  botEnv,
  isProduction: botEnv === "production" || botEnv === "prod",
  singleGuildMode: (process.env.SINGLE_GUILD_MODE || "false").toLowerCase() === "true",
  adminRole: process.env.ADMIN_ROLE || undefined,
  databasePath: process.env.DATABASE_PATH || "./data/amongus.sqlite",
  tasksPath: process.env.TASKS_PATH || "./data/tasks.json",
  killCooldownSeconds: Number(process.env.KILL_COOLDOWN_SECONDS || "30"),
  defaultDiscussionTimeMinutes: Number(process.env.DEFAULT_DISCUSSION_TIME_MINUTES || "3"),
  defaultVotingTimeMinutes: Number(process.env.DEFAULT_VOTING_TIME_MINUTES || "2"),
  emergencyCooldownSeconds: Number(process.env.EMERGENCY_COOLDOWN_SECONDS || "300"),
  debugMode: (process.env.DEBUG_MODE || "false").toLowerCase() === "true",
  logLevel: process.env.LOG_LEVEL || "info",
  debugMaxGhostPlayers: Number(process.env.DEBUG_MAX_GHOST_PLAYERS || "15"),
  webPanelEnabled: (process.env.WEB_PANEL_ENABLED || "true").toLowerCase() !== "false",
  webPanelPort: Number(process.env.WEB_PANEL_PORT || "3000"),
  adminPanelEnabled: (process.env.ADMIN_PANEL_ENABLED || "false").toLowerCase() === "true",
  adminPanelPort: Number(process.env.ADMIN_PANEL_PORT || "3001"),
  emergencyPanelKey: process.env.EMERGENCY_PANEL_KEY || ""
};
