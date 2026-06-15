import type {
  CurrentServiceState,
  Deployment,
  DeploymentService,
  Environment,
  Release,
  Role,
  User
} from "@heimdall/shared";

interface LoginResponse {
  token: string;
  user: User;
}

interface ApiErrorBody {
  error?: {
    code: string;
    message: string;
  };
}

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

export class ApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

async function request<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers
    }
  });

  const body = (await response.json().catch(() => ({}))) as ApiErrorBody | T;
  if (!response.ok) {
    const error = body as ApiErrorBody;
    throw new ApiError(
      response.status,
      error.error?.code ?? "request_failed",
      error.error?.message ?? "Request failed"
    );
  }

  return body as T;
}

export const api = {
  login: (email: string, password: string) =>
    request<LoginResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    }),
  me: (token: string) => request<User>("/me", {}, token),
  services: (token: string) =>
    request<{ services: DeploymentService[] }>("/services", {}, token).then((body) => body.services),
  releases: (token: string, serviceId: string, environment: Environment) =>
    request<{ releases: Release[] }>(
      `/services/${serviceId}/releases?environment=${environment}`,
      {},
      token
    ).then((body) => body.releases),
  current: (token: string, serviceId: string, environment: Environment) =>
    request<CurrentServiceState>(
      `/services/${serviceId}/current?environment=${environment}`,
      {},
      token
    ),
  deployments: (token: string) =>
    request<{ deployments: Deployment[] }>("/deployments", {}, token).then((body) => body.deployments),
  deploy: (
    token: string,
    payload: { serviceId: string; environment: Environment; imageTag: string; imageDigest: string }
  ) =>
    request<Deployment>(
      "/deployments",
      {
        method: "POST",
        body: JSON.stringify(payload)
      },
      token
    ),
  rollback: (token: string, deploymentId: string) =>
    request<Deployment>(`/deployments/${deploymentId}/rollback`, { method: "POST" }, token),
  createUser: (
    token: string,
    payload: { email: string; name: string; password: string; role: Role }
  ) =>
    request<User>(
      "/users",
      {
        method: "POST",
        body: JSON.stringify(payload)
      },
      token
    )
};
