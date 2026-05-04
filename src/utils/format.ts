import { Player, PlayerTask } from "../models/session";

export function progressLine(done: number, total: number): string {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return `${done}/${total} (${percent}%)`;
}

export function playerDisplay(player: Player, tasks: PlayerTask[] = [], revealRole = false): string {
  const done = tasks.filter((task) => task.completed).length;
  const role = revealRole && player.role ? ` - ${player.role}` : "";
  return `<@${player.userId}>${role} - ${player.state} - Tasks ${progressLine(done, tasks.length)}`;
}
