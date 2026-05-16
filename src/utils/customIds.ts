export const ids = {
  join: (guildId: string, sessionId: number) => `amongus:join:${guildId}:${sessionId}`,
  start: (guildId: string, sessionId: number) => `amongus:start:${guildId}:${sessionId}`,
  end: (guildId: string, sessionId: number) => `amongus:end:${guildId}:${sessionId}`,
  confirmEnd: (guildId: string, sessionId: number) => `amongus:confirm-end:${guildId}:${sessionId}`,
  adminStatus: (guildId: string, sessionId: number) => `amongus:admin-status:${guildId}:${sessionId}`,
  deletePrompt: (guildId: string, sessionId: number) => `amongus:delete-prompt:${guildId}:${sessionId}`,
  deleteConfirm: (guildId: string, sessionId: number) => `amongus:delete-confirm:${guildId}:${sessionId}`,
  deleteCancel: (guildId: string, sessionId: number) => `amongus:delete-cancel:${guildId}:${sessionId}`,
  taskDone: (guildId: string, sessionId: number, taskId: number) => `amongus:task-done:${guildId}:${sessionId}:${taskId}`,
  taskStepDone: (guildId: string, sessionId: number, taskId: number, stepRowId: number) => `amongus:task-step:${guildId}:${sessionId}:${taskId}:${stepRowId}`,
  killPlayer: (guildId: string, sessionId: number) => `amongus:kill:${guildId}:${sessionId}`,
  killSelect: (guildId: string, sessionId: number) => `amongus:kill-select:${guildId}:${sessionId}`,
  emergencyMeeting: (guildId: string, sessionId: number) => `amongus:emergency:${guildId}:${sessionId}`,
  reportBody: (guildId: string, sessionId: number) => `amongus:report-body:${guildId}:${sessionId}`,
  reportBodySelect: (guildId: string, sessionId: number) => `amongus:report-body-select:${guildId}:${sessionId}`,
  reportBodyModal: (guildId: string, sessionId: number) => `amongus:report-body-modal:${guildId}:${sessionId}`,
  vote: (guildId: string, sessionId: number, targetUserId: string) => `amongus:vote:${guildId}:${sessionId}:${targetUserId}`,
  skipVote: (guildId: string, sessionId: number) => `amongus:vote:${guildId}:${sessionId}:skip`,
  crazyPostJoin: (guildId: string, sessionId: number) => `post:join:${guildId}:${sessionId}`,
  crazyPostStart: (guildId: string, sessionId: number) => `post:start:${guildId}:${sessionId}`,
  crazyPostDelete: (guildId: string, sessionId: number) => `post:delete:${guildId}:${sessionId}`,
  fragwuerdigJoin: (guildId: string, sessionId: number) => `frag:join:${guildId}:${sessionId}`,
  fragwuerdigStart: (guildId: string, sessionId: number) => `frag:start:${guildId}:${sessionId}`,
  fragwuerdigCancel: (guildId: string, sessionId: number) => `frag:cancel:${guildId}:${sessionId}`,
  fragwuerdigVote: (guildId: string, sessionId: number, roundId: number) => `frag:vote:${guildId}:${sessionId}:${roundId}`,
  fragwuerdigContinue: (guildId: string, sessionId: number) => `frag:continue:${guildId}:${sessionId}`,
  fragwuerdigStop: (guildId: string, sessionId: number) => `frag:stop:${guildId}:${sessionId}`,
  fragwuerdigNextRound: (guildId: string, sessionId: number) => `frag:next:${guildId}:${sessionId}`,
  fragwuerdigEnd: (guildId: string, sessionId: number) => `frag:end:${guildId}:${sessionId}`
};

export function parseCustomId(customId: string): string[] {
  return customId.split(":");
}

export function parseScopedCustomId(parts: string[], guildId: string): { action: string; sessionId: number; args: string[] } | null {
  const action = parts[1];
  if (!action) {
    return null;
  }

  if (parts[2] === guildId) {
    const sessionId = Number(parts[3]);
    return Number.isFinite(sessionId) ? { action, sessionId, args: parts.slice(4) } : null;
  }

  return null;
}
