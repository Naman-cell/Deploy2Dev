import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  type TranslateConfig
} from "@aws-sdk/lib-dynamodb";
import type { Deployment, DeploymentEvent } from "@heimdall/shared";
import { randomUUID } from "node:crypto";
import { hashPassword } from "../auth";
import type { AppConfig } from "../config";
import { AppError } from "../errors";
import type { DataStore, DeploymentLock, StoredUser } from "./types";

// `Deployment` (and `StoredUser`) records commonly carry `undefined` optional fields
// (e.g. a fresh deployment has no `completedAt`/`errorMessage`/task-definition ARNs yet).
// The underlying DynamoDB marshaller throws on `undefined` map values unless explicitly
// told to strip them. Exported so the regression test in dynamodb-store.test.ts exercises
// this exact config rather than a hand-copied duplicate.
export const documentClientTranslateConfig: TranslateConfig = {
  marshallOptions: { removeUndefinedValues: true }
};

export class DynamoDbStore implements DataStore {
  private readonly client: DynamoDBDocumentClient;

  public constructor(private readonly config: AppConfig) {
    this.client = DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: config.awsRegion }),
      documentClientTranslateConfig
    );
  }

  public async ensureSeedAdmin(): Promise<void> {
    const existing = await this.getUserByEmail(this.config.seedAdminEmail);
    if (existing) {
      return;
    }

    const now = new Date().toISOString();
    await this.createUser({
      userId: randomUUID(),
      email: this.config.seedAdminEmail,
      name: "Initial Admin",
      role: "admin",
      status: "active",
      passwordHash: await hashPassword(this.config.seedAdminPassword),
      createdAt: now,
      updatedAt: now
    });
  }

  public async getUserByEmail(email: string): Promise<StoredUser | undefined> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.config.usersTableName,
        IndexName: "email-index",
        KeyConditionExpression: "email = :email",
        ExpressionAttributeValues: { ":email": email },
        Limit: 1
      })
    );
    return result.Items?.[0] as StoredUser | undefined;
  }

  public async getUserById(userId: string): Promise<StoredUser | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.config.usersTableName,
        Key: { userId }
      })
    );
    return result.Item as StoredUser | undefined;
  }

  public async listUsers(): Promise<StoredUser[]> {
    const result = await this.client.send(new ScanCommand({ TableName: this.config.usersTableName }));
    return ((result.Items ?? []) as StoredUser[]).sort((a, b) => a.email.localeCompare(b.email));
  }

  public async createUser(user: StoredUser): Promise<StoredUser> {
    const existing = await this.getUserByEmail(user.email);
    if (existing) {
      throw new AppError(409, "user_exists", "A user with this email already exists");
    }
    await this.client.send(
      new PutCommand({
        TableName: this.config.usersTableName,
        Item: user,
        ConditionExpression: "attribute_not_exists(userId)"
      })
    );
    return user;
  }

  public async saveDeployment(deployment: Deployment): Promise<void> {
    await this.putDeployment(deployment);
  }

  public async getDeployment(deploymentId: string): Promise<Deployment | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.config.deploymentsTableName,
        Key: { deploymentId }
      })
    );
    return result.Item as Deployment | undefined;
  }

  public async listDeployments(): Promise<Deployment[]> {
    const result = await this.client.send(
      new ScanCommand({ TableName: this.config.deploymentsTableName })
    );
    return ((result.Items ?? []) as Deployment[]).sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt)
    );
  }

  public async updateDeployment(deployment: Deployment): Promise<void> {
    await this.putDeployment(deployment);
  }

  public async appendDeploymentEvent(event: DeploymentEvent): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.config.deploymentEventsTableName,
        Item: { ...event, eventId: `${event.deploymentId}#${event.timestamp}#${event.phase}` }
      })
    );

    const deployment = await this.getDeployment(event.deploymentId);
    if (deployment) {
      deployment.events.push(event);
      await this.updateDeployment(deployment);
    }
  }

  public async acquireLock(lock: DeploymentLock): Promise<boolean> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.config.locksTableName,
          Item: lock,
          ConditionExpression: "attribute_not_exists(lockKey) OR expiresAt < :now",
          ExpressionAttributeValues: { ":now": Math.floor(Date.now() / 1000) }
        })
      );
      return true;
    } catch (_error) {
      return false;
    }
  }

  public async releaseLock(lockKey: string, deploymentId: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({
        TableName: this.config.locksTableName,
        Key: { lockKey },
        ConditionExpression: "deploymentId = :deploymentId",
        ExpressionAttributeValues: { ":deploymentId": deploymentId }
      })
    );
  }

  private async putDeployment(deployment: Deployment): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.config.deploymentsTableName,
        Item: deployment
      })
    );
  }
}
