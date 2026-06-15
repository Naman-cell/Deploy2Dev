import type { NextFunction, Request, Response } from "express";
import express from "express";
import cors from "cors";
import path from "node:path";
import { CreateUserRequestSchema, EnvironmentSchema, LoginRequestSchema } from "@heimdall/shared";
import { randomUUID } from "node:crypto";
import { authenticateCredentials, hashPassword, signToken, toPublicUser, verifyToken } from "./auth";
import type { AppConfig } from "./config";
import { AppError, isAppError } from "./errors";
import type { DeploymentCenterService } from "./deployment-service";
import type { Logger } from "./logger";
import type { DataStore } from "./store/types";

interface AuthedRequest extends Request {
  actor?: {
    userId: string;
    email: string;
    name: string;
    role: "admin" | "user";
  };
}

export function createApp(
  config: AppConfig,
  store: DataStore,
  deploymentCenter: DeploymentCenterService,
  logger: Logger
) {
  const app = express();
  app.use(cors({ origin: process.env.CORS_ORIGIN ?? true, credentials: true }));
  app.use(express.json({ limit: "1mb" }));
  app.use((request, _response, next) => {
    if (request.url === "/api") {
      request.url = "/";
    } else if (request.url.startsWith("/api/")) {
      request.url = request.url.slice("/api".length);
    }
    next();
  });

  const requireParam = (value: string | undefined, name: string): string => {
    if (!value) {
      throw new AppError(400, "missing_route_param", `Missing route parameter: ${name}`);
    }
    return value;
  };

  const requireAuth = (request: AuthedRequest, _response: Response, next: NextFunction) => {
    const header = request.header("Authorization");
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    if (!token) {
      next(new AppError(401, "missing_token", "Missing bearer token"));
      return;
    }
    request.actor = verifyToken(token, config);
    next();
  };

  const requireAdmin = (request: AuthedRequest, _response: Response, next: NextFunction) => {
    if (request.actor?.role !== "admin") {
      next(new AppError(403, "admin_required", "Admin role is required"));
      return;
    }
    next();
  };

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.post("/auth/login", async (request, response, next) => {
    try {
      const body = LoginRequestSchema.parse(request.body);
      const user = await authenticateCredentials(body.email, body.password, store);
      const publicUser = toPublicUser(user);
      response.json({
        token: signToken(
          {
            userId: publicUser.userId,
            email: publicUser.email,
            name: publicUser.name,
            role: publicUser.role
          },
          config
        ),
        user: publicUser
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/me", requireAuth, async (request: AuthedRequest, response, next) => {
    try {
      const actor = request.actor;
      if (!actor) {
        throw new AppError(401, "missing_actor", "Missing authenticated user");
      }
      const user = await store.getUserById(actor.userId);
      if (!user) {
        throw new AppError(401, "user_not_found", "Authenticated user was not found");
      }
      response.json(toPublicUser(user));
    } catch (error) {
      next(error);
    }
  });

  app.get("/services", requireAuth, (_request, response) => {
    response.json({ services: deploymentCenter.listServices() });
  });

  app.get("/services/:serviceId", requireAuth, (request, response, next) => {
    try {
      response.json(deploymentCenter.getService(requireParam(request.params.serviceId, "serviceId")));
    } catch (error) {
      next(error);
    }
  });

  app.get("/services/:serviceId/releases", requireAuth, async (request, response, next) => {
    try {
      const environment = EnvironmentSchema.parse(request.query.environment);
      const releases = await deploymentCenter.listReleases(
        requireParam(request.params.serviceId, "serviceId"),
        environment
      );
      response.json({ releases });
    } catch (error) {
      next(error);
    }
  });

  app.get("/services/:serviceId/current", requireAuth, async (request, response, next) => {
    try {
      const environment = EnvironmentSchema.parse(request.query.environment);
      const current = await deploymentCenter.currentState(
        requireParam(request.params.serviceId, "serviceId"),
        environment
      );
      response.json(current);
    } catch (error) {
      next(error);
    }
  });

  app.post("/deployments", requireAuth, async (request: AuthedRequest, response, next) => {
    try {
      if (!request.actor) {
        throw new AppError(401, "missing_actor", "Missing authenticated user");
      }
      const deployment = await deploymentCenter.createDeployment(request.body, request.actor);
      response.status(201).json(deployment);
    } catch (error) {
      next(error);
    }
  });

  app.get("/deployments", requireAuth, async (_request, response, next) => {
    try {
      response.json({ deployments: await store.listDeployments() });
    } catch (error) {
      next(error);
    }
  });

  app.get("/deployments/:deploymentId", requireAuth, async (request, response, next) => {
    try {
      const deployment = await store.getDeployment(
        requireParam(request.params.deploymentId, "deploymentId")
      );
      if (!deployment) {
        throw new AppError(404, "deployment_not_found", "Deployment was not found");
      }
      response.json(deployment);
    } catch (error) {
      next(error);
    }
  });

  app.post("/deployments/:deploymentId/rollback", requireAuth, async (request: AuthedRequest, response, next) => {
    try {
      if (!request.actor) {
        throw new AppError(401, "missing_actor", "Missing authenticated user");
      }
      response.json(
        await deploymentCenter.rollback(requireParam(request.params.deploymentId, "deploymentId"), request.actor)
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/users", requireAuth, requireAdmin, async (_request, response, next) => {
    try {
      const users = await store.listUsers();
      response.json({ users: users.map(toPublicUser) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/users", requireAuth, requireAdmin, async (request, response, next) => {
    try {
      const body = CreateUserRequestSchema.parse(request.body);
      const now = new Date().toISOString();
      const user = await store.createUser({
        userId: randomUUID(),
        email: body.email,
        name: body.name,
        role: body.role,
        status: "active",
        passwordHash: await hashPassword(body.password),
        createdAt: now,
        updatedAt: now
      });
      response.status(201).json(toPublicUser(user));
    } catch (error) {
      next(error);
    }
  });

  if (process.env.STATIC_ASSETS_DIR) {
    const staticAssetsDir = path.resolve(process.env.STATIC_ASSETS_DIR);
    app.use(express.static(staticAssetsDir));
    app.get("*", (_request, response) => {
      response.sendFile(path.join(staticAssetsDir, "index.html"));
    });
  }

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (isAppError(error)) {
      response.status(error.statusCode).json({ error: { code: error.code, message: error.message } });
      return;
    }

    if (error && typeof error === "object" && "issues" in error) {
      response.status(400).json({ error: { code: "validation_error", message: "Invalid request" } });
      return;
    }

    logger.error("unhandled api error", {
      error: error instanceof Error ? error.message : "Unknown error"
    });
    response.status(500).json({ error: { code: "internal_error", message: "Internal server error" } });
  });

  return app;
}
