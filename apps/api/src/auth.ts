import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { Role, User } from "@heimdall/shared";
import type { AppConfig } from "./config";
import { AppError } from "./errors";
import type { DataStore, StoredUser } from "./store/types";

export interface AuthUser {
  userId: string;
  email: string;
  name: string;
  role: Role;
}

export interface TokenClaims extends AuthUser {
  iat?: number;
  exp?: number;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function toPublicUser(user: StoredUser): User {
  return {
    userId: user.userId,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

export function signToken(user: AuthUser, config: AppConfig): string {
  return jwt.sign(user, config.jwtSecret, { expiresIn: config.tokenTtlSeconds });
}

export function verifyToken(token: string, config: AppConfig): TokenClaims {
  try {
    return jwt.verify(token, config.jwtSecret) as TokenClaims;
  } catch (_error) {
    throw new AppError(401, "invalid_token", "Invalid or expired token");
  }
}

export async function authenticateCredentials(
  email: string,
  password: string,
  store: DataStore
): Promise<StoredUser> {
  const user = await store.getUserByEmail(email);
  if (!user || user.status !== "active") {
    throw new AppError(401, "invalid_credentials", "Invalid email or password");
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    throw new AppError(401, "invalid_credentials", "Invalid email or password");
  }

  return user;
}
