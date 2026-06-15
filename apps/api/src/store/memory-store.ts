import type { Deployment, DeploymentEvent } from "@heimdall/shared";
import { randomUUID } from "node:crypto";
import { hashPassword } from "../auth";
import type { AppConfig } from "../config";
import { AppError } from "../errors";
import type { DataStore, DeploymentLock, StoredUser } from "./types";

export class MemoryStore implements DataStore {
  private readonly users = new Map<string, StoredUser>();
  private readonly deployments = new Map<string, Deployment>();
  private readonly locks = new Map<string, DeploymentLock>();

  public constructor(private readonly config: AppConfig) {}

  public async ensureSeedAdmin(): Promise<void> {
    const existing = await this.getUserByEmail(this.config.seedAdminEmail);
    if (existing) {
      return;
    }

    const now = new Date().toISOString();
    await this.createUser({
      userId: randomUUID(),
      email: this.config.seedAdminEmail,
      name: "Local Admin",
      role: "admin",
      status: "active",
      passwordHash: await hashPassword(this.config.seedAdminPassword),
      createdAt: now,
      updatedAt: now
    });
  }

  public async getUserByEmail(email: string): Promise<StoredUser | undefined> {
    return Array.from(this.users.values()).find((user) => user.email === email);
  }

  public async getUserById(userId: string): Promise<StoredUser | undefined> {
    return this.users.get(userId);
  }

  public async listUsers(): Promise<StoredUser[]> {
    return Array.from(this.users.values()).sort((a, b) => a.email.localeCompare(b.email));
  }

  public async createUser(user: StoredUser): Promise<StoredUser> {
    const existing = await this.getUserByEmail(user.email);
    if (existing) {
      throw new AppError(409, "user_exists", "A user with this email already exists");
    }
    this.users.set(user.userId, user);
    return user;
  }

  public async saveDeployment(deployment: Deployment): Promise<void> {
    this.deployments.set(deployment.deploymentId, deployment);
  }

  public async getDeployment(deploymentId: string): Promise<Deployment | undefined> {
    return this.deployments.get(deploymentId);
  }

  public async listDeployments(): Promise<Deployment[]> {
    return Array.from(this.deployments.values()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  public async updateDeployment(deployment: Deployment): Promise<void> {
    this.deployments.set(deployment.deploymentId, deployment);
  }

  public async appendDeploymentEvent(event: DeploymentEvent): Promise<void> {
    const deployment = this.deployments.get(event.deploymentId);
    if (!deployment) {
      return;
    }
    deployment.events.push(event);
    this.deployments.set(event.deploymentId, deployment);
  }

  public async acquireLock(lock: DeploymentLock): Promise<boolean> {
    const existing = this.locks.get(lock.lockKey);
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (existing && existing.expiresAt > nowSeconds) {
      return false;
    }
    this.locks.set(lock.lockKey, lock);
    return true;
  }

  public async releaseLock(lockKey: string, deploymentId: string): Promise<void> {
    const existing = this.locks.get(lockKey);
    if (existing?.deploymentId === deploymentId) {
      this.locks.delete(lockKey);
    }
  }
}
