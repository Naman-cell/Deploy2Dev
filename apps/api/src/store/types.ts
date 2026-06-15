import type { Deployment, DeploymentEvent, Role } from "@heimdall/shared";

export interface StoredUser {
  userId: string;
  email: string;
  name: string;
  role: Role;
  status: "active" | "disabled";
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentLock {
  lockKey: string;
  deploymentId: string;
  expiresAt: number;
  createdAt: string;
}

export interface DataStore {
  ensureSeedAdmin(): Promise<void>;
  getUserByEmail(email: string): Promise<StoredUser | undefined>;
  getUserById(userId: string): Promise<StoredUser | undefined>;
  listUsers(): Promise<StoredUser[]>;
  createUser(user: StoredUser): Promise<StoredUser>;
  saveDeployment(deployment: Deployment): Promise<void>;
  getDeployment(deploymentId: string): Promise<Deployment | undefined>;
  listDeployments(): Promise<Deployment[]>;
  updateDeployment(deployment: Deployment): Promise<void>;
  appendDeploymentEvent(event: DeploymentEvent): Promise<void>;
  acquireLock(lock: DeploymentLock): Promise<boolean>;
  releaseLock(lockKey: string, deploymentId: string): Promise<void>;
}
