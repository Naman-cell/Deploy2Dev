import type { AppConfig } from "../config";
import { DynamoDbStore } from "./dynamodb-store";
import { MemoryStore } from "./memory-store";
import type { DataStore } from "./types";

export function createStore(config: AppConfig): DataStore {
  if (config.dataStore === "dynamodb") {
    return new DynamoDbStore(config);
  }
  return new MemoryStore(config);
}
