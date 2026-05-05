import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export const config = {
  token: required("DISCORD_TOKEN"),
  clientId: required("CLIENT_ID"),
  guildId: process.env.GUILD_ID || undefined,
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
  adminPanelKey: process.env.ADMIN_PANEL_KEY || "",
  emergencyPanelKey: process.env.EMERGENCY_PANEL_KEY || ""
};
