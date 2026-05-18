export type SessionStatus = "lobby" | "starting" | "playing" | "meeting" | "answering" | "voting" | "round_finished" | "finished" | "ended" | "cancelled";
export type GameType = "amongus" | "crazy_post" | "fragwuerdig";
export type CrazyPostOrderMode = "static" | "random";
export type FragwuerdigAnswerType = "number" | "text" | "rating" | "time" | "choice";
export type FragwuerdigPlayerQueueState = "active" | "waiting" | "left";
export type MeetingPhase = "none" | "called" | "discussion" | "voting" | "result";
export type PlayerRole = "crewmate" | "impostor";
export type PlayerState = "alive" | "dead" | "ejected" | "removed";
export type TaskType = "short" | "medium" | "long";

export interface GameSession {
  id: number;
  guildId: string;
  gameType: GameType;
  status: SessionStatus;
  isDebugSession: boolean;
  ghostCount: number;
  orderMode: CrazyPostOrderMode | null;
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
  location: string;
  category: TaskType;
  steps?: TaskStep[];
}

export type RawCatalogTask = Omit<Partial<CatalogTask>, "category"> & {
  name?: string;
  beschreibung?: string;
  ort?: string;
};

export interface TaskCatalog {
  short_tasks: Array<string | RawCatalogTask>;
  medium_tasks: Array<string | RawCatalogTask>;
  long_tasks: Array<string | RawCatalogTask>;
}

export interface Vote {
  sessionId: number;
  voterId: string;
  targetUserId: string;
}

export interface CrazyPostText {
  id: number;
  sessionId: number;
  originUserId: string;
  route: string[];
  currentStepIndex: number;
  finished: boolean;
  createdAt: string;
}

export interface CrazyPostSentence {
  id: number;
  textId: number;
  authorId: string;
  content: string;
  createdAt: string;
}

export type CrazyPostReviewStatus = "pending_review" | "approved" | "rejected" | "posted";

export interface CrazyPostReview {
  reviewId: string;
  guildId: string;
  sessionId: number;
  textId: number;
  gameType: "crazy_post";
  createdAt: string;
  updatedAt: string;
  status: CrazyPostReviewStatus;
  originalText: string;
  editedText: string | null;
  contributions: Array<{ authorId: string; content: string; createdAt: string }>;
  debugSession: boolean;
  rejectedAt: string | null;
  approvedAt: string | null;
  postedAt: string | null;
  textCollectionMessageId: string | null;
}

export interface CrazyPostPlayerState {
  sessionId: number;
  userId: string;
  activeMessageId: string | null;
  activeTextId: number | null;
  queueMessageId: string | null;
  queueWarningActive: boolean;
}

export interface FragwuerdigQuestionPair {
  id: string;
  mainQuestion: string;
  impostorQuestion: string;
  answerType: FragwuerdigAnswerType;
  category?: string;
}

export interface FragwuerdigSettings {
  sessionId: number;
  impostorCount: 1 | 2;
  roundNumber: number;
  usedQuestionPairIds: string[];
}

export interface FragwuerdigPlayerState {
  sessionId: number;
  userId: string;
  queueState: FragwuerdigPlayerQueueState;
  activeMessageId: string | null;
  wantsToContinue: boolean | null;
}

export interface FragwuerdigRound {
  id: number;
  sessionId: number;
  roundNumber: number;
  questionPairId: string;
  mainQuestion: string;
  impostorQuestion: string;
  answerType: FragwuerdigAnswerType;
  impostorIds: string[];
  status: "answering" | "voting" | "revealed" | "finished";
  createdAt: string;
}

export interface FragwuerdigAnswer {
  id: number;
  roundId: number;
  playerId: string;
  answerText: string;
  createdAt: string;
}

export interface FragwuerdigVote {
  id: number;
  roundId: number;
  voterId: string;
  targetPlayerIds: string[];
  createdAt: string;
}
