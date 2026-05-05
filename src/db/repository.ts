import { CatalogTask, GameSession, MeetingPhase, Player, PlayerTask, PlayerTaskStep, PlayerRole, PlayerState, SessionStatus, TaskType, Vote } from "../models/session";
import { getDb } from "./database";

function mapSession(row: any): GameSession {
  return {
    id: row.id,
    guildId: row.guild_id,
    status: row.status,
    isDebugSession: row.is_debug_session === 1,
    ghostCount: row.ghost_count ?? 0,
    categoryId: row.category_id,
    lobbyChannelId: row.lobby_channel_id,
    meetingChannelId: row.meeting_channel_id,
    adminChannelId: row.admin_channel_id,
    emergencyChannelId: row.emergency_channel_id,
    joinMessageId: row.join_message_id,
    createdBy: row.created_by,
    emergencyUserId: row.emergency_user_id,
    lastEmergencyMeetingAt: row.last_emergency_meeting_at,
    emergencyCooldownSeconds: row.emergency_cooldown_seconds,
    meetingPhase: row.meeting_phase ?? "none",
    discussionStartedAt: row.discussion_started_at,
    votingStartedAt: row.voting_started_at,
    shortTasks: row.short_tasks,
    mediumTasks: row.medium_tasks,
    longTasks: row.long_tasks,
    discussionTimeMinutes: row.discussion_time_minutes,
    votingTimeMinutes: row.voting_time_minutes,
    createdAt: row.created_at,
    endedAt: row.ended_at
  };
}

function mapPlayer(row: any): Player {
  return {
    id: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
    discordUserId: row.discord_user_id,
    isGhost: row.is_ghost === 1,
    username: row.username,
    role: row.role,
    state: row.state,
    deathReported: row.death_reported === 1,
    channelId: row.channel_id,
    joinedAt: row.joined_at
  };
}

function mapTask(row: any): PlayerTask {
  return {
    id: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
    taskType: row.task_type,
    taskId: row.task_id,
    title: row.title || row.description,
    description: row.description,
    location: row.location,
    completed: row.completed === 1,
    completedAt: row.completed_at,
    steps: []
  };
}

function mapTaskStep(row: any): PlayerTaskStep {
  return {
    id: row.id,
    assignedTaskId: row.assigned_task_id,
    stepId: row.step_id,
    title: row.title,
    description: row.description,
    completed: row.completed === 1,
    completedAt: row.completed_at
  };
}

export async function createSession(
  guildId: string,
  createdBy: string,
  emergencyUserId: string | null,
  counts: { short: number; medium: number; long: number },
  meetingTimes: { discussion: number; voting: number },
  options: { isDebugSession?: boolean; ghostCount?: number } = {}
): Promise<GameSession> {
  const db = await getDb();
  const result = await db.run(
    `INSERT INTO sessions (guild_id, status, created_by, emergency_user_id, emergency_cooldown_seconds, short_tasks, medium_tasks, long_tasks, discussion_time_minutes, voting_time_minutes, is_debug_session, ghost_count)
     VALUES (?, 'lobby', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    guildId,
    createdBy,
    emergencyUserId ?? "",
    Number(process.env.EMERGENCY_COOLDOWN_SECONDS || "300"),
    counts.short,
    counts.medium,
    counts.long,
    meetingTimes.discussion,
    meetingTimes.voting,
    options.isDebugSession ? 1 : 0,
    options.ghostCount ?? 0
  );
  return getSessionById(result.lastID as number) as Promise<GameSession>;
}

export async function getSessionById(sessionId: number): Promise<GameSession | null> {
  const db = await getDb();
  const row = await db.get("SELECT * FROM sessions WHERE id = ?", sessionId);
  return row ? mapSession(row) : null;
}

export async function getActiveSession(guildId: string): Promise<GameSession | null> {
  const db = await getDb();
  const row = await db.get(
    "SELECT * FROM sessions WHERE guild_id = ? AND status NOT IN ('ended', 'cancelled') ORDER BY id DESC LIMIT 1",
    guildId
  );
  return row ? mapSession(row) : null;
}

export async function getLatestSession(): Promise<GameSession | null> {
  const db = await getDb();
  const row = await db.get("SELECT * FROM sessions ORDER BY id DESC LIMIT 1");
  return row ? mapSession(row) : null;
}

export async function getLatestActiveSession(): Promise<GameSession | null> {
  const db = await getDb();
  const row = await db.get("SELECT * FROM sessions WHERE status NOT IN ('ended', 'cancelled') ORDER BY id DESC LIMIT 1");
  return row ? mapSession(row) : null;
}

export async function updateSessionChannels(
  sessionId: number,
  values: Partial<Pick<GameSession, "categoryId" | "lobbyChannelId" | "meetingChannelId" | "adminChannelId" | "emergencyChannelId" | "joinMessageId">>
): Promise<void> {
  const db = await getDb();
  await db.run(
    `UPDATE sessions
     SET category_id = COALESCE(?, category_id),
         lobby_channel_id = COALESCE(?, lobby_channel_id),
         meeting_channel_id = COALESCE(?, meeting_channel_id),
         admin_channel_id = COALESCE(?, admin_channel_id),
         emergency_channel_id = COALESCE(?, emergency_channel_id),
         join_message_id = COALESCE(?, join_message_id)
     WHERE id = ?`,
    values.categoryId,
    values.lobbyChannelId,
    values.meetingChannelId,
    values.adminChannelId,
    values.emergencyChannelId,
    values.joinMessageId,
    sessionId
  );
}

export async function setLastEmergencyMeetingAt(sessionId: number, timestamp: number): Promise<void> {
  const db = await getDb();
  await db.run("UPDATE sessions SET last_emergency_meeting_at = ? WHERE id = ?", timestamp, sessionId);
}

export async function setMeetingPhase(
  sessionId: number,
  phase: MeetingPhase,
  values: { discussionStartedAt?: number | null; votingStartedAt?: number | null } = {}
): Promise<void> {
  const db = await getDb();
  await db.run(
    `UPDATE sessions
     SET meeting_phase = ?,
         discussion_started_at = CASE WHEN ? THEN ? ELSE discussion_started_at END,
         voting_started_at = CASE WHEN ? THEN ? ELSE voting_started_at END
     WHERE id = ?`,
    phase,
    Object.prototype.hasOwnProperty.call(values, "discussionStartedAt") ? 1 : 0,
    values.discussionStartedAt ?? null,
    Object.prototype.hasOwnProperty.call(values, "votingStartedAt") ? 1 : 0,
    values.votingStartedAt ?? null,
    sessionId
  );
}

export async function setSessionStatus(sessionId: number, status: SessionStatus): Promise<void> {
  const db = await getDb();
  await db.run(
    `UPDATE sessions
     SET status = ?,
         ended_at = CASE WHEN ? = 'ended' THEN CURRENT_TIMESTAMP ELSE ended_at END,
         meeting_phase = CASE WHEN ? IN ('playing', 'ended', 'cancelled') THEN 'none' ELSE meeting_phase END,
         discussion_started_at = CASE WHEN ? IN ('playing', 'ended', 'cancelled') THEN NULL ELSE discussion_started_at END,
         voting_started_at = CASE WHEN ? IN ('playing', 'ended', 'cancelled') THEN NULL ELSE voting_started_at END
     WHERE id = ?`,
    status,
    status,
    status,
    status,
    status,
    sessionId
  );
}

export async function addPlayer(
  sessionId: number,
  userId: string,
  username: string,
  options: { discordUserId?: string | null; isGhost?: boolean } = {}
): Promise<void> {
  const db = await getDb();
  await db.run(
    `INSERT OR IGNORE INTO players (session_id, user_id, discord_user_id, is_ghost, username)
     VALUES (?, ?, ?, ?, ?)`,
    sessionId,
    userId,
    options.discordUserId ?? userId,
    options.isGhost ? 1 : 0,
    username
  );
}

export async function getPlayers(sessionId: number): Promise<Player[]> {
  const db = await getDb();
  const rows = await db.all("SELECT * FROM players WHERE session_id = ? ORDER BY joined_at ASC", sessionId);
  return rows.map(mapPlayer);
}

export async function getPlayer(sessionId: number, userId: string): Promise<Player | null> {
  const db = await getDb();
  const row = await db.get("SELECT * FROM players WHERE session_id = ? AND user_id = ?", sessionId, userId);
  return row ? mapPlayer(row) : null;
}

export async function setPlayerRole(sessionId: number, userId: string, role: PlayerRole): Promise<void> {
  const db = await getDb();
  await db.run("UPDATE players SET role = ? WHERE session_id = ? AND user_id = ?", role, sessionId, userId);
}

export async function setPlayerChannel(sessionId: number, userId: string, channelId: string): Promise<void> {
  const db = await getDb();
  await db.run("UPDATE players SET channel_id = ? WHERE session_id = ? AND user_id = ?", channelId, sessionId, userId);
}

export async function setPlayerState(sessionId: number, userId: string, state: PlayerState): Promise<void> {
  const db = await getDb();
  await db.run(
    "UPDATE players SET state = ?, death_reported = CASE WHEN ? = 'dead' THEN 0 ELSE death_reported END WHERE session_id = ? AND user_id = ?",
    state,
    state,
    sessionId,
    userId
  );
}

export async function getUnreportedDeadPlayers(sessionId: number): Promise<Player[]> {
  const db = await getDb();
  const rows = await db.all(
    "SELECT * FROM players WHERE session_id = ? AND state = 'dead' AND death_reported = 0 ORDER BY id ASC",
    sessionId
  );
  return rows.map(mapPlayer);
}

export async function markDeathsReported(sessionId: number, userIds: string[]): Promise<void> {
  if (userIds.length === 0) {
    return;
  }
  const db = await getDb();
  const placeholders = userIds.map(() => "?").join(",");
  await db.run(
    `UPDATE players SET death_reported = 1 WHERE session_id = ? AND user_id IN (${placeholders})`,
    sessionId,
    ...userIds
  );
}

export async function incrementFalseReportWarning(guildId: string, userId: string): Promise<number> {
  const db = await getDb();
  await db.run(
    `INSERT INTO false_report_warnings (guild_id, user_id, warnings)
     VALUES (?, ?, 1)
     ON CONFLICT(guild_id, user_id)
     DO UPDATE SET warnings = warnings + 1, updated_at = CURRENT_TIMESTAMP`,
    guildId,
    userId
  );
  const row = await db.get("SELECT warnings FROM false_report_warnings WHERE guild_id = ? AND user_id = ?", guildId, userId);
  return row?.warnings ?? 0;
}

export async function getFalseReportWarning(guildId: string, userId: string): Promise<number> {
  const db = await getDb();
  const row = await db.get("SELECT warnings FROM false_report_warnings WHERE guild_id = ? AND user_id = ?", guildId, userId);
  return row?.warnings ?? 0;
}

export async function clearFalseReportWarnings(guildId: string, userId: string): Promise<void> {
  const db = await getDb();
  await db.run(
    `INSERT INTO false_report_warnings (guild_id, user_id, warnings)
     VALUES (?, ?, 0)
     ON CONFLICT(guild_id, user_id)
     DO UPDATE SET warnings = 0, updated_at = CURRENT_TIMESTAMP`,
    guildId,
    userId
  );
}

export async function getFalseReportWarningsForGuild(guildId: string): Promise<Map<string, number>> {
  const db = await getDb();
  const rows = await db.all("SELECT user_id, warnings FROM false_report_warnings WHERE guild_id = ? AND warnings > 0", guildId);
  return new Map(rows.map((row: any) => [row.user_id, row.warnings]));
}

export async function addTask(sessionId: number, userId: string, task: CatalogTask): Promise<void> {
  const db = await getDb();
  const result = await db.run(
    "INSERT INTO player_tasks (session_id, user_id, task_type, task_id, title, description, location) VALUES (?, ?, ?, ?, ?, ?, ?)",
    sessionId,
    userId,
    task.category,
    task.id,
    task.title,
    task.description,
    task.location ?? null
  );
  const assignedTaskId = result.lastID as number;
  for (const step of task.steps ?? []) {
    await db.run(
      "INSERT INTO player_task_steps (assigned_task_id, step_id, title, description) VALUES (?, ?, ?, ?)",
      assignedTaskId,
      step.id,
      step.title,
      step.description ?? null
    );
  }
}

export async function getTasks(sessionId: number, userId?: string): Promise<PlayerTask[]> {
  const db = await getDb();
  const rows = userId
    ? await db.all("SELECT * FROM player_tasks WHERE session_id = ? AND user_id = ? ORDER BY id ASC", sessionId, userId)
    : await db.all("SELECT * FROM player_tasks WHERE session_id = ? ORDER BY id ASC", sessionId);
  return attachTaskSteps(rows.map(mapTask));
}

export async function getTaskById(taskId: number): Promise<PlayerTask | null> {
  const db = await getDb();
  const row = await db.get("SELECT * FROM player_tasks WHERE id = ?", taskId);
  if (!row) {
    return null;
  }
  const [task] = await attachTaskSteps([mapTask(row)]);
  return task;
}

export async function markTaskDone(taskId: number, userId: string): Promise<PlayerTask | null> {
  const db = await getDb();
  await db.run("UPDATE player_tasks SET completed = 1, completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP) WHERE id = ? AND user_id = ?", taskId, userId);
  const row = await db.get("SELECT * FROM player_tasks WHERE id = ?", taskId);
  if (!row) {
    return null;
  }
  const [task] = await attachTaskSteps([mapTask(row)]);
  return task;
}

export async function getTaskStepById(stepRowId: number): Promise<PlayerTaskStep | null> {
  const db = await getDb();
  const row = await db.get("SELECT * FROM player_task_steps WHERE id = ?", stepRowId);
  return row ? mapTaskStep(row) : null;
}

export async function markTaskStepDone(assignedTaskId: number, stepRowId: number): Promise<PlayerTaskStep | null> {
  const db = await getDb();
  await db.run(
    "UPDATE player_task_steps SET completed = 1, completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP) WHERE id = ? AND assigned_task_id = ?",
    stepRowId,
    assignedTaskId
  );
  const row = await db.get("SELECT * FROM player_task_steps WHERE id = ? AND assigned_task_id = ?", stepRowId, assignedTaskId);
  return row ? mapTaskStep(row) : null;
}

export async function markTaskDoneIfAllStepsDone(taskId: number): Promise<PlayerTask | null> {
  const db = await getDb();
  const openStep = await db.get("SELECT id FROM player_task_steps WHERE assigned_task_id = ? AND completed = 0 LIMIT 1", taskId);
  if (!openStep) {
    await db.run("UPDATE player_tasks SET completed = 1, completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP) WHERE id = ?", taskId);
  }
  return getTaskById(taskId);
}

async function attachTaskSteps(tasks: PlayerTask[]): Promise<PlayerTask[]> {
  if (tasks.length === 0) {
    return tasks;
  }
  const db = await getDb();
  const placeholders = tasks.map(() => "?").join(",");
  const rows = await db.all(`SELECT * FROM player_task_steps WHERE assigned_task_id IN (${placeholders}) ORDER BY id ASC`, ...tasks.map((task) => task.id));
  const stepsByTask = new Map<number, PlayerTaskStep[]>();
  for (const row of rows) {
    const step = mapTaskStep(row);
    const steps = stepsByTask.get(step.assignedTaskId) ?? [];
    steps.push(step);
    stepsByTask.set(step.assignedTaskId, steps);
  }
  return tasks.map((task) => ({ ...task, steps: stepsByTask.get(task.id) ?? [] }));
}

export async function addReport(sessionId: number, reporterId: string, location: string, victimId: string | null = null): Promise<void> {
  const db = await getDb();
  await db.run("INSERT INTO reports (session_id, reporter_id, victim_id, location) VALUES (?, ?, ?, ?)", sessionId, reporterId, victimId, location);
}

export async function getReports(sessionId: number): Promise<Array<{ reporterId: string; victimId: string | null; location: string; createdAt: string }>> {
  const db = await getDb();
  const rows = await db.all("SELECT reporter_id, victim_id, location, created_at FROM reports WHERE session_id = ? ORDER BY id ASC", sessionId);
  return rows.map((row: any) => ({ reporterId: row.reporter_id, victimId: row.victim_id, location: row.location, createdAt: row.created_at }));
}

export async function isBodyReported(sessionId: number, victimId: string): Promise<boolean> {
  const db = await getDb();
  const row = await db.get("SELECT id FROM reports WHERE session_id = ? AND victim_id = ? LIMIT 1", sessionId, victimId);
  return Boolean(row);
}

export async function addKill(sessionId: number, killerId: string, victimId: string): Promise<void> {
  const db = await getDb();
  await db.run("INSERT INTO kills (session_id, killer_id, victim_id) VALUES (?, ?, ?)", sessionId, killerId, victimId);
}

export async function getKills(sessionId: number): Promise<Array<{ killerId: string; victimId: string; createdAt: string }>> {
  const db = await getDb();
  const rows = await db.all("SELECT killer_id, victim_id, created_at FROM kills WHERE session_id = ? ORDER BY id ASC", sessionId);
  return rows.map((row: any) => ({ killerId: row.killer_id, victimId: row.victim_id, createdAt: row.created_at }));
}

export async function getKillCooldown(sessionId: number, impostorId: string): Promise<number> {
  const db = await getDb();
  const row = await db.get("SELECT next_kill_at FROM kill_cooldowns WHERE session_id = ? AND impostor_id = ?", sessionId, impostorId);
  return row?.next_kill_at ?? 0;
}

export async function setKillCooldown(sessionId: number, impostorId: string, nextKillAt: number): Promise<void> {
  const db = await getDb();
  await db.run(
    "INSERT INTO kill_cooldowns (session_id, impostor_id, next_kill_at) VALUES (?, ?, ?) ON CONFLICT(session_id, impostor_id) DO UPDATE SET next_kill_at = excluded.next_kill_at",
    sessionId,
    impostorId,
    nextKillAt
  );
}

export async function clearVotes(sessionId: number): Promise<void> {
  const db = await getDb();
  await db.run("DELETE FROM votes WHERE session_id = ?", sessionId);
}

export async function setVote(sessionId: number, voterId: string, targetUserId: string): Promise<void> {
  const db = await getDb();
  await db.run(
    "INSERT INTO votes (session_id, voter_id, target_user_id) VALUES (?, ?, ?) ON CONFLICT(session_id, voter_id) DO UPDATE SET target_user_id = excluded.target_user_id",
    sessionId,
    voterId,
    targetUserId
  );
}

export async function getVotes(sessionId: number): Promise<Vote[]> {
  const db = await getDb();
  const rows = await db.all("SELECT * FROM votes WHERE session_id = ?", sessionId);
  return rows.map((row: any) => ({ sessionId: row.session_id, voterId: row.voter_id, targetUserId: row.target_user_id }));
}
