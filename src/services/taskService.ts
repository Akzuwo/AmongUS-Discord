import fs from "node:fs";
import { config } from "../config";
import { CatalogTask, RawCatalogTask, TaskCatalog, TaskStep, TaskType } from "../models/session";

const DEFAULT_TASK_LOCATION = "Unbekannter Ort";

export function loadTaskCatalog(): TaskCatalog {
  const raw = fs.readFileSync(config.tasksPath, "utf8");
  const catalog = JSON.parse(raw) as TaskCatalog;

  for (const key of ["short_tasks", "medium_tasks", "long_tasks"] as const) {
    if (!Array.isArray(catalog[key]) || catalog[key].length === 0) {
      throw new Error(`Task catalog ${config.tasksPath} needs a non-empty ${key} array`);
    }
    catalog[key].forEach((task, index) => normalizeCatalogTask(task, typeFromKey(key), index));
  }

  return catalog;
}

export function pickTasks(catalog: TaskCatalog, counts: { short: number; medium: number; long: number }): CatalogTask[] {
  return [
    ...pickMany(catalog.short_tasks, counts.short).map((task, index) => normalizeCatalogTask(task, "short", index)),
    ...pickMany(catalog.medium_tasks, counts.medium).map((task, index) => normalizeCatalogTask(task, "medium", index)),
    ...pickMany(catalog.long_tasks, counts.long).map((task, index) => normalizeCatalogTask(task, "long", index))
  ];
}

function pickMany<T>(source: T[], amount: number): T[] {
  const shuffled = [...source].sort(() => Math.random() - 0.5);
  const result: T[] = [];

  for (let index = 0; index < amount; index += 1) {
    result.push(shuffled[index % shuffled.length]);
  }

  return result;
}

function normalizeCatalogTask(task: string | RawCatalogTask, category: TaskType, index: number): CatalogTask {
  if (typeof task === "string") {
    return {
      id: `${category}_${index + 1}`,
      title: task,
      description: task,
      location: DEFAULT_TASK_LOCATION,
      category
    };
  }

  const title = task.title ?? task.name;
  if (!task.id || !title) {
    throw new Error(`Task catalog ${config.tasksPath} has a ${category} task without id or title`);
  }

  const steps = normalizeSteps(task.steps ?? [], task.id);
  return {
    id: task.id,
    title,
    description: task.description ?? task.beschreibung ?? title,
    location: task.ort ?? task.location ?? DEFAULT_TASK_LOCATION,
    category,
    steps
  };
}

function normalizeSteps(steps: TaskStep[], taskId: string): TaskStep[] {
  if (!Array.isArray(steps) || steps.length === 0) {
    return [];
  }
  if (steps.length > 25) {
    throw new Error(`Task ${taskId} has more than 25 steps; split it into smaller tasks for Discord buttons`);
  }

  const seen = new Set<string>();
  for (const step of steps) {
    if (!step.id || !step.title) {
      throw new Error(`Task ${taskId} has a step without id or title`);
    }
    if (seen.has(step.id)) {
      throw new Error(`Task ${taskId} has duplicate step id ${step.id}`);
    }
    seen.add(step.id);
  }
  return steps;
}

function typeFromKey(key: keyof TaskCatalog): TaskType {
  if (key === "short_tasks") {
    return "short";
  }
  if (key === "medium_tasks") {
    return "medium";
  }
  return "long";
}
