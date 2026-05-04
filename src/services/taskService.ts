import fs from "node:fs";
import { config } from "../config";
import { TaskCatalog, TaskType } from "../models/session";

export function loadTaskCatalog(): TaskCatalog {
  const raw = fs.readFileSync(config.tasksPath, "utf8");
  const catalog = JSON.parse(raw) as TaskCatalog;

  for (const key of ["short_tasks", "medium_tasks", "long_tasks"] as const) {
    if (!Array.isArray(catalog[key]) || catalog[key].length === 0) {
      throw new Error(`Task catalog ${config.tasksPath} needs a non-empty ${key} array`);
    }
  }

  return catalog;
}

export function pickTasks(catalog: TaskCatalog, counts: { short: number; medium: number; long: number }): Array<{ type: TaskType; description: string }> {
  return [
    ...pickMany(catalog.short_tasks, counts.short).map((description) => ({ type: "short" as const, description })),
    ...pickMany(catalog.medium_tasks, counts.medium).map((description) => ({ type: "medium" as const, description })),
    ...pickMany(catalog.long_tasks, counts.long).map((description) => ({ type: "long" as const, description }))
  ];
}

function pickMany(source: string[], amount: number): string[] {
  const shuffled = [...source].sort(() => Math.random() - 0.5);
  const result: string[] = [];

  for (let index = 0; index < amount; index += 1) {
    result.push(shuffled[index % shuffled.length]);
  }

  return result;
}
