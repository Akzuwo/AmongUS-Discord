import { Player, PlayerTask } from "../models/session";

export function progressLine(done: number, total: number): string {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return `${done}/${total} (${percent}%)`;
}

export function playerLabel(player: Pick<Player, "userId" | "username" | "isGhost" | "discordUserId">): string {
  if (player.isGhost || !player.discordUserId) {
    return player.username;
  }
  return `<@${player.discordUserId}>`;
}

export function playerDisplay(player: Player, tasks: PlayerTask[] = [], revealRole = false): string {
  const done = tasks.filter((task) => task.completed).length;
  const role = revealRole && player.role ? ` - ${player.role}` : "";
  const ghost = player.isGhost ? " (Ghost)" : "";
  return `${playerLabel(player)}${ghost}${role} - ${player.state} - Tasks ${progressLine(done, tasks.length)}`;
}
