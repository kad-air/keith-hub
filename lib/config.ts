import fs from "fs";
import path from "path";
import yaml from "js-yaml";

export interface SourceConfig {
  id: string;
  name: string;
  type: "rss" | "bluesky" | "podcast";
  category: string;
  url?: string;
  poll_interval_minutes?: number;
  mode?: "timeline" | "account";
  handle?: string;
}

export interface AppConfig {
  app: {
    name: string;
    port: number;
    poll_interval_minutes: number;
    items_per_page: number;
    retention_days: number;
  };
  sources: SourceConfig[];
}

let cachedConfig: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const configPath = path.join(process.cwd(), "config", "feeds.yml");

  if (!fs.existsSync(configPath)) {
    // Fall back to example config if feeds.yml doesn't exist
    const examplePath = path.join(process.cwd(), "config", "feeds.example.yml");
    if (!fs.existsSync(examplePath)) {
      throw new Error(
        `Config file not found: ${configPath}. Copy config/feeds.example.yml to config/feeds.yml to get started.`
      );
    }
    const raw = fs.readFileSync(examplePath, "utf-8");
    cachedConfig = yaml.load(raw) as AppConfig;
    return cachedConfig;
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  cachedConfig = yaml.load(raw) as AppConfig;
  return cachedConfig;
}
