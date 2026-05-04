export type SessionStatus = "lobby" | "starting" | "playing" | "meeting" | "ended" | "cancelled";
export type PlayerRole = "crewmate" | "impostor";
export type PlayerState = "alive" | "dead" | "ejected" | "removed";
export type TaskType = "short" | "medium" | "long";

export interface GameSession {
  id: number;
  guildId: string;
  status: SessionStatus;
  categoryId: string | null;
  lobbyChannelId: string | null;
  meetingChannelId: string | null;
  adminChannelId: string | null;
  emergencyChannelId: string | null;
  joinMessageId: string | null;
  createdBy: string;
  emergencyUserId: string;
  lastEmergencyMeetingAt: number | null;
  emergencyCooldownSeconds: number;
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
  description: string;
  completed: boolean;
}

export interface TaskCatalog {
  short_tasks: string[];
  medium_tasks: string[];
  long_tasks: string[];
}

export interface Vote {
  sessionId: number;
  voterId: string;
  targetUserId: string;
}
