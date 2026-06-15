import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Activity, History, Rocket, Shield, Users } from "lucide-react";
import type {
  CurrentServiceState,
  Deployment,
  DeploymentService,
  Environment,
  Release,
  User
} from "@heimdall/shared";
import { environments } from "@heimdall/shared";
import { api, ApiError } from "./api";
import "./styles.css";

type View = "history" | "deploy" | "admin";

interface Session {
  token: string;
  user: User;
}

function formatDigest(digest?: string): string {
  if (!digest) return "unknown";
  return digest.length > 22 ? `${digest.slice(0, 18)}...` : digest;
}

function App() {
  const [session, setSession] = useState<Session | undefined>(() => {
    const raw = localStorage.getItem("heimdall-session");
    return raw ? (JSON.parse(raw) as Session) : undefined;
  });

  if (!session) {
    return <Login onLogin={setSession} />;
  }

  return <Portal session={session} onLogout={() => setSession(undefined)} />;
}

function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const response = await api.login(email, password);
      localStorage.setItem("heimdall-session", JSON.stringify(response));
      onLogin(response);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-shell">
      <form className="login-panel" onSubmit={submit}>
        <div>
          <p className="eyebrow">Skillbrew</p>
          <h1>Heimdall</h1>
          <p className="muted">Controlled deployments for dev, stage, and prod.</p>
        </div>
        <label>
          Email
          <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" />
        </label>
        <label>
          Password
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
          />
        </label>
        {error ? <p className="error">{error}</p> : null}
        <button disabled={loading}>{loading ? "Signing in..." : "Sign in"}</button>
      </form>
    </main>
  );
}

function Portal({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [view, setView] = useState<View>("history");
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [services, setServices] = useState<DeploymentService[]>([]);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    const [nextDeployments, nextServices] = await Promise.all([
      api.deployments(session.token),
      api.services(session.token)
    ]);
    setDeployments(nextDeployments);
    setServices(nextServices);
  }, [session.token]);

  useEffect(() => {
    refresh().catch((error: unknown) =>
      setMessage(error instanceof Error ? error.message : "Failed to load dashboard")
    );
  }, [refresh]);

  function logout() {
    localStorage.removeItem("heimdall-session");
    onLogout();
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Activity size={22} />
          <span>Heimdall</span>
        </div>
        <button className={view === "history" ? "active" : ""} onClick={() => setView("history")}>
          <History size={18} /> Deployment History
        </button>
        <button className={view === "deploy" ? "active" : ""} onClick={() => setView("deploy")}>
          <Rocket size={18} /> Deployment Center
        </button>
        {session.user.role === "admin" ? (
          <button className={view === "admin" ? "active" : ""} onClick={() => setView("admin")}>
            <Users size={18} /> Users
          </button>
        ) : null}
        <div className="sidebar-footer">
          <span>{session.user.email}</span>
          <span className="badge">{session.user.role}</span>
          <button onClick={logout}>Logout</button>
        </div>
      </aside>
      <main className="content">
        {message ? <div className="notice">{message}</div> : null}
        {view === "history" ? (
          <DeploymentHistory
            deployments={deployments}
            token={session.token}
            user={session.user}
            onChanged={refresh}
          />
        ) : null}
        {view === "deploy" ? (
          <DeploymentCenter
            services={services}
            token={session.token}
            user={session.user}
            onChanged={refresh}
          />
        ) : null}
        {view === "admin" ? <AdminUsers token={session.token} /> : null}
      </main>
    </div>
  );
}

function DeploymentHistory({
  deployments,
  token,
  user,
  onChanged
}: {
  deployments: Deployment[];
  token: string;
  user: User;
  onChanged: () => Promise<void>;
}) {
  const [busyId, setBusyId] = useState("");

  async function rollback(deployment: Deployment) {
    if (!window.confirm(`Rollback ${deployment.serviceName} ${deployment.environment}?`)) {
      return;
    }
    setBusyId(deployment.deploymentId);
    try {
      await api.rollback(token, deployment.deploymentId);
      await onChanged();
    } finally {
      setBusyId("");
    }
  }

  return (
    <section>
      <header className="page-header">
        <div>
          <p className="eyebrow">Default view</p>
          <h1>Deployment History</h1>
        </div>
      </header>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Service</th>
              <th>Env</th>
              <th>Release</th>
              <th>Triggered By</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {deployments.length === 0 ? (
              <tr>
                <td colSpan={7} className="empty">
                  No deployments yet.
                </td>
              </tr>
            ) : (
              deployments.map((deployment) => (
                <tr key={deployment.deploymentId}>
                  <td>{new Date(deployment.startedAt).toLocaleString()}</td>
                  <td>{deployment.serviceName}</td>
                  <td>
                    <span className={`env ${deployment.environment}`}>{deployment.environment}</span>
                  </td>
                  <td>
                    <strong>{deployment.selectedImageTag}</strong>
                    <small>{formatDigest(deployment.selectedImageDigest)}</small>
                  </td>
                  <td>{deployment.requestedByEmail}</td>
                  <td>
                    <span className={`status ${deployment.status}`}>{deployment.status}</span>
                  </td>
                  <td>
                    <button
                      className="secondary"
                      disabled={
                        !deployment.previousTaskDefinitionArn ||
                        busyId === deployment.deploymentId ||
                        (deployment.environment === "prod" && user.role !== "admin")
                      }
                      onClick={() => void rollback(deployment)}
                    >
                      {busyId === deployment.deploymentId ? "Rolling back..." : "Rollback"}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DeploymentCenter({
  services,
  token,
  user,
  onChanged
}: {
  services: DeploymentService[];
  token: string;
  user: User;
  onChanged: () => Promise<void>;
}) {
  const [serviceId, setServiceId] = useState(services[0]?.serviceId ?? "");
  const [environment, setEnvironment] = useState<Environment>("dev");
  const [releases, setReleases] = useState<Release[]>([]);
  const [releaseDigest, setReleaseDigest] = useState("");
  const [current, setCurrent] = useState<CurrentServiceState | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const selectedRelease = useMemo(
    () => releases.find((release) => release.digest === releaseDigest),
    [releaseDigest, releases]
  );

  useEffect(() => {
    setServiceId(services[0]?.serviceId ?? "");
  }, [services]);

  useEffect(() => {
    if (!serviceId) return;
    Promise.all([api.releases(token, serviceId, environment), api.current(token, serviceId, environment)])
      .then(([nextReleases, nextCurrent]) => {
        setReleases(nextReleases);
        setCurrent(nextCurrent);
        setReleaseDigest(nextReleases.find((release) => !release.isEnvironmentPointer)?.digest ?? "");
      })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Load failed"));
  }, [environment, serviceId, token]);

  const prodBlocked = environment === "prod" && user.role !== "admin";

  async function deploy() {
    if (!selectedRelease) return;
    if (
      !window.confirm(
        `Deploy ${selectedRelease.tag} to ${environment}? This will move :${environment} and force ECS deployment.`
      )
    ) {
      return;
    }
    setLoading(true);
    setError("");
    try {
      await api.deploy(token, {
        serviceId,
        environment,
        imageTag: selectedRelease.tag,
        imageDigest: selectedRelease.digest
      });
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Deployment failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section>
      <header className="page-header">
        <div>
          <p className="eyebrow">Promote release</p>
          <h1>Deployment Center</h1>
        </div>
      </header>
      <div className="deploy-grid">
        <label>
          Microservice
          <select value={serviceId} onChange={(event) => setServiceId(event.target.value)}>
            {services.map((service) => (
              <option key={service.serviceId} value={service.serviceId}>
                {service.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Environment
          <select
            value={environment}
            onChange={(event) => setEnvironment(event.target.value as Environment)}
          >
            {environments.map((env) => (
              <option key={env} value={env}>
                {env}
              </option>
            ))}
          </select>
        </label>
        <label>
          Release
          <select value={releaseDigest} onChange={(event) => setReleaseDigest(event.target.value)}>
            {releases.map((release) => (
              <option key={`${release.tag}-${release.digest}`} value={release.digest}>
                {release.tag} {release.isEnvironmentPointer ? "(env pointer)" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="summary">
        <div>
          <span>Current :{environment}</span>
          <strong>{formatDigest(current?.environmentImageDigest)}</strong>
        </div>
        <div>
          <span>Selected release</span>
          <strong>{selectedRelease?.tag ?? "none"}</strong>
          <small>{formatDigest(selectedRelease?.digest)}</small>
        </div>
        <div>
          <span>ECS service</span>
          <strong>{current?.serviceName ?? "unknown"}</strong>
          <small>{current?.status ?? "unknown"}</small>
        </div>
      </div>
      {prodBlocked ? (
        <p className="warning">
          <Shield size={16} /> Prod deployments are admin-only. You can view prod releases but cannot
          deploy them.
        </p>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
      <button disabled={!selectedRelease || loading || prodBlocked} onClick={() => void deploy()}>
        {loading ? "Deploying..." : `Deploy to ${environment}`}
      </button>
    </section>
  );
}

function AdminUsers({ token }: { token: string }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "user">("user");
  const [message, setMessage] = useState("");

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setMessage("");
    try {
      const user = await api.createUser(token, { email, name, password, role });
      setMessage(`Created ${user.email}`);
      setEmail("");
      setName("");
      setPassword("");
      setRole("user");
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Failed to create user");
    }
  }

  return (
    <section>
      <header className="page-header">
        <div>
          <p className="eyebrow">Admin</p>
          <h1>User Management</h1>
        </div>
      </header>
      <form className="admin-form" onSubmit={create}>
        <label>
          Name
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          Email
          <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" />
        </label>
        <label>
          Temporary password
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
          />
        </label>
        <label>
          Role
          <select value={role} onChange={(event) => setRole(event.target.value as "admin" | "user")}>
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <button>Create user</button>
        {message ? <p className="notice">{message}</p> : null}
      </form>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
