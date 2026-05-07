export const ids = {
  join: (sessionId: number) => `amongus:join:${sessionId}`,
  start: (sessionId: number) => `amongus:start:${sessionId}`,
  end: (sessionId: number) => `amongus:end:${sessionId}`,
  confirmEnd: (sessionId: number) => `amongus:confirm-end:${sessionId}`,
  adminStatus: (sessionId: number) => `amongus:admin-status:${sessionId}`,
  deletePrompt: (sessionId: number) => `amongus:delete-prompt:${sessionId}`,
  deleteConfirm: (sessionId: number) => `amongus:delete-confirm:${sessionId}`,
  deleteCancel: (sessionId: number) => `amongus:delete-cancel:${sessionId}`,
  taskDone: (taskId: number) => `amongus:task-done:${taskId}`,
  taskStepDone: (sessionId: number, taskId: number, stepRowId: number) => `amongus:task-step:${sessionId}:${taskId}:${stepRowId}`,
  killPlayer: (sessionId: number) => `amongus:kill:${sessionId}`,
  killSelect: (sessionId: number) => `amongus:kill-select:${sessionId}`,
  emergencyMeeting: (sessionId: number) => `amongus:emergency:${sessionId}`,
  reportBody: (sessionId: number) => `amongus:report-body:${sessionId}`,
  reportBodySelect: (sessionId: number) => `amongus:report-body-select:${sessionId}`,
  reportBodyModal: (sessionId: number) => `amongus:report-body-modal:${sessionId}`,
  vote: (sessionId: number, targetUserId: string) => `amongus:vote:${sessionId}:${targetUserId}`,
  skipVote: (sessionId: number) => `amongus:vote:${sessionId}:skip`,
  crazyPostJoin: (sessionId: number) => `post:join:${sessionId}`,
  crazyPostStart: (sessionId: number) => `post:start:${sessionId}`,
  crazyPostDelete: (sessionId: number) => `post:delete:${sessionId}`,
  fragwuerdigJoin: (sessionId: number) => `frag:join:${sessionId}`,
  fragwuerdigStart: (sessionId: number) => `frag:start:${sessionId}`,
  fragwuerdigCancel: (sessionId: number) => `frag:cancel:${sessionId}`,
  fragwuerdigVote: (sessionId: number, roundId: number) => `frag:vote:${sessionId}:${roundId}`,
  fragwuerdigContinue: (sessionId: number) => `frag:continue:${sessionId}`,
  fragwuerdigStop: (sessionId: number) => `frag:stop:${sessionId}`,
  fragwuerdigNextRound: (sessionId: number) => `frag:next:${sessionId}`,
  fragwuerdigEnd: (sessionId: number) => `frag:end:${sessionId}`
};

export function parseCustomId(customId: string): string[] {
  return customId.split(":");
}
