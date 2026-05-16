import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { logger } from "../utils/logger";

const accessLogger = logger.scoped("GuildAccess");
const allowedGuildSet = new Set(config.allowedGuilds);

export const NOT_ALLOWED_MESSAGE = "Dieser Server ist für diesen Bot nicht freigeschaltet.";

export function logGuildAccessConfiguration(): void {
  accessLogger.info("Guild-Allowlist-Konfiguration.", {
    rawAllowedGuilds: config.rawAllowedGuilds,
    parsedGuildIds: [...allowedGuildSet],
    nodeEnv: process.env.NODE_ENV || "",
    botEnv: process.env.BOT_ENV || "",
    resolvedBotEnv: config.botEnv
  });

  if (config.emptyAllowedGuildEntries > 0 && config.rawAllowedGuilds.length > 0) {
    accessLogger.warn("Leere Eintraege in ALLOWED_GUILDS ignoriert.", { count: config.emptyAllowedGuildEntries });
  }

  for (const guildId of config.invalidAllowedGuilds) {
    accessLogger.warn("Ungueltige Guild-ID in der Allowlist ignoriert.", { guildId });
  }

  if (allowedGuildSet.size === 0) {
    if (config.isProduction) {
      accessLogger.error("ALLOWED_GUILDS ist leer. Im Production-Modus ist keine Guild freigeschaltet.");
    } else {
      accessLogger.warn("ALLOWED_GUILDS ist leer. Im Development-Modus sind alle Guilds erlaubt.");
    }
    return;
  }

  accessLogger.info("Guild-Allowlist geladen.", { guildIds: [...allowedGuildSet] });
}

export function isGuildAllowed(guildId: string | null | undefined): boolean {
  if (!guildId) {
    return false;
  }
  if (allowedGuildSet.size === 0) {
    return !config.isProduction;
  }
  return allowedGuildSet.has(guildId);
}

export function allowedGuildIds(): string[] {
  return [...allowedGuildSet];
}

export function ensureGuildAllowed(guildId: string | null | undefined): string {
  if (!isGuildAllowed(guildId)) {
    throw new Error(NOT_ALLOWED_MESSAGE);
  }
  return guildId as string;
}

export function guildStoragePath(guildId: string): string {
  ensureGuildAllowed(guildId);
  return path.join("data", "guilds", guildId);
}

export function prepareAllowedGuildStorage(): void {
  if (allowedGuildSet.size === 0) {
    return;
  }

  for (const guildId of allowedGuildSet) {
    fs.mkdirSync(guildStoragePath(guildId), { recursive: true });
  }
}

export function warnAboutLegacyGlobalJsonStorage(): void {
  const legacyFiles = ["config.json", "sessions.json", "tasks.json", "verrueckte_post.json", "fragwuerdig.json", "logs.json"]
    .map((file) => path.join("data", file))
    .filter((file) => fs.existsSync(file) && path.basename(file) !== "tasks.json");

  for (const file of legacyFiles) {
    accessLogger.warn("Legacy-JSON-Datei im globalen data/-Ordner gefunden. Sie wird nicht automatisch geloescht oder guild-uebergreifend verwendet.", { file });
  }
}
