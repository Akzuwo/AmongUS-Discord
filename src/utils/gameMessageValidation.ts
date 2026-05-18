import { Message } from "discord.js";

export const PLAIN_GAME_MESSAGE_ERROR = "Links, Bilder und Anhänge sind in diesem Spiel nicht erlaubt. Bitte sende nur normalen Text.";

const URL_PATTERNS = [
  /https?:\/\/[^\s<]+/i,
  /\bwww\.[^\s<]+/i,
  /\bdiscord(?:\.gg|app\.com\/invite|\.com\/invite)\/[^\s<]+/i,
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|de|ch|gg|io|app|dev|me|co|tv|info|biz|xyz|at|eu|fr|it|nl|uk|us|to|ai)(?:\/[^\s<]*)?/i
];

export function validatePlainGameMessage(message: Message): { ok: true } | { ok: false; reason: string } {
  if (message.attachments.size > 0) {
    return { ok: false, reason: "attachment" };
  }
  if (message.embeds.length > 0) {
    return { ok: false, reason: "embed" };
  }
  if (!validatePlainGameText(message.content ?? "").ok) {
    return { ok: false, reason: "url" };
  }
  return { ok: true };
}

export function validatePlainGameText(content: string): { ok: true } | { ok: false; reason: string } {
  if (URL_PATTERNS.some((pattern) => pattern.test(content))) {
    return { ok: false, reason: "url" };
  }
  return { ok: true };
}
