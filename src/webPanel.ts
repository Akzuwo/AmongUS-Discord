import express, { Response } from "express";
import { Client, Guild } from "discord.js";
import { config } from "./config";
import { getLatestActiveSession } from "./db/repository";
import {
  endSession,
  evaluateVoting,
  getAdminPanelStatus,
  getPublicWebPanelStatus,
  kickPlayerFromAdmin,
  startEmergencyMeetingFromWeb,
  startMeetingDiscussion,
  startMeetingVoting
} from "./services/gameService";
import { logger } from "./utils/logger";
import { allowedGuildIds, ensureGuildAllowed, isGuildAllowed } from "./services/guildAccessService";

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
  publicApp.get("/guild/:guildId/panel", (_request, response) => response.type("html").send(publicPanelHtml()));

  publicApp.get(["/api/session/status", "/guild/:guildId/api/session/status"], async (request, response) => {
    await respond(response, async () => getPublicWebPanelStatus(resolvePanelGuildId(paramString(request.params.guildId))));
  });

  publicApp.post(["/api/emergency/start", "/guild/:guildId/api/emergency/start"], async (request, response) => {
    await respond(response, async () => {
      const guild = await activeGuild(client, resolvePanelGuildId(paramString(request.params.guildId)));
      await startEmergencyMeetingFromWeb(guild);
      return { ok: true };
    });
  });

  publicApp.post(["/api/meeting/start-discussion", "/guild/:guildId/api/meeting/start-discussion"], async (request, response) => {
    await respond(response, async () => {
      const guild = await activeGuild(client, resolvePanelGuildId(paramString(request.params.guildId)));
      await startMeetingDiscussion(guild);
      return { ok: true };
    });
  });

  publicApp.post(["/api/meeting/start-voting", "/guild/:guildId/api/meeting/start-voting"], async (request, response) => {
    await respond(response, async () => {
      const guild = await activeGuild(client, resolvePanelGuildId(paramString(request.params.guildId)));
      await startMeetingVoting(guild);
      return { ok: true };
    });
  });

  publicApp.post(["/api/meeting/evaluate-voting", "/guild/:guildId/api/meeting/evaluate-voting"], async (request, response) => {
    await respond(response, async () => {
      const guildId = resolvePanelGuildId(paramString(request.params.guildId));
      const session = await getLatestActiveSession(guildId);
      if (!session) {
        throw new Error("Keine aktive Session gefunden.");
      }
      const guild = await activeGuild(client, guildId);
      const message = await evaluateVoting(guild, session.id);
      return { ok: true, message };
    });
  });

  publicApp.listen(config.webPanelPort, "127.0.0.1", () => {
    panelLogger.info(`Webpanel läuft auf http://localhost:${config.webPanelPort}`);
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
  adminApp.get("/panel/admin", (_request, response) => response.type("html").send(adminPanelHtml()));
  adminApp.get("/guild/:guildId/admin", (_request, response) => response.type("html").send(adminPanelHtml()));

  adminApp.get(["/api/admin/status", "/guild/:guildId/api/admin/status"], async (request, response) => {
    await respond(response, async () => getAdminPanelStatus(resolvePanelGuildId(paramString(request.params.guildId))));
  });

  adminApp.post(["/api/admin/meeting/start-discussion", "/guild/:guildId/api/admin/meeting/start-discussion"], async (request, response) => {
    await respond(response, async () => {
      const guild = await activeGuild(client, resolvePanelGuildId(paramString(request.params.guildId)));
      await startMeetingDiscussion(guild);
      return { ok: true };
    });
  });

  adminApp.post(["/api/admin/meeting/start-voting", "/guild/:guildId/api/admin/meeting/start-voting"], async (request, response) => {
    await respond(response, async () => {
      const guild = await activeGuild(client, resolvePanelGuildId(paramString(request.params.guildId)));
      await startMeetingVoting(guild);
      return { ok: true };
    });
  });

  adminApp.post(["/api/admin/meeting/evaluate-voting", "/guild/:guildId/api/admin/meeting/evaluate-voting"], async (request, response) => {
    await respond(response, async () => {
      const guildId = resolvePanelGuildId(paramString(request.params.guildId));
      const session = await getLatestActiveSession(guildId);
      if (!session) {
        throw new Error("Keine aktive Session gefunden.");
      }
      const guild = await activeGuild(client, guildId);
      const message = await evaluateVoting(guild, session.id);
      return { ok: true, message };
    });
  });

  adminApp.post(["/api/admin/player/kick", "/guild/:guildId/api/admin/player/kick"], async (request, response) => {
    await respond(response, async () => {
      const guild = await activeGuild(client, resolvePanelGuildId(paramString(request.params.guildId)));
      const playerId = String(request.body?.player_id || "");
      if (!playerId) {
        throw new Error("player_id fehlt.");
      }
      const message = await kickPlayerFromAdmin(guild, playerId);
      return { ok: true, message };
    });
  });

  adminApp.post(["/api/admin/session/end", "/guild/:guildId/api/admin/session/end"], async (request, response) => {
    await respond(response, async () => {
      const guildId = resolvePanelGuildId(paramString(request.params.guildId));
      const session = await getLatestActiveSession(guildId);
      if (!session) {
        throw new Error("Keine aktive Session gefunden.");
      }
      const guild = await activeGuild(client, guildId);
      await endSession(guild, session.id);
      return { ok: true, message: `Session ${session.id} wurde beendet.` };
    });
  });

  adminApp.listen(config.adminPanelPort, "127.0.0.1", () => {
    panelLogger.info(`Adminpanel läuft auf http://localhost:${config.adminPanelPort}`);
  });
}

async function respond(response: Response, action: () => Promise<object>): Promise<void> {
  try {
    response.json(await action());
  } catch (error) {
    response.status(400).json({ ok: false, error: error instanceof Error ? error.message : "Unbekannter Fehler." });
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
  throw new Error("Bitte eine Guild in der URL verwenden, z.B. /guild/<guildId>/panel.");
}

function paramString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function activeGuild(client: Client, guildId: string): Promise<Guild> {
  const session = await getLatestActiveSession(guildId);
  if (!session) {
    throw new Error("Keine aktive Session gefunden.");
  }
  const guild = await client.guilds.fetch(session.guildId);
  if (!guild) {
    throw new Error("Discord-Server der Session wurde nicht gefunden.");
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
    body { margin: 0; font-family: Georgia, "Times New Roman", serif; background: linear-gradient(180deg, #efe7db 0%, #f8f6f0 45%, #ece7de 100%); color: var(--text); }
    main { max-width: 900px; margin: 0 auto; padding: 24px 18px 40px; }
    h1, h2, h3, p { margin-top: 0; }
    h1 { font-size: 34px; }
    h2 { font-size: 20px; margin-bottom: 10px; }
    section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 18px; margin: 14px 0; box-shadow: 0 10px 30px rgba(60, 40, 20, 0.05); }
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
    <p class="muted">Lokaler Spielpunkt fuer Emergency Meetings und Meetingphasen.</p>
    <button id="refresh" class="secondary">Aktualisieren</button>
  </section>

  <section id="messageBox">
    <p id="message" class="muted">Status wird geladen...</p>
  </section>

  <section id="taskBox" class="hidden">
    <h2>Spielstatus</h2>
    <p class="muted">Taskfortschritt</p>
    <p class="value" id="tasks">-</p>
  </section>

  <section id="emergencyBox" class="hidden stack">
    <h2>Emergency Meeting</h2>
    <p id="emergencyStatus">Status: -</p>
    <button id="startEmergency" class="danger">Emergency Meeting einberufen</button>
  </section>

  <section id="meetingBox" class="hidden stack">
    <h2 id="meetingTitle">Meeting</h2>
    <p id="meetingText">-</p>
    <p id="meetingTime" class="muted">-</p>
    <p id="voteCount" class="hidden">Abgestimmt: <span id="votes">-</span></p>
    <div class="row">
      <button id="startDiscussion">Diskussion starten</button>
      <button id="startVoting">Voting starten</button>
      <button id="evaluateVoting" class="secondary">Voting auswerten</button>
    </div>
  </section>

  <script>
  let currentStatus = null;
  document.getElementById("refresh").onclick = loadStatus;
  const apiBase = location.pathname.startsWith("/guild/") ? location.pathname.split("/").slice(0, 3).join("/") : "";
  bind("startEmergency", () => post(apiBase + "/api/emergency/start"));
  bind("startDiscussion", () => post(apiBase + "/api/meeting/start-discussion"));
  bind("startVoting", () => post(apiBase + "/api/meeting/start-voting"));
  bind("evaluateVoting", () => post(apiBase + "/api/meeting/evaluate-voting"));
  function bind(id, fn) { const element = document.getElementById(id); if (element) element.onclick = fn; }
  async function post(url) {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const data = await response.json();
    show(data.error || data.message || "OK", !data.error);
    await loadStatus();
  }
  async function loadStatus() {
    const response = await fetch(apiBase + "/api/session/status");
    currentStatus = await response.json();
    render(currentStatus);
  }
  function render(data) {
    const hasSession = Boolean(data.session);
    toggle("taskBox", hasSession);
    toggle("emergencyBox", hasSession && data.active && isRunning(data.session));
    toggle("meetingBox", hasSession && data.active && data.session.status === "meeting");
    if (!hasSession) { show(data.message || "Aktuell läuft keine Session.", true); return; }
    setText("tasks", data.taskProgress.done + "/" + data.taskProgress.total + " (" + data.taskProgress.percent + "%)");
    if (!data.active) { show("Session beendet.", true); toggle("emergencyBox", false); toggle("meetingBox", false); return; }
    if (isRunning(data.session)) {
      setText("emergencyStatus", data.emergency.cooldownReady ? "Status: bereit" : "Cooldown: " + formatDuration(data.emergency.cooldownRemainingSeconds));
      setDisabled("startEmergency", false);
      show("Session läuft.", true);
      return;
    }
    if (data.session.status === "meeting") { renderMeeting(data); }
  }
  function renderMeeting(data) {
    const phase = data.session.meetingPhase;
    visible("voteCount", phase === "voting");
    visible("startDiscussion", phase === "called");
    visible("startVoting", phase === "discussion");
    visible("evaluateVoting", phase === "voting");
    if (phase === "called") {
      setText("meetingTitle", "Meeting wurde ausgelöst.");
      setText("meetingText", "Bitte versammelt euch.");
      setText("meetingTime", "");
      show("Meeting wurde ausgelöst. Bitte versammelt euch.", true);
      return;
    }
    if (phase === "discussion") {
      setText("meetingTitle", "Diskussion läuft");
      setText("meetingText", "Verbleibende Diskussionszeit");
      setText("meetingTime", remaining(data.session.discussionStartedAt, data.session.discussionTimeMinutes));
      show("Diskussion läuft", true);
      return;
    }
    if (phase === "voting") {
      setText("meetingTitle", "Voting läuft");
      setText("meetingText", "Verbleibende Votingzeit");
      setText("meetingTime", remaining(data.session.votingStartedAt, data.session.votingTimeMinutes));
      setText("votes", data.voting.votesCast + " / " + data.voting.eligibleVoters);
      show("Voting läuft", true);
      return;
    }
  }
  function isRunning(session) { return session.status === "playing" || session.status === "running"; }
  function remaining(startedAt, minutes) {
    if (!startedAt) return "-";
    const left = Math.max(0, Math.round((startedAt + minutes * 60000 - Date.now()) / 1000));
    return left === 0 ? "Zeit abgelaufen" : formatDuration(left);
  }
  function toggle(id, isVisible) { document.getElementById(id).classList.toggle("hidden", !isVisible); }
  function visible(id, isVisible) { document.getElementById(id).classList.toggle("hidden", !isVisible); }
  function setDisabled(id, disabled) { const element = document.getElementById(id); if (element) element.disabled = disabled; }
  function setText(id, value) { document.getElementById(id).textContent = value; }
  function show(text, ok) { const element = document.getElementById("message"); element.textContent = text; element.className = ok ? "ok" : "error"; }
  function formatDuration(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }
  loadStatus();
  setInterval(loadStatus, 2000);
  setInterval(() => currentStatus && currentStatus.session && render(currentStatus), 1000);
  </script>`);
}

function adminPanelHtml(): string {
  return shellHtml("AmongUS Adminpanel", `
  <section>
    <h1>AmongUS Adminpanel</h1>
    <p class="muted">Optionales Kontrollpanel fuer Admin-, Debug- und Session-Aktionen.</p>
    <button id="refresh">Status aktualisieren</button>
  </section>

  <section>
    <p id="message" class="muted">Status wird geladen...</p>
  </section>

  <section id="statusBox" class="hidden">
    <h2>Status</h2>
    <div class="row">
      <span class="pill" id="session">Session: -</span>
      <span class="pill" id="status">Status: -</span>
      <span class="pill" id="phase">Meetingphase: -</span>
      <span class="pill" id="players">Spieler: -</span>
      <span class="pill" id="tasks">Tasks: -</span>
      <span class="pill" id="votes">Votes: -</span>
      <span class="pill" id="emergency">Emergency: -</span>
    </div>
  </section>

  <section id="actionsBox" class="hidden">
    <h2>Admin-Aktionen</h2>
    <button id="startDiscussion">Diskussion starten</button>
    <button id="startVoting">Voting starten</button>
    <button id="evaluateVoting" class="secondary">Voting auswerten</button>
    <button id="endSession" class="danger">Session beenden</button>
  </section>

  <section id="playersBox" class="hidden">
    <h2>Spielerübersicht</h2>
    <table>
      <thead><tr><th>Name</th><th>Rolle</th><th>Status</th><th>Tasks</th><th>Aktion</th></tr></thead>
      <tbody id="playerRows"></tbody>
    </table>
  </section>

  <script>
  let currentStatus = null;
  document.getElementById("refresh").onclick = loadStatus;
  const apiBase = location.pathname.startsWith("/guild/") ? location.pathname.split("/").slice(0, 3).join("/") : "";
  bind("startDiscussion", () => post(apiBase + "/api/admin/meeting/start-discussion"));
  bind("startVoting", () => post(apiBase + "/api/admin/meeting/start-voting"));
  bind("evaluateVoting", () => post(apiBase + "/api/admin/meeting/evaluate-voting"));
  bind("endSession", () => post(apiBase + "/api/admin/session/end"));
  function bind(id, fn) { const element = document.getElementById(id); if (element) element.onclick = fn; }
  async function post(url, body = {}) {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json();
    show(data.error || data.message || "OK", !data.error);
    await loadStatus();
  }
  async function loadStatus() {
    const response = await fetch(apiBase + "/api/admin/status");
    const data = await response.json();
    currentStatus = data;
    render(data);
  }
  function render(data) {
    const hasSession = Boolean(data.session);
    toggle("statusBox", hasSession);
    toggle("actionsBox", hasSession && data.active);
    toggle("playersBox", hasSession);
    if (!hasSession) {
      show(data.message || "Aktuell läuft keine Session.", true);
      document.getElementById("playerRows").innerHTML = "";
      return;
    }
    setText("session", "Session: " + data.session.id + (data.session.isDebugSession ? " | Debug-Runde" : ""));
    setText("status", "Status: " + data.session.status);
    setText("phase", "Meetingphase: " + data.session.meetingPhase);
    setText("players", "Spieler: " + data.players.total + " (" + data.players.alive + " alive, " + data.players.dead + " dead, " + data.players.removed + " removed)");
    setText("tasks", "Tasks: " + data.taskProgress.done + "/" + data.taskProgress.total + " (" + data.taskProgress.percent + "%)");
    setText("votes", "Votes: " + data.voting.votesCast + "/" + data.voting.eligibleVoters);
    setText("emergency", "Emergency: " + (data.emergency.cooldownReady ? "bereit" : formatDuration(data.emergency.cooldownRemainingSeconds)));
    document.getElementById("playerRows").innerHTML = data.players.list.map(player =>
      "<tr><td>" + escapeHtml(player.username) + (player.isGhost ? " (Ghost)" : "") + "</td><td>" + (player.role || "-") + "</td><td>" + player.state + "</td><td>" + player.tasks.done + "/" + player.tasks.total + "</td><td><button class='danger' data-player='" + escapeHtml(player.userId) + "'" + (player.state === "removed" || !data.active ? " disabled" : "") + ">Kicken</button></td></tr>"
    ).join("");
    document.querySelectorAll("button[data-player]").forEach(button => {
      button.onclick = () => post(apiBase + "/api/admin/player/kick", { player_id: button.getAttribute("data-player") });
    });
    show(data.active ? "Adminpanel bereit." : (data.message || "Session beendet."), true);
  }
  function toggle(id, isVisible) { document.getElementById(id).classList.toggle("hidden", !isVisible); }
  function setText(id, value) { document.getElementById(id).textContent = value; }
  function show(text, ok) { const element = document.getElementById("message"); element.textContent = text; element.className = ok ? "ok" : "error"; }
  function formatDuration(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
  }
  loadStatus();
  setInterval(loadStatus, 2000);
  </script>`);
}
