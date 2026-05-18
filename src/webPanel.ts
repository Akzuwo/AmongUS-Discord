import express, { Request, Response } from "express";
import { Client, Guild } from "discord.js";
import { config } from "./config";
import { getLatestActiveSession, getSessionByScope } from "./db/repository";
import { GameType } from "./models/session";
import {
  approveAndPostCrazyPostReview,
  bulkRejectCrazyPostReviewsFromAdmin,
  getCrazyPostPendingReviewSummary,
  getCrazyPostReviewDetailForAdmin,
  listCrazyPostReviewsForAdmin,
  rejectCrazyPostReviewFromAdmin,
  saveCrazyPostReviewEdit
} from "./services/crazyPostService";
import {
  endSessionFromAdmin,
  evaluateVoting,
  getAdminPanelOverview,
  getAdminSessionStatus,
  getPublicWebPanelStatus,
  kickPlayerFromAdmin,
  startEmergencyMeetingFromWeb,
  startMeetingDiscussion,
  startMeetingVoting
} from "./services/gameService";
import { allowedGuildIds, ensureGuildAllowed, isGuildAllowed } from "./services/guildAccessService";
import { logger } from "./utils/logger";

const panelLogger = logger.scoped("WebPanel");

export function startWebPanel(client: Client): void {
  if (!config.webPanelEnabled) {
    return;
  }

  const publicApp = express();
  publicApp.use(express.json());
  publicApp.use((request, _response, next) => {
    panelLogger.debug("Public request.", { method: request.method, path: request.path });
    next();
  });

  publicApp.get("/", (_request, response) => response.type("html").send(publicPanelHtml()));
  publicApp.get("/panel", (_request, response) => response.type("html").send(publicPanelHtml()));
  publicApp.get("/panel/:guildId/:sessionId", (_request, response) => response.type("html").send(publicPanelHtml()));
  publicApp.get("/guild/:guildId/panel", (_request, response) => response.type("html").send(publicPanelHtml()));

  publicApp.get(["/api/session/status", "/guild/:guildId/api/session/status", "/api/session/:guildId/:sessionId/status"], async (request, response) => {
    await respond(response, async () => {
      const context = await resolvePublicSessionContext(request);
      return getPublicWebPanelStatus(context.guildId, context.sessionId);
    });
  });

  publicApp.post(["/api/emergency/start", "/guild/:guildId/api/emergency/start", "/api/session/:guildId/:sessionId/emergency/start"], async (request, response) => {
    await respond(response, async () => {
      const context = await resolvePublicSessionContext(request);
      const guild = await fetchAllowedGuild(client, context.guildId);
      await startEmergencyMeetingFromWeb(guild, context.sessionId);
      return { ok: true };
    });
  });

  publicApp.post(["/api/meeting/start-discussion", "/guild/:guildId/api/meeting/start-discussion", "/api/session/:guildId/:sessionId/meeting/start-discussion"], async (request, response) => {
    await respond(response, async () => {
      const context = await resolvePublicSessionContext(request);
      const guild = await fetchAllowedGuild(client, context.guildId);
      await startMeetingDiscussion(guild, context.sessionId);
      return { ok: true };
    });
  });

  publicApp.post(["/api/meeting/start-voting", "/guild/:guildId/api/meeting/start-voting", "/api/session/:guildId/:sessionId/meeting/start-voting"], async (request, response) => {
    await respond(response, async () => {
      const context = await resolvePublicSessionContext(request);
      const guild = await fetchAllowedGuild(client, context.guildId);
      await startMeetingVoting(guild, context.sessionId);
      return { ok: true };
    });
  });

  publicApp.listen(config.webPanelPort, "127.0.0.1", () => {
    panelLogger.info(`Webpanel laeuft auf http://localhost:${config.webPanelPort}`);
  });

  if (!config.adminPanelEnabled) {
    return;
  }

  const adminApp = express();
  adminApp.use(express.json());
  adminApp.use((request, _response, next) => {
    panelLogger.debug("Admin request.", { method: request.method, path: request.path });
    next();
  });

  adminApp.get("/", (_request, response) => response.type("html").send(adminPanelHtml()));
  adminApp.get("/admin", (_request, response) => response.type("html").send(adminPanelHtml()));
  adminApp.get("/admin/guild/:guildId", (_request, response) => response.type("html").send(adminPanelHtml()));
  adminApp.get("/admin/session/:guildId/:gameType/:sessionId", (_request, response) => response.type("html").send(adminPanelHtml()));
  adminApp.get("/admin/reviews/crazy-post", (_request, response) => response.type("html").send(adminPanelHtml()));
  adminApp.get("/admin/reviews/crazy-post/:reviewId", (_request, response) => response.type("html").send(adminPanelHtml()));

  adminApp.get("/api/admin/overview", async (_request, response) => {
    await respond(response, async () => getAdminPanelOverview(allowedGuildIds(), async (guildId) => {
      const guild = await client.guilds.fetch(guildId).catch(() => null);
      return guild?.name ?? null;
    }));
  });

  adminApp.get("/api/admin/session/:guildId/:gameType/:sessionId/status", async (request, response) => {
    await respond(response, async () => {
      const scope = resolveAdminSessionScope(request);
      return getAdminSessionStatus(scope.guildId, scope.gameType, scope.sessionId);
    });
  });

  adminApp.get("/api/admin/reviews/crazy-post/pending-count", async (_request, response) => {
    await respond(response, async () => ({ ok: true, ...(await getCrazyPostPendingReviewSummary(allowedGuildIds())) }));
  });

  adminApp.get("/api/admin/reviews/crazy-post", async (request, response) => {
    await respond(response, async () => {
      const status = String(request.query.status || "pending_review") as "pending_review" | "approved" | "rejected" | "posted" | "all";
      return listCrazyPostReviewsForAdmin(allowedGuildIds(), status);
    });
  });

  adminApp.get("/api/admin/reviews/crazy-post/:reviewId", async (request, response) => {
    await respond(response, async () => {
      const detail = await getCrazyPostReviewDetailForAdmin(String(request.params.reviewId || "")) as { review?: { guildId: string } };
      ensureGuildAllowed(String(detail.review?.guildId || ""));
      return detail;
    });
  });

  adminApp.patch("/api/admin/reviews/crazy-post/:reviewId", async (request, response) => {
    await respond(response, async () => {
      const detail = await getCrazyPostReviewDetailForAdmin(String(request.params.reviewId || "")) as { review?: { guildId: string } };
      ensureGuildAllowed(String(detail.review?.guildId || ""));
      return saveCrazyPostReviewEdit(String(request.params.reviewId || ""), request.body?.editedText ?? null);
    });
  });

  adminApp.post("/api/admin/reviews/crazy-post/:reviewId/approve-and-post", async (request, response) => {
    await respond(response, async () => {
      const detail = await getCrazyPostReviewDetailForAdmin(String(request.params.reviewId || "")) as { review?: { guildId: string } };
      const guild = await fetchAllowedGuild(client, String(detail.review?.guildId || ""));
      return approveAndPostCrazyPostReview(guild, String(request.params.reviewId || ""));
    });
  });

  adminApp.post("/api/admin/reviews/crazy-post/:reviewId/reject", async (request, response) => {
    await respond(response, async () => {
      const detail = await getCrazyPostReviewDetailForAdmin(String(request.params.reviewId || "")) as { review?: { guildId: string } };
      ensureGuildAllowed(String(detail.review?.guildId || ""));
      return rejectCrazyPostReviewFromAdmin(String(request.params.reviewId || ""));
    });
  });

  adminApp.post("/api/admin/reviews/crazy-post/bulk-reject", async (request, response) => {
    await respond(response, async () => bulkRejectCrazyPostReviewsFromAdmin(Array.isArray(request.body?.reviewIds) ? request.body.reviewIds.map(String) : [], allowedGuildIds()));
  });

  adminApp.post("/api/admin/session/:guildId/:gameType/:sessionId/meeting/start-discussion", async (request, response) => {
    await respond(response, async () => {
      const scope = resolveAdminSessionScope(request);
      await ensureSessionScope(scope);
      await startMeetingDiscussion(await fetchAllowedGuild(client, scope.guildId), scope.sessionId);
      return { ok: true };
    });
  });

  adminApp.post("/api/admin/session/:guildId/:gameType/:sessionId/meeting/start-voting", async (request, response) => {
    await respond(response, async () => {
      const scope = resolveAdminSessionScope(request);
      await ensureSessionScope(scope);
      await startMeetingVoting(await fetchAllowedGuild(client, scope.guildId), scope.sessionId);
      return { ok: true };
    });
  });

  adminApp.post("/api/admin/session/:guildId/:gameType/:sessionId/meeting/evaluate-voting", async (request, response) => {
    await respond(response, async () => {
      const scope = resolveAdminSessionScope(request);
      await ensureSessionScope(scope);
      const message = await evaluateVoting(await fetchAllowedGuild(client, scope.guildId), scope.sessionId);
      return { ok: true, message };
    });
  });

  adminApp.post("/api/admin/session/:guildId/:gameType/:sessionId/player/kick", async (request, response) => {
    await respond(response, async () => {
      const scope = resolveAdminSessionScope(request);
      await ensureSessionScope(scope);
      const playerId = String(request.body?.player_id || "");
      if (!playerId) {
        throw new Error("player_id fehlt.");
      }
      const message = await kickPlayerFromAdmin(await fetchAllowedGuild(client, scope.guildId), scope.sessionId, playerId);
      return { ok: true, message };
    });
  });

  adminApp.post("/api/admin/session/:guildId/:gameType/:sessionId/end", async (request, response) => {
    await respond(response, async () => {
      const scope = resolveAdminSessionScope(request);
      await ensureSessionScope(scope);
      await endSessionFromAdmin(await fetchAllowedGuild(client, scope.guildId), scope.gameType, scope.sessionId);
      return { ok: true, message: `Session ${scope.sessionId} wurde beendet.` };
    });
  });

  adminApp.listen(config.adminPanelPort, "127.0.0.1", () => {
    panelLogger.info(`Adminpanel laeuft auf http://localhost:${config.adminPanelPort}`);
  });
}

async function respond(response: Response, action: () => Promise<object>): Promise<void> {
  try {
    response.json(await action());
  } catch (error) {
    response.status(400).json({ ok: false, error: error instanceof Error ? error.message : "Unbekannter Fehler." });
  }
}

async function resolvePublicSessionContext(request: Request): Promise<{ guildId: string; sessionId: number }> {
  const guildId = resolvePanelGuildId(paramString(request.params.guildId));
  const explicitSessionId = paramString(request.params.sessionId);
  if (explicitSessionId) {
    return { guildId, sessionId: parseSessionId(explicitSessionId) };
  }

  const session = await getLatestActiveSession(guildId);
  if (!session || session.gameType !== "amongus") {
    throw new Error("Bitte eine konkrete AmongUs-Session verwenden, z.B. /panel/<guildId>/<sessionId>.");
  }
  return { guildId, sessionId: session.id };
}

function resolveAdminSessionScope(request: Request): { guildId: string; gameType: GameType; sessionId: number } {
  return {
    guildId: resolvePanelGuildId(paramString(request.params.guildId)),
    gameType: parseGameType(request.params.gameType),
    sessionId: parseSessionId(request.params.sessionId)
  };
}

async function ensureSessionScope(scope: { guildId: string; gameType: GameType; sessionId: number }): Promise<void> {
  const session = await getSessionByScope(scope.guildId, scope.gameType, scope.sessionId);
  if (!session) {
    throw new Error("Session existiert nicht fuer diese guildId/gameType/sessionId-Kombination.");
  }
}

function resolvePanelGuildId(guildId: string | undefined): string {
  if (guildId) {
    return ensureGuildAllowed(guildId);
  }
  const allowed = allowedGuildIds();
  if (allowed.length === 1 || config.singleGuildMode) {
    const selected = allowed[0];
    if (selected && isGuildAllowed(selected)) {
      return selected;
    }
  }
  throw new Error("Bitte eine Guild in der URL verwenden.");
}

function parseGameType(value: string | string[] | undefined): GameType {
  const gameType = paramString(value);
  if (gameType !== "amongus" && gameType !== "crazy_post" && gameType !== "fragwuerdig") {
    throw new Error("Ungueltiger Game-Typ.");
  }
  return gameType;
}

function parseSessionId(value: string | string[] | undefined): number {
  const sessionId = Number(paramString(value));
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    throw new Error("Ungueltige sessionId.");
  }
  return sessionId;
}

function paramString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function fetchAllowedGuild(client: Client, guildId: string): Promise<Guild> {
  ensureGuildAllowed(guildId);
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    throw new Error("Discord-Server wurde nicht gefunden.");
  }
  return guild;
}

function shellHtml(title: string, body: string): string {
  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root { color-scheme: light; --bg: #f5f4ef; --panel: #fffdf8; --text: #1f1b18; --muted: #6a625a; --line: #ddd4ca; --primary: #ba3f22; --secondary: #2f5d50; --danger: #7c2014; --ok: #1d6b3b; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Georgia, "Times New Roman", serif; background: #f8f6f0; color: var(--text); }
    main { max-width: 1100px; margin: 0 auto; padding: 24px 18px 40px; }
    h1, h2, p { margin-top: 0; }
    section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 18px; margin: 14px 0; }
    button { margin: 6px 8px 6px 0; padding: 10px 14px; border: 0; border-radius: 6px; background: var(--primary); color: #fff; cursor: pointer; font-weight: 700; }
    button.secondary { background: var(--secondary); }
    button.danger { background: var(--danger); }
    button:disabled { background: #aaa399; cursor: not-allowed; }
    .muted { color: var(--muted); }
    .error { color: var(--danger); }
    .ok { color: var(--ok); }
    .hidden { display: none; }
    .value { font-weight: 700; font-size: 20px; }
    .stack > * + * { margin-top: 10px; }
    .row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
    .pill { display: inline-block; border: 1px solid var(--line); border-radius: 999px; padding: 6px 10px; font-size: 13px; color: var(--muted); }
    textarea { width: 100%; min-height: 280px; padding: 10px; border: 1px solid var(--line); border-radius: 6px; font: inherit; }
    pre { white-space: pre-wrap; background: #f5efe7; border: 1px solid var(--line); border-radius: 6px; padding: 12px; overflow: auto; }
    .modal-backdrop { position: fixed; inset: 0; background: rgba(31, 27, 24, 0.45); display: flex; align-items: center; justify-content: center; padding: 18px; z-index: 10; }
    .modal { max-width: 520px; background: var(--panel); border-radius: 8px; border: 1px solid var(--line); padding: 20px; box-shadow: 0 20px 60px rgba(0,0,0,0.24); }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 8px; text-align: left; border-bottom: 1px solid #ebe3da; vertical-align: top; }
    @media (max-width: 640px) { h1 { font-size: 28px; } main { padding: 16px 12px 28px; } }
  </style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

function publicPanelHtml(): string {
  return shellHtml("AmongUS Webpanel", `
  <section>
    <h1>AmongUS Webpanel</h1>
    <p class="muted">Session-Panel fuer Emergency Meetings und Meetingphasen.</p>
    <button id="refresh" class="secondary">Aktualisieren</button>
  </section>
  <section><p id="message" class="muted">Status wird geladen...</p></section>
  <section id="taskBox" class="hidden"><h2>Spielstatus</h2><p class="muted">Taskfortschritt</p><p class="value" id="tasks">-</p></section>
  <section id="emergencyBox" class="hidden stack"><h2>Emergency Meeting</h2><p id="emergencyStatus">Status: -</p><button id="startEmergency" class="danger">Emergency Meeting einberufen</button></section>
  <section id="meetingBox" class="hidden stack">
    <h2 id="meetingTitle">Meeting</h2><p id="meetingText">-</p><p id="meetingTime" class="muted">-</p><p id="voteCount" class="hidden">Abgestimmt: <span id="votes">-</span></p>
    <div class="row"><button id="startDiscussion">Diskussion starten</button><button id="startVoting">Voting starten</button></div>
  </section>
  <script>
  let currentStatus = null;
  const publicApi = createPublicApi();
  document.getElementById("refresh").onclick = loadStatus;
  bind("startEmergency", () => post(publicApi("/emergency/start", "/api/emergency/start")));
  bind("startDiscussion", () => post(publicApi("/meeting/start-discussion", "/api/meeting/start-discussion")));
  bind("startVoting", () => post(publicApi("/meeting/start-voting", "/api/meeting/start-voting")));
  function bind(id, fn) { const element = document.getElementById(id); if (element) element.onclick = fn; }
  async function post(url) { const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); const data = await response.json(); show(data.error || data.message || "OK", !data.error); await loadStatus(); }
  async function loadStatus() { const response = await fetch(publicApi("/status", "/api/session/status")); currentStatus = await response.json(); render(currentStatus); }
  function render(data) {
    const hasSession = Boolean(data.session);
    toggle("taskBox", hasSession); toggle("emergencyBox", hasSession && data.active && isRunning(data.session)); toggle("meetingBox", hasSession && data.active && data.session.status === "meeting");
    if (!hasSession) { show(data.message || "Aktuell laeuft keine Session.", true); return; }
    setText("tasks", data.taskProgress.done + "/" + data.taskProgress.total + " (" + data.taskProgress.percent + "%)");
    if (!data.active) { show("Session beendet.", true); return; }
    if (isRunning(data.session)) { setText("emergencyStatus", data.emergency.cooldownReady ? "Status: bereit" : "Cooldown: " + formatDuration(data.emergency.cooldownRemainingSeconds)); show("Session laeuft.", true); return; }
    if (data.session.status === "meeting") renderMeeting(data);
  }
  function renderMeeting(data) {
    const phase = data.session.meetingPhase; visible("voteCount", phase === "voting"); visible("startDiscussion", phase === "called"); visible("startVoting", phase === "discussion");
    if (phase === "called") { setText("meetingTitle", "Meeting wurde ausgeloest."); setText("meetingText", "Bitte versammelt euch."); setText("meetingTime", ""); show("Meeting wurde ausgeloest.", true); return; }
    if (phase === "discussion") { setText("meetingTitle", "Diskussion laeuft"); setText("meetingText", "Verbleibende Diskussionszeit"); setText("meetingTime", remaining(data.session.discussionStartedAt, data.session.discussionTimeMinutes)); show("Diskussion laeuft", true); return; }
    if (phase === "voting") { setText("meetingTitle", "Voting laeuft"); setText("meetingText", "Verbleibende Votingzeit"); setText("meetingTime", remaining(data.session.votingStartedAt, data.session.votingTimeMinutes)); setText("votes", data.voting.votesCast + " / " + data.voting.eligibleVoters); show("Voting laeuft", true); }
  }
  function createPublicApi() {
    const parts = location.pathname.split("/").filter(Boolean);
    if (parts[0] === "panel" && parts.length >= 3) { const base = "/api/session/" + encodeURIComponent(parts[1]) + "/" + encodeURIComponent(parts[2]); return (sessionPath) => base + sessionPath; }
    if (parts[0] === "guild" && parts.length >= 2) { const base = "/guild/" + encodeURIComponent(parts[1]) + "/api"; return (_sessionPath, guildPath) => base + guildPath.replace(/^\\/api/, ""); }
    return (_sessionPath, fallbackPath) => fallbackPath;
  }
  function isRunning(session) { return session.status === "playing" || session.status === "running"; }
  function remaining(startedAt, minutes) { if (!startedAt) return "-"; const left = Math.max(0, Math.round((startedAt + minutes * 60000 - Date.now()) / 1000)); return left === 0 ? "Zeit abgelaufen" : formatDuration(left); }
  function toggle(id, isVisible) { document.getElementById(id).classList.toggle("hidden", !isVisible); }
  function visible(id, isVisible) { document.getElementById(id).classList.toggle("hidden", !isVisible); }
  function setText(id, value) { document.getElementById(id).textContent = value; }
  function show(text, ok) { const element = document.getElementById("message"); element.textContent = text; element.className = ok ? "ok" : "error"; }
  function formatDuration(seconds) { const m = Math.floor(seconds / 60); const s = seconds % 60; return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0"); }
  loadStatus(); setInterval(loadStatus, 2000); setInterval(() => currentStatus && currentStatus.session && render(currentStatus), 1000);
  </script>`);
}

function adminPanelHtml(): string {
  return shellHtml("AmongUS Adminpanel", `
  <section><h1>AmongUS Adminpanel</h1><p class="muted">Globale Uebersicht fuer erlaubte Guilds, Games und aktive Sessions.</p><div class="row"><button id="refresh">Aktualisieren</button><button id="openReviews" class="secondary">Verrueckte-Post-Reviews</button><span class="pill" id="guildCount">Guilds: -</span><span class="pill" id="sessionCount">Aktive Sessions: -</span><span class="pill" id="reviewCount">Reviews: -</span></div></section>
  <section><p id="message" class="muted">Status wird geladen...</p></section>
  <section id="reviewListBox" class="hidden"><h2>Verrueckte-Post Reviews</h2><div class="row"><button id="reviewBack" class="secondary">Zur Uebersicht</button><button id="refreshReviews">Reviews aktualisieren</button></div><div id="reviewDetail"></div><table id="reviewTable"><thead><tr><th>Review</th><th>Guild / Session</th><th>Status</th><th>Vorschau</th><th>Erstellt</th><th>Aktionen</th></tr></thead><tbody id="reviewRows"></tbody></table></section>
  <section id="sessionsBox"><h2>Aktive Sessions</h2><table><thead><tr><th>Guild</th><th>Game</th><th>Session</th><th>Status</th><th>Spieler</th><th>Laufzeit</th><th>Channels</th><th>Aktionen</th></tr></thead><tbody id="sessionRows"></tbody></table></section>
  <section id="detailBox" class="hidden"><h2 id="detailTitle">Sessiondetails</h2><div class="row" id="detailSummary"></div><div class="row" id="detailActions"></div></section>
  <section id="playersBox" class="hidden"><h2>Spieleruebersicht</h2><table><thead id="playersHead"></thead><tbody id="playerRows"></tbody></table></section>
  <div id="reviewModal" class="modal-backdrop hidden"><div class="modal"><h2>Verrueckte-Post Review</h2><p id="reviewModalText">Es gibt neue Texte, die geprueft werden muessen.</p><div class="row"><button id="modalReviewStart">Review starten</button><button id="modalRejectAll" class="danger">Ablehnen</button><button id="modalLater" class="secondary">Spaeter</button></div></div></div>
  <script>
  let selectedSession = null;
  let pendingReviewIds = [];
  let dismissedReviewIds = [];
  let dismissedUntil = 0;
  document.getElementById("refresh").onclick = loadStatus;
  document.getElementById("openReviews").onclick = () => { history.pushState(null, "", "/admin/reviews/crazy-post"); loadStatus(); };
  document.getElementById("reviewBack").onclick = () => { history.pushState(null, "", "/admin"); loadStatus(); };
  document.getElementById("refreshReviews").onclick = loadReviews;
  document.getElementById("modalReviewStart").onclick = () => { hideReviewModal(); history.pushState(null, "", "/admin/reviews/crazy-post"); loadStatus(); };
  document.getElementById("modalLater").onclick = () => { dismissedUntil = Date.now() + 5 * 60 * 1000; dismissedReviewIds = pendingReviewIds.slice(); hideReviewModal(); };
  document.getElementById("modalRejectAll").onclick = async () => { if (confirm("Willst du wirklich alle " + pendingReviewIds.length + " Texte ablehnen?")) { await post("/api/admin/reviews/crazy-post/bulk-reject", { reviewIds: pendingReviewIds }); hideReviewModal(); } };
  async function post(url, body = {}) { const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const data = await parseResponse(response); show(data.error || data.message || "OK", !data.error); await loadStatus(); }
  async function loadStatus() { await refreshReviewSummary(); const isReview = location.pathname.startsWith("/admin/reviews/crazy-post"); toggle("reviewListBox", isReview); toggle("sessionsBox", !isReview); if (isReview) { await loadReviews(); return; } const response = await fetch("/api/admin/overview"); const data = await parseResponse(response); renderOverview(data); const routeSession = routeSelectedSession(); if (routeSession) await loadSession(routeSession); else if (selectedSession) await loadSession(selectedSession); }
  async function loadSession(session) { selectedSession = session; const response = await fetch(sessionApi(session, "/status")); renderSession(await parseResponse(response)); }
  async function refreshReviewSummary() {
    const response = await fetch("/api/admin/reviews/crazy-post/pending-count");
    const data = await parseResponse(response);
    if (data.error) return;
    pendingReviewIds = data.reviewIds || [];
    setText("reviewCount", "Reviews: " + data.count);
    const hasNew = pendingReviewIds.some(id => !dismissedReviewIds.includes(id));
    if (data.count > 0 && Date.now() > dismissedUntil && (hasNew || dismissedReviewIds.length === 0) && !location.pathname.startsWith("/admin/reviews/crazy-post")) {
      document.getElementById("reviewModalText").textContent = "Es gibt " + data.count + " neue Verrueckte-Post-Texte, die geprueft werden muessen.";
      document.getElementById("reviewModal").classList.remove("hidden");
    }
  }
  function hideReviewModal() { document.getElementById("reviewModal").classList.add("hidden"); }
  async function loadReviews() {
    toggle("detailBox", false); toggle("playersBox", false);
    const routeReviewId = routeSelectedReviewId();
    if (routeReviewId) { await loadReviewDetail(routeReviewId); return; }
    document.getElementById("reviewDetail").innerHTML = "";
    document.getElementById("reviewTable").classList.remove("hidden");
    const response = await fetch("/api/admin/reviews/crazy-post?status=pending_review");
    const data = await parseResponse(response);
    if (data.error) { show(data.error, false); return; }
    document.getElementById("reviewRows").innerHTML = data.reviews.map(review => "<tr><td>" + escapeHtml(review.reviewId) + (review.debugSession ? "<br><span class='muted'>Debug/Ghost</span>" : "") + "</td><td>" + escapeHtml(review.guildId) + "<br>Session " + review.sessionId + "</td><td>" + escapeHtml(review.status) + "</td><td>" + escapeHtml(review.preview) + "</td><td>" + escapeHtml(review.createdAt) + "</td><td><button data-review-open='" + escapeHtml(review.reviewId) + "'>Anzeigen</button><button data-review-post='" + escapeHtml(review.reviewId) + "'" + (review.debugSession ? " disabled" : "") + ">Approven und posten</button><button class='danger' data-review-reject='" + escapeHtml(review.reviewId) + "'>Ablehnen</button></td></tr>").join("");
    document.querySelectorAll("button[data-review-open]").forEach(button => { button.onclick = () => { history.pushState(null, "", "/admin/reviews/crazy-post/" + encodeURIComponent(button.getAttribute("data-review-open"))); loadStatus(); }; });
    document.querySelectorAll("button[data-review-post]").forEach(button => { button.onclick = () => post("/api/admin/reviews/crazy-post/" + encodeURIComponent(button.getAttribute("data-review-post")) + "/approve-and-post"); });
    document.querySelectorAll("button[data-review-reject]").forEach(button => { button.onclick = () => post("/api/admin/reviews/crazy-post/" + encodeURIComponent(button.getAttribute("data-review-reject")) + "/reject"); });
    show("Review-Liste bereit.", true);
  }
  async function loadReviewDetail(reviewId) {
    document.getElementById("reviewTable").classList.add("hidden");
    const response = await fetch("/api/admin/reviews/crazy-post/" + encodeURIComponent(reviewId));
    const data = await parseResponse(response);
    if (data.error) { show(data.error, false); return; }
    const review = data.review;
    document.getElementById("reviewDetail").innerHTML = "<div class='stack'><p class='muted'>Review " + escapeHtml(review.reviewId) + " | Guild " + escapeHtml(review.guildId) + " | Session " + review.sessionId + " | Status " + escapeHtml(review.status) + "</p><h3>Text bearbeiten</h3><textarea id='reviewEdit'>" + escapeHtml(review.editedText || review.originalText) + "</textarea><div class='row'><button id='reviewSave'>Speichern</button><button id='reviewPost'" + (review.debugSession ? " disabled" : "") + ">Approven und posten</button><button id='reviewReject' class='danger'>Ablehnen</button><button id='reviewBackList' class='secondary'>Zurueck</button></div><h3>Original</h3><pre>" + escapeHtml(review.originalText) + "</pre><h3>Saetze</h3><pre>" + escapeHtml(review.contributions.map((item, index) => (index + 1) + ". " + item.authorId + ": " + item.content).join("\\n")) + "</pre></div>";
    document.getElementById("reviewSave").onclick = () => patchReview(review.reviewId, document.getElementById("reviewEdit").value);
    document.getElementById("reviewPost").onclick = () => post("/api/admin/reviews/crazy-post/" + encodeURIComponent(review.reviewId) + "/approve-and-post");
    document.getElementById("reviewReject").onclick = () => post("/api/admin/reviews/crazy-post/" + encodeURIComponent(review.reviewId) + "/reject");
    document.getElementById("reviewBackList").onclick = () => { history.pushState(null, "", "/admin/reviews/crazy-post"); loadStatus(); };
  }
  async function patchReview(reviewId, editedText) { const response = await fetch("/api/admin/reviews/crazy-post/" + encodeURIComponent(reviewId), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ editedText }) }); const data = await parseResponse(response); show(data.error || data.message || "OK", !data.error); }
  function renderOverview(data) {
    if (data.error) { show(data.error, false); return; }
    setText("guildCount", "Guilds: " + data.guilds.length); setText("sessionCount", "Aktive Sessions: " + data.sessions.length);
    document.getElementById("sessionRows").innerHTML = data.sessions.map(session => "<tr><td>" + escapeHtml(session.guildName || session.guildId) + "<br><span class='muted'>" + escapeHtml(session.guildId) + "</span></td><td>" + gameLabel(session.gameType) + (session.isDebugSession ? "<br><span class='muted'>Debug</span>" : "") + "</td><td>" + session.sessionId + "</td><td>" + escapeHtml(session.status) + "<br><span class='muted'>" + escapeHtml(session.meetingPhase || "-") + "</span></td><td>" + session.playerCount + " (" + session.activePlayers + " aktiv, " + session.ghostCount + " Ghosts)</td><td>" + formatDuration(session.runtimeSeconds) + "<br><span class='muted'>" + escapeHtml(session.createdAt) + "</span></td><td>" + channelList(session.channels) + "</td><td><button data-session='" + sessionKey(session) + "'>Details</button> <button class='danger' data-end='" + sessionKey(session) + "'>Beenden</button></td></tr>").join("");
    document.querySelectorAll("button[data-session]").forEach(button => { button.onclick = () => loadSession(sessionFromKey(button.getAttribute("data-session"))); });
    document.querySelectorAll("button[data-end]").forEach(button => { button.onclick = () => post(sessionApi(sessionFromKey(button.getAttribute("data-end")), "/end")); });
    show("Adminpanel bereit.", true);
  }
  function renderSession(data) {
    if (data.error) { show(data.error, false); return; }
    const hasSession = Boolean(data.session); toggle("detailBox", hasSession); toggle("playersBox", hasSession); if (!hasSession) return;
    if (data.gameType === "amongus") renderAmongUsSessionDetails(data);
    else if (data.gameType === "crazy_post") renderCrazyPostSessionDetails(data);
    else if (data.gameType === "fragwuerdig") renderFragwuerdigSessionDetails(data);
    else renderFallbackSessionDetails(data);
    document.querySelectorAll("button[data-player]").forEach(button => { button.onclick = () => post(sessionApi(selectedSession, "/player/kick"), { player_id: button.getAttribute("data-player") }); });
  }
  function renderAmongUsSessionDetails(data) {
    setText("detailTitle", "AmongUs Sessiondetails");
    document.getElementById("detailSummary").innerHTML = [
      pill("Session: " + data.guildId + " / " + data.sessionId),
      pill("Status: " + data.status),
      pill("Phase: " + (data.summary.phase || "-")),
      pill("Spieler: " + data.players.total + " (" + data.summary.aliveCount + " alive, " + data.summary.deadCount + " dead, " + data.summary.removedCount + " removed)"),
      pill("Debug: " + (data.debug ? "aktiv" : "inaktiv")),
      pill("Votes: " + data.summary.votesCurrent + "/" + data.summary.votesRequired),
      pill("Emergency Cooldown: " + formatDuration(data.summary.emergencyCooldown || 0))
    ].join("");
    document.getElementById("detailActions").innerHTML = "<button data-admin-action='discussion'>Diskussion starten</button><button data-admin-action='voting'>Voting starten</button><button class='secondary' data-admin-action='evaluate'>Voting auswerten</button><button class='danger' data-admin-action='end'>Session beenden</button>";
    bindAdminActions();
    setPlayerTable(["Name", "Rolle", "Status", "Tasks", "Aktion"], data.players.list.map(player => "<tr><td>" + playerName(player) + "</td><td>" + escapeHtml(player.role || "-") + "</td><td>" + escapeHtml(player.state) + "</td><td>" + player.tasks.done + "/" + player.tasks.total + "</td><td>" + kickButton(player, data.active) + "</td></tr>"));
  }
  function renderCrazyPostSessionDetails(data) {
    setText("detailTitle", "Verrueckte Post Sessiondetails");
    document.getElementById("detailSummary").innerHTML = [
      pill("Session: " + data.guildId + " / " + data.sessionId),
      pill("Status: " + data.status),
      pill("Phase: " + (data.summary.phase || "-")),
      pill("Spieler: " + data.players.total),
      pill("Debug: " + (data.debug ? "aktiv" : "inaktiv")),
      pill("Geschichten: " + data.summary.finishedStories + "/" + data.summary.totalStories + " fertig"),
      pill("Aktive Geschichten: " + data.summary.activeStories),
      pill("Ausstehende Einsendungen: " + data.summary.totalPendingSubmissions),
      pill("Queued Saetze: " + data.summary.totalQueuedSentences),
      pill("Textsammlung: " + (data.summary.textCollectionChannelId || "-")),
      pill("Admin-Log: " + (data.summary.adminLogChannelId || "-"))
    ].join("");
    document.getElementById("detailActions").innerHTML = "<button class='danger' data-admin-action='end'>Session beenden</button>";
    bindAdminActions();
    setPlayerTable(["Name", "Status", "Offene Antwort", "Queue", "Abgegebene Saetze", "Letzte Einsendung", "Aktion"], data.players.list.map(player => "<tr><td>" + playerName(player) + "</td><td>" + escapeHtml(player.state) + "</td><td>" + yesNo(player.hasOpenAnswer) + (player.activeTextId ? " #" + player.activeTextId : "") + "</td><td>" + player.queuedSentenceCount + "</td><td>" + player.submittedSentenceCount + "</td><td>" + escapeHtml(player.lastSubmissionAt || "-") + "</td><td>" + kickButton(player, data.active) + "</td></tr>"));
  }
  function renderFragwuerdigSessionDetails(data) {
    setText("detailTitle", "Fragwuerdig Sessiondetails");
    document.getElementById("detailSummary").innerHTML = [
      pill("Session: " + data.guildId + " / " + data.sessionId),
      pill("Status: " + data.status),
      pill("Phase: " + (data.summary.phase || "-")),
      pill("Spieler: " + data.summary.playerCount),
      pill("Debug: " + (data.debug ? "aktiv" : "inaktiv")),
      pill("Antworten: " + data.summary.answersSubmitted),
      pill("Warteschlange: " + data.summary.waitingQueueCount),
      pill("Impostor: " + data.summary.impostorCount),
      pill("Voting: " + (data.summary.votingActive ? "aktiv" : "inaktiv"))
    ].join("");
    document.getElementById("detailActions").innerHTML = "<button class='danger' data-admin-action='end'>Session beenden</button>";
    bindAdminActions();
    setPlayerTable(["Name", "Status", "Antwort abgegeben", "Warteschlange", "Impostor", "Aktion"], data.players.list.map(player => "<tr><td>" + playerName(player) + "</td><td>" + escapeHtml(player.state) + "</td><td>" + yesNo(player.answered) + "</td><td>" + escapeHtml(player.queueState || "-") + "</td><td>" + yesNo(player.isImpostor) + "</td><td>" + kickButton(player, data.active) + "</td></tr>"));
  }
  function renderFallbackSessionDetails(data) {
    setText("detailTitle", "Sessiondetails");
    document.getElementById("detailSummary").innerHTML = "<p class='error'>" + escapeHtml(data.warning || "Fuer diesen Spieltyp gibt es noch keine spezifische Adminansicht.") + "</p>" + [
      pill("Session: " + data.guildId + " / " + data.sessionId),
      pill("Game: " + escapeHtml(data.gameType)),
      pill("Status: " + data.status),
      pill("Spieler: " + data.players.total),
      pill("Debug: " + (data.debug ? "aktiv" : "inaktiv"))
    ].join("") + "<pre>" + escapeHtml(JSON.stringify(data.summary || {}, null, 2)) + "</pre>";
    document.getElementById("detailActions").innerHTML = "<button class='danger' data-admin-action='end'>Session beenden</button>";
    bindAdminActions();
    setPlayerTable(["Name", "Status", "Aktion"], data.players.list.map(player => "<tr><td>" + playerName(player) + "</td><td>" + escapeHtml(player.state || "-") + "</td><td>" + kickButton(player, data.active) + "</td></tr>"));
  }
  function bindAdminActions() {
    document.querySelectorAll("button[data-admin-action]").forEach(button => {
      button.onclick = () => {
        const action = button.getAttribute("data-admin-action");
        if (action === "discussion") return post(sessionApi(selectedSession, "/meeting/start-discussion"));
        if (action === "voting") return post(sessionApi(selectedSession, "/meeting/start-voting"));
        if (action === "evaluate") return post(sessionApi(selectedSession, "/meeting/evaluate-voting"));
        if (action === "end") return post(sessionApi(selectedSession, "/end"));
      };
    });
  }
  function setPlayerTable(headers, rows) { document.getElementById("playersHead").innerHTML = "<tr>" + headers.map(header => "<th>" + escapeHtml(header) + "</th>").join("") + "</tr>"; document.getElementById("playerRows").innerHTML = rows.join(""); }
  function pill(value) { return "<span class='pill'>" + escapeHtml(value) + "</span>"; }
  function yesNo(value) { return value ? "ja" : "nein"; }
  function playerName(player) { return escapeHtml(player.username) + (player.isGhost ? " (Ghost)" : ""); }
  function kickButton(player, active) { return "<button class='danger' data-player='" + escapeHtml(player.userId) + "'" + (player.removed || player.state === "removed" || !active ? " disabled" : "") + ">Kicken</button>"; }
  async function parseResponse(response) { const text = await response.text(); try { return JSON.parse(text); } catch { return { error: text || response.statusText }; } }
  function routeSelectedSession() { const parts = location.pathname.split("/").filter(Boolean); return parts[0] === "admin" && parts[1] === "session" && parts.length >= 5 ? { guildId: parts[2], gameType: parts[3], sessionId: Number(parts[4]) } : null; }
  function routeSelectedReviewId() { const parts = location.pathname.split("/").filter(Boolean); return parts[0] === "admin" && parts[1] === "reviews" && parts[2] === "crazy-post" && parts[3] ? parts[3] : null; }
  function sessionKey(session) { return [session.guildId, session.gameType, session.sessionId || session.id].join("|"); }
  function sessionFromKey(key) { const [guildId, gameType, sessionId] = String(key || "").split("|"); return { guildId, gameType, sessionId: Number(sessionId) }; }
  function sessionApi(session, suffix) { return "/api/admin/session/" + encodeURIComponent(session.guildId) + "/" + encodeURIComponent(session.gameType) + "/" + encodeURIComponent(session.sessionId || session.id) + suffix; }
  function channelList(channels) { return Object.entries(channels || {}).filter(([, value]) => value).map(([key, value]) => "<span class='muted'>" + key.replace("ChannelId", "") + ":</span> " + escapeHtml(value)).join("<br>") || "-"; }
  function gameLabel(value) { return value === "amongus" ? "AmongUs" : value === "crazy_post" ? "Verrueckte Post" : value === "fragwuerdig" ? "Fragwuerdig" : value; }
  function toggle(id, isVisible) { document.getElementById(id).classList.toggle("hidden", !isVisible); }
  function setText(id, value) { document.getElementById(id).textContent = value; }
  function show(text, ok) { const element = document.getElementById("message"); element.textContent = text; element.className = ok ? "ok" : "error"; }
  function formatDuration(seconds) { const m = Math.floor(seconds / 60); const s = seconds % 60; return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0"); }
  function escapeHtml(value) { return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char])); }
  loadStatus(); setInterval(loadStatus, 5000);
  </script>`);
}
