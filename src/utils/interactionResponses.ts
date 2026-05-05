import { DiscordAPIError, InteractionReplyOptions, MessageFlags, RepliableInteraction } from "discord.js";
import { logger } from "./logger";

const interactionLogger = logger.scoped("Interaction");

export function ephemeral(content: string): InteractionReplyOptions {
  return { content, flags: MessageFlags.Ephemeral };
}

export async function safeReply(
  interaction: RepliableInteraction,
  content: string,
  isEphemeral = true
): Promise<void> {
  const payload: InteractionReplyOptions = isEphemeral
    ? { content, flags: MessageFlags.Ephemeral }
    : { content };

  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch(async (error) => {
        if (isExpectedInteractionError(error)) {
          logExpectedInteractionError(error);
          return;
        }
        throw error;
      });
      return;
    }

    await interaction.reply(payload);
  } catch (error) {
    if (isExpectedInteractionError(error)) {
      logExpectedInteractionError(error);
      return;
    }
    interactionLogger.error("Failed to respond to interaction.", error);
  }
}

export function isExpectedInteractionError(error: unknown): boolean {
  return error instanceof DiscordAPIError && (error.code === 10062 || error.code === 40060);
}

export function logExpectedInteractionError(error: unknown): void {
  if (!(error instanceof DiscordAPIError)) {
    return;
  }
  if (error.code === 10062) {
    interactionLogger.debug("Interaction expired before response could be sent.");
    return;
  }
  if (error.code === 40060) {
    interactionLogger.debug("Interaction was already acknowledged.");
  }
}
