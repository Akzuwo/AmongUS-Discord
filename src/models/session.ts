export type SessionStatus = "lobby" | "starting" | "playing" | "meeting" | "ended" | "cancelled";
export type MeetingPhase = "none" | "called" | "discussion" | "voting" | "result";
export type PlayerRole = "crewmate" | "impostor";
export type PlayerState = "alive" | "dead" | "ejected" | "removed";
export type TaskType = "short" | "medium" | "long";

export interface GameSession {
  id: number;
  guildId: string;
  status: SessionStatus;
  isDebugSession: boolean;
  ghostCount: number;
  categoryId: string | null;
  lobbyChannelId: string | null;
  meetingChannelId: string | null;
  adminChannelId: string | null;
  emergencyChannelId: string | null;
  joinMessageId: string | null;
  createdBy: string;
  emergencyUserId: string | null;
  lastEmergencyMeetingAt: number | null;
  emergencyCooldownSeconds: number;
  meetingPhase: MeetingPhase;
  discussionStartedAt: number | null;
  votingStartedAt: number | null;
  shortTasks: number;
  mediumTasks: number;
  longTasks: number;
  discussionTimeMinutes: number;
  votingTimeMinutes: number;
  createdAt: string;
  endedAt: string | null;
}

export interface Player {
  id: number;
  sessionId: number;
  userId: string;
  discordUserId: string | null;
  isGhost: boolean;
  username: string;
  role: PlayerRole | null;
  state: PlayerState;
  deathReported: boolean;
  channelId: string | null;
  joinedAt: string;
}

export interface PlayerTask {
  id: number;
  sessionId: number;
  userId: string;
  taskType: TaskType;
  taskId: string | null;
  title: string;
  description: string;
  location: string | null;
  completed: boolean;
  completedAt: string | null;
  steps: PlayerTaskStep[];
}

export interface PlayerTaskStep {
  id: number;
  assignedTaskId: number;
  stepId: string;
  title: string;
  description: string | null;
  completed: boolean;
  completedAt: string | null;
}

export interface TaskStep {
  id: string;
  title: string;
  description?: string;
}

export interface CatalogTask {
  id: string;
  title: string;
  description: string;
  location?: string;
  category: TaskType;
  steps?: TaskStep[];
}

export interface TaskCatalog {
  short_tasks: Array<string | Omit<CatalogTask, "category">>;
  medium_tasks: Array<string | Omit<CatalogTask, "category">>;
  long_tasks: Array<string | Omit<CatalogTask, "category">>;
}

export interface Vote {
  sessionId: number;
  voterId: string;
  targetUserId: string;
}
