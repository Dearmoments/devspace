import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./admin.css";

type PageId = "overview" | "services" | "plugins" | "mcp" | "workspaces" | "network" | "logs" | "settings";
type ToolMode = "minimal" | "full" | "codex";
type WidgetMode = "off" | "changes" | "full";
type ServiceState = "running" | "stopped" | "unavailable" | "unknown";
type PrivilegeLevel = "administrator" | "limited" | "unknown" | "unsupported";
type TaskRunLevel = "highest" | "limited" | "unknown" | "missing" | "unsupported";

type Project = { name: string; path: string; root: string };
type ToolState = { name: string; available: boolean; enabled: boolean };
type Provider = { id?: string; name?: string; available?: boolean; enabled?: boolean; usable?: boolean; note?: string; model?: string; effort?: string };
type AdminStatus = {
  ok: boolean;
  name: string;
  version: string;
  pid: number;
  uptimeSeconds: number;
  host: string;
  port: number;
  publicBaseUrl: string;
  mcpUrl: string;
  allowedRoots: string[];
  allowedHosts: string[];
  schemaRevision: number;
  sessionCount: number;
  tools: ToolState[];
  exposedCoreToolCount: number;
  settings: {
    toolMode: ToolMode;
    widgets: WidgetMode;
    skillsEnabled: boolean;
    subagentsEnabled: boolean;
    artifactsEnabled: boolean;
    disabledTools: string[];
  };
  providers: Provider[];
  backendRunning?: boolean;
  supervisor?: {
    pid: number;
    uptimeSeconds: number;
    port: number;
    backendPort: number;
  };
  privileges?: {
    supported: boolean;
    supervisor: PrivilegeLevel;
    mcpServer: PrivilegeLevel;
    taskRunLevel: TaskRunLevel;
    adminMode: boolean;
  };
};
type AdminService = {
  id: string;
  name: string;
  description: string;
  state: ServiceState;
  pid?: number;
  endpoint?: string;
  taskName?: string;
  controllable: boolean;
  actions: Array<"start" | "stop" | "restart" | "logs">;
  note?: string;
};
type Session = {
  sessionId: string;
  client?: string;
  schemaRevision?: number;
  connectedAt: string;
  lastActivityAt: string;
};

type Notice = { kind: "ok" | "warn" | "error"; text: string } | null;

const NAV: Array<{ id: PageId; icon: string; label: string }> = [
  { id: "overview", icon: "⌂", label: "总览" },
  { id: "services", icon: "◫", label: "服务" },
  { id: "plugins", icon: "⌘", label: "插件" },
  { id: "mcp", icon: "◎", label: "MCP" },
  { id: "workspaces", icon: "▣", label: "工作区" },
  { id: "network", icon: "↗", label: "网络与远程访问" },
  { id: "logs", icon: "≡", label: "日志" },
  { id: "settings", icon: "⚙", label: "设置" },
];

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : `${response.status} ${response.statusText}`);
  return payload as T;
}

function postJson<T>(url: string, body: unknown = {}): Promise<T> {
  return api<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function stateLabel(state: ServiceState): string {
  return ({ running: "Running", stopped: "Stopped", unavailable: "Unavailable", unknown: "Unknown" })[state];
}

function privilegeLabel(level: PrivilegeLevel): string {
  return ({ administrator: "Administrator", limited: "Limited", unknown: "Unknown", unsupported: "Unsupported" })[level];
}

function formatDuration(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  return days > 0 ? `${days}d ${hours}h ${minutes}m` : `${hours}h ${minutes}m`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function Toggle({ checked, onChange, disabled = false, label }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; label: string }) {
  return <button
    className={`toggle ${checked ? "on" : ""}`}
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    onClick={() => onChange(!checked)}
  ><span /></button>;
}

function StateBadge({ state }: { state: ServiceState }) {
  return <span className={`state-badge ${state}`}><i />{stateLabel(state)}</span>;
}

function SectionHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: React.ReactNode }) {
  return <div className="section-header">
    <div>
      {eyebrow && <p className="section-eyebrow">{eyebrow}</p>}
      <h1>{title}</h1>
      {description && <p>{description}</p>}
    </div>
    {actions && <div className="section-actions">{actions}</div>}
  </div>;
}

function App() {
  const [page, setPage] = useState<PageId>("overview");
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [services, setServices] = useState<AdminService[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [query, setQuery] = useState("");
  const [logSource, setLogSource] = useState<"server" | "tunnel" | "agent">("server");
  const [logs, setLogs] = useState<string[]>([]);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rootDrafts, setRootDrafts] = useState<string[]>([]);

  const showNotice = useCallback((kind: NonNullable<Notice>["kind"], text: string) => {
    setNotice({ kind, text });
    window.setTimeout(() => setNotice(null), 4_000);
  }, []);

  const loadStatus = useCallback(async () => {
    const next = await api<AdminStatus>("/api/admin/status");
    setStatus(next);
    setRootDrafts((current) => current.length === 0 ? next.allowedRoots : current);
    return next;
  }, []);

  const loadServices = useCallback(async () => {
    const result = await api<{ services: AdminService[] }>("/api/admin/services");
    setServices(result.services ?? []);
  }, []);

  const loadSessions = useCallback(async () => {
    const result = await api<{ sessions: Session[] }>("/api/admin/mcp/sessions");
    setSessions(result.sessions ?? []);
  }, []);

  const loadProjects = useCallback(async () => {
    const result = await api<{ projects: Project[] }>("/api/admin/projects");
    setProjects(result.projects ?? []);
  }, []);

  const loadLogs = useCallback(async (source = logSource) => {
    try {
      const result = await api<{ lines: string[] }>(`/api/admin/logs?source=${source}&lines=300`);
      setLogs(result.lines ?? []);
    } catch (error) {
      setLogs([`日志读取失败：${error instanceof Error ? error.message : String(error)}`]);
    }
  }, [logSource]);

  const refreshAll = useCallback(async () => {
    try {
      await Promise.all([loadStatus(), loadServices(), loadSessions(), loadProjects()]);
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    }
  }, [loadProjects, loadServices, loadSessions, loadStatus, showNotice]);

  useEffect(() => { void refreshAll(); }, [refreshAll]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadStatus().catch(() => undefined);
      if (page === "services" || page === "overview") void loadServices().catch(() => undefined);
      if (page === "mcp" || page === "overview") void loadSessions().catch(() => undefined);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [loadServices, loadSessions, loadStatus, page]);
  useEffect(() => {
    if (page !== "logs") return;
    void loadLogs();
    const timer = window.setInterval(() => void loadLogs(), 2_500);
    return () => window.clearInterval(timer);
  }, [loadLogs, page]);

  const saveSettings = async (patch: Record<string, unknown>, successText = "设置已保存") => {
    setBusy("settings");
    try {
      const result = await postJson<{ reconnectRecommended?: boolean }>("/api/admin/settings", patch);
      await loadStatus();
      showNotice(result.reconnectRecommended ? "warn" : "ok", result.reconnectRecommended ? `${successText}；MCP 能力有变化，建议重新连接客户端` : successText);
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      setBusy(null);
    }
  };

  const controlService = async (service: AdminService, action: "start" | "stop" | "restart") => {
    setBusy(`${service.id}:${action}`);
    try {
      await postJson(`/api/admin/services/${service.id}/${action}`);
      await loadServices();
      showNotice("ok", `${service.name}：${action === "start" ? "已启动" : action === "stop" ? "已停止" : "已重启"}`);
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const setAdminMode = async (enabled: boolean) => {
    setBusy("admin-mode");
    try {
      const result = await postJson<{ uacRequested: boolean; restarting: boolean }>("/api/admin/privileges/admin-mode", { enabled });
      showNotice(
        "warn",
        enabled
          ? result.uacRequested
            ? "已请求 Windows UAC；批准后 Supervisor 会以管理员权限重启"
            : "正在以管理员模式重启 Supervisor"
          : result.uacRequested
            ? "已请求 Windows UAC；批准后将关闭管理员模式并重启 Supervisor"
            : "正在关闭管理员模式并重启 Supervisor",
      );
      window.setTimeout(() => void loadStatus().catch(() => undefined), 3_000);
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const toggleTool = async (name: string, enabled: boolean) => {
    if (!status) return;
    const disabledTools = enabled
      ? status.settings.disabledTools.filter((tool) => tool !== name)
      : Array.from(new Set([...status.settings.disabledTools, name]));
    await saveSettings({ disabledTools }, `${name} ${enabled ? "已启用" : "已禁用"}`);
  };

  const disconnectSession = async (sessionId: string) => {
    if (!window.confirm("断开这个 MCP 会话？客户端需要重新连接。")) return;
    try {
      await postJson(`/api/admin/mcp/sessions/${encodeURIComponent(sessionId)}/disconnect`);
      await loadSessions();
      await loadStatus();
      showNotice("ok", "MCP 会话已断开");
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    }
  };

  const reloadTools = async () => {
    if (!window.confirm("这会断开当前所有 MCP 会话，客户端需要重新连接以获取最新工具列表。继续？")) return;
    setBusy("reload-tools");
    try {
      const result = await postJson<{ closed: number; schemaRevision: number }>("/api/admin/mcp/reload");
      await Promise.all([loadSessions(), loadStatus()]);
      showNotice("ok", `工具 Schema 已刷新到 revision ${result.schemaRevision}，断开 ${result.closed} 个会话`);
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const filteredProjects = useMemo(() => projects.filter((project) => `${project.name} ${project.path}`.toLowerCase().includes(query.toLowerCase())), [projects, query]);
  const runningCount = services.filter((service) => service.state === "running").length;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-symbol"><span>DS</span></div>
        <div><strong>DevSpace</strong><small>CONTROL PLANE</small></div>
      </div>
      <nav>{NAV.map((item) => <button key={item.id} className={page === item.id ? "active" : ""} onClick={() => setPage(item.id)}>
        <span className="nav-icon">{item.icon}</span><span>{item.label}</span>
        {item.id === "mcp" && status && <b>{status.sessionCount}</b>}
      </button>)}</nav>
      <div className="side-status">
        <div><span className="pulse" /><strong>SUPERVISOR ONLINE</strong></div>
        <p>{status ? `v${status.version} · PID ${status.supervisor?.pid ?? status.pid}` : "连接本地控制面…"}</p>
        <small>{status?.supervisor ? `Control :${status.supervisor.port} · Backend :${status.supervisor.backendPort}` : "本机管理"}</small>
      </div>
    </aside>

    <div className="main-shell">
      <header className="topbar">
        <div><span className="crumb">DEVSPACE /</span><strong>{NAV.find((item) => item.id === page)?.label}</strong></div>
        <div className="top-actions">
          <button className="ghost" onClick={() => void refreshAll()}>↻ 刷新</button>
          <span className="live-pill"><i />SUPERVISOR ONLINE</span>
        </div>
      </header>

      <main className="content">
        {page === "overview" && <Overview status={status} services={services} sessions={sessions} onNavigate={setPage} onReloadTools={reloadTools} busy={busy} />}
        {page === "services" && <Services services={services} busy={busy} onControl={controlService} onLogs={(id) => { setLogSource(id === "cloudflare-tunnel" ? "tunnel" : id === "agent-daemon" ? "agent" : "server"); setPage("logs"); }} />}
        {page === "plugins" && status && <Plugins status={status} busy={busy} onToggleTool={toggleTool} onSave={saveSettings} />}
        {page === "mcp" && status && <McpPage status={status} sessions={sessions} busy={busy} onReload={reloadTools} onDisconnect={disconnectSession} onDisconnectAll={async () => {
          if (!window.confirm("断开所有 MCP 会话？")) return;
          try { await postJson("/api/admin/mcp/sessions/disconnect-all"); await Promise.all([loadSessions(), loadStatus()]); showNotice("ok", "全部 MCP 会话已断开"); }
          catch (error) { showNotice("error", error instanceof Error ? error.message : String(error)); }
        }} />}
        {page === "workspaces" && <Workspaces projects={filteredProjects} total={projects.length} query={query} setQuery={setQuery} onRefresh={loadProjects} onOpen={async (path) => {
          try { await postJson("/api/admin/open-folder", { path }); showNotice("ok", "已在资源管理器打开"); }
          catch (error) { showNotice("error", error instanceof Error ? error.message : String(error)); }
        }} onCopy={async (path) => { await navigator.clipboard.writeText(path); showNotice("ok", "路径已复制"); }} />}
        {page === "network" && status && <Network status={status} />}
        {page === "logs" && <Logs source={logSource} setSource={setLogSource} lines={logs} onRefresh={() => loadLogs()} />}
        {page === "settings" && status && <Settings status={status} roots={rootDrafts} setRoots={setRootDrafts} busy={busy} onAdminMode={setAdminMode} onSave={async (patch) => {
          await saveSettings(patch, "系统设置已保存");
          setRootDrafts((await loadStatus()).allowedRoots);
        }} />}
      </main>
    </div>

    {notice && <div className={`toast ${notice.kind}`}><span>{notice.kind === "ok" ? "✓" : notice.kind === "warn" ? "!" : "×"}</span>{notice.text}</div>}
  </div>;
}

function Overview({ status, services, sessions, onNavigate, onReloadTools, busy }: { status: AdminStatus | null; services: AdminService[]; sessions: Session[]; onNavigate: (page: PageId) => void; onReloadTools: () => void; busy: string | null }) {
  const cards = [
    { key: "server", icon: "▤", title: "DevSpace MCP Server", state: services.find((service) => service.id === "devspace-server")?.state ?? "unknown" as ServiceState, value: services.find((service) => service.id === "devspace-server")?.pid ? `PID ${services.find((service) => service.id === "devspace-server")?.pid}` : "Stopped", meta: status?.backendRunning ? formatDuration(status.uptimeSeconds) : "由 Supervisor 管理", action: () => onNavigate("services") },
    { key: "mcp", icon: "◎", title: "MCP", state: status?.backendRunning ? "running" as ServiceState : status ? "stopped" as ServiceState : "unknown" as ServiceState, value: `${status?.sessionCount ?? sessions.length} sessions`, meta: `Schema rev ${status?.schemaRevision ?? "—"}`, action: () => onNavigate("mcp") },
    { key: "tunnel", icon: "↗", title: "Cloudflare Tunnel", state: services.find((service) => service.id === "cloudflare-tunnel")?.state ?? "unknown" as ServiceState, value: services.find((service) => service.id === "cloudflare-tunnel")?.state === "running" ? "Connected" : "Not connected", meta: status?.publicBaseUrl ?? "—", action: () => onNavigate("network") },
    { key: "agent", icon: "◇", title: "Agent Daemon", state: services.find((service) => service.id === "agent-daemon")?.state ?? "unknown" as ServiceState, value: services.find((service) => service.id === "agent-daemon")?.pid ? `PID ${services.find((service) => service.id === "agent-daemon")?.pid}` : "Idle", meta: status?.settings.subagentsEnabled ? "Subagents enabled" : "Subagents disabled", action: () => onNavigate("services") },
    { key: "oauth", icon: "⌾", title: "OAuth", state: status?.backendRunning ? "running" as ServiceState : "stopped" as ServiceState, value: status?.backendRunning ? "Enabled" : "Backend stopped", meta: "Owner-token flow", action: () => onNavigate("network") },
    { key: "version", icon: "◈", title: "当前版本", state: "running" as ServiceState, value: status ? `v${status.version}` : "—", meta: "本地构建", action: () => onNavigate("settings") },
  ];

  return <>
    <SectionHeader eyebrow="LOCAL CONTROL PLANE" title="一眼看清，本机现在在跑什么。" description="服务、MCP、插件能力和远程入口集中在一个本地控制面。" actions={<button className="primary" onClick={() => onNavigate("services")}>管理服务 →</button>} />
    <div className="overview-grid">{cards.map((card) => <button className="metric-card" key={card.key} onClick={card.action}>
      <div className="metric-top"><span className="metric-icon">{card.icon}</span><StateBadge state={card.state} /></div>
      <h3>{card.title}</h3><strong>{card.value}</strong><small>{card.meta}</small>
    </button>)}</div>

    <div className="split-grid overview-lower">
      <section className="panel tool-surface">
        <div className="panel-title"><div><p>MCP TOOL SURFACE</p><h2>当前核心工具：{status?.exposedCoreToolCount ?? 0} 个</h2></div><button className="ghost" disabled={busy === "reload-tools"} onClick={onReloadTools}>↻ 重新加载工具</button></div>
        <div className="tool-list">{status?.tools.map((tool) => <span key={tool.name} className={`${tool.enabled ? "enabled" : "disabled"} ${!tool.available ? "unavailable" : ""}`}>{tool.name}</span>)}</div>
        <div className="schema-note"><span>Schema revision</span><strong>{status?.schemaRevision ?? "—"}</strong><span>修改工具或插件能力后，可主动断开会话让 Host 重新拉取 tools/list。</span></div>
      </section>
      <section className="panel activity-panel">
        <div className="panel-title"><div><p>LIVE SESSIONS</p><h2>MCP 会话</h2></div><button className="ghost" onClick={() => onNavigate("mcp")}>查看全部</button></div>
        <div className="session-mini">{sessions.slice(0, 4).map((session) => <div key={session.sessionId}><span className="pulse" /><div><strong>{session.client || "MCP client"}</strong><small>{session.sessionId.slice(0, 12)} · rev {session.schemaRevision ?? "—"}</small></div><time>{formatDate(session.lastActivityAt).split(" ").at(-1)}</time></div>)}{sessions.length === 0 && <div className="empty-inline">暂无活动 MCP 会话。</div>}</div>
      </section>
    </div>
  </>;
}

function Services({ services, busy, onControl, onLogs }: { services: AdminService[]; busy: string | null; onControl: (service: AdminService, action: "start" | "stop" | "restart") => void; onLogs: (id: string) => void }) {
  return <>
    <SectionHeader eyebrow="SERVICE CONTROL" title="服务" description="Supervisor 独立承载控制台；DevSpace MCP Server 现在可以真正停止、启动和重启。" actions={<button className="secondary" disabled title="后续 Service Registry">＋ 添加服务 · 后续</button>} />
    <section className="panel table-panel">
      <div className="service-table table-head"><span>服务</span><span>状态</span><span>PID / 端点</span><span>控制</span></div>
      {services.map((service) => <div className="service-table table-row" key={service.id}>
        <div className="service-name"><span className="service-glyph">{service.id === "supervisor" ? "◉" : service.id === "cloudflare-tunnel" ? "↗" : service.id === "agent-daemon" ? "◇" : service.id === "reverse-ssh" ? "⇄" : "▤"}</span><div><strong>{service.name}</strong><small>{service.description}</small>{service.note && <em>{service.note}</em>}</div></div>
        <StateBadge state={service.state} />
        <div className="endpoint"><strong>{service.pid ? `PID ${service.pid}` : service.taskName || "—"}</strong><small>{service.endpoint || "未配置端点"}</small></div>
        <div className="row-actions">
          {service.actions.includes("start") && <button disabled={!service.controllable || service.state === "running" || busy !== null} onClick={() => onControl(service, "start")}>启动</button>}
          {service.actions.includes("stop") && <button className="danger-soft" disabled={!service.controllable || service.state !== "running" || busy !== null} onClick={() => onControl(service, "stop")}>停止</button>}
          {service.actions.includes("restart") && <button disabled={!service.controllable || busy !== null} onClick={() => onControl(service, "restart")}>重启</button>}
          {service.actions.includes("logs") && <button onClick={() => onLogs(service.id)}>日志</button>}
        </div>
      </div>)}
    </section>
  </>;
}

function Plugins({ status, busy, onToggleTool, onSave }: { status: AdminStatus; busy: string | null; onToggleTool: (name: string, enabled: boolean) => Promise<void>; onSave: (patch: Record<string, unknown>, success?: string) => Promise<void> }) {
  const [subagentSettingsOpen, setSubagentSettingsOpen] = useState(false);
  const providerSignature = JSON.stringify(status.providers.map((provider) => ({ id: provider.id, enabled: provider.enabled, model: provider.model, effort: provider.effort })));
  const [providerDrafts, setProviderDrafts] = useState<Record<string, { model: string; effort: string }>>({});

  useEffect(() => {
    const next: Record<string, { model: string; effort: string }> = {};
    for (const provider of status.providers) {
      if (!provider.id || provider.enabled !== true) continue;
      next[provider.id] = { model: provider.model ?? "", effort: provider.effort ?? "" };
    }
    setProviderDrafts(next);
  }, [providerSignature]);

  const configuredProviders = status.providers.filter((provider) => provider.id && provider.enabled === true);
  const saveSubagentDefaults = async () => {
    await onSave({
      subagentProviders: configuredProviders.map((provider) => {
        const draft = providerDrafts[provider.id!] ?? { model: provider.model ?? "", effort: provider.effort ?? "" };
        return {
          id: provider.id,
          enabled: true,
          ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
          ...(draft.effort.trim() ? { effort: draft.effort.trim() } : {}),
        };
      }),
    }, "Subagent 默认模型与思考强度已保存");
  };

  const simplePlugins = [
    { id: "widgets", title: "Widgets", version: "built-in", description: "MCP 卡片与交互式结果界面。", enabled: status.settings.widgets !== "off", toggle: (value: boolean) => onSave({ widgets: value ? "full" : "off" }, `Widgets ${value ? "已启用" : "已禁用"}`) },
    { id: "skills", title: "Skills", version: "built-in", description: "发现并加载可调用的本地技能。", enabled: status.settings.skillsEnabled, toggle: (value: boolean) => onSave({ skillsEnabled: value }, `Skills ${value ? "已启用" : "已禁用"}`) },
    { id: "subagents", title: "Subagents", version: "built-in", description: "本地子代理编排与 Provider 调用。", enabled: status.settings.subagentsEnabled, toggle: (value: boolean) => onSave({ subagentsEnabled: value }, `Subagents ${value ? "已启用" : "已禁用"}`) },
    { id: "artifacts", title: "Artifacts", version: "built-in", description: "外部产物下载与工作区接入能力。", enabled: status.settings.artifactsEnabled, toggle: (value: boolean) => onSave({ artifactsEnabled: value }, `Artifacts ${value ? "已启用" : "已禁用"}`) },
  ];
  return <>
    <SectionHeader eyebrow="CAPABILITY MODULES" title="插件与能力" description="第一阶段先管理内置能力和工具开关；安装、删除第三方插件放到 Plugin Registry 阶段。" actions={<button className="secondary" disabled title="Phase 2：Plugin Registry">＋ 添加插件 · Phase 2</button>} />
    <div className="plugin-grid">
      <article className="plugin-card workspace-tools">
        <div className="plugin-heading"><div className="plugin-icon">⌘</div><div><h3>Workspace Tools</h3><small>core / {status.settings.toolMode}</small></div><Toggle checked={status.tools.some((tool) => tool.enabled)} onChange={() => undefined} disabled label="Workspace Tools" /></div>
        <p>控制 ChatGPT 等 MCP Host 实际能看到的核心工作区工具。</p>
        <div className="tool-toggle-grid">{status.tools.map((tool) => <button key={tool.name} disabled={!tool.available || busy !== null} className={tool.enabled ? "on" : "off"} onClick={() => void onToggleTool(tool.name, !tool.enabled)}><span>{tool.enabled ? "●" : "○"}</span>{tool.name}</button>)}</div>
        <footer><span>{status.exposedCoreToolCount} / {status.tools.filter((tool) => tool.available).length} 已启用</span><span>修改后建议重连 MCP</span></footer>
      </article>
      {simplePlugins.map((plugin) => <article className={`plugin-card ${plugin.id === "subagents" && subagentSettingsOpen ? "subagent-card-open" : ""}`} key={plugin.id}>
        <div className="plugin-heading"><div className="plugin-icon">{plugin.id === "widgets" ? "▦" : plugin.id === "skills" ? "✦" : plugin.id === "subagents" ? "◇" : "⬡"}</div><div><h3>{plugin.title}</h3><small>{plugin.version}</small></div><Toggle checked={plugin.enabled} disabled={busy !== null} onChange={(value) => void plugin.toggle(value)} label={plugin.title} /></div>
        <p>{plugin.description}</p>
        <div className="plugin-meta"><span>状态</span><strong>{plugin.enabled ? "Enabled" : "Disabled"}</strong></div>
        {plugin.id === "subagents" && subagentSettingsOpen && <div className="subagent-settings">
          {configuredProviders.length === 0 && <div className="subagent-empty">当前没有启用的 Provider。先在配置中启用一个 Provider。</div>}
          {configuredProviders.map((provider) => {
            const id = provider.id!;
            const draft = providerDrafts[id] ?? { model: provider.model ?? "", effort: provider.effort ?? "" };
            const standardEfforts = ["minimal", "low", "medium", "high", "xhigh", "max"];
            return <div className="subagent-provider-editor" key={id}>
              <div className="subagent-provider-title"><strong>{id}</strong><span>{provider.available ? "Available" : "Unavailable"}</span></div>
              <label><span>默认模型</span><input value={draft.model} placeholder="例如 gpt-5.6-luna" onChange={(event) => setProviderDrafts((current) => ({ ...current, [id]: { ...draft, model: event.target.value } }))} /></label>
              <label><span>思考强度</span><select value={draft.effort} onChange={(event) => setProviderDrafts((current) => ({ ...current, [id]: { ...draft, effort: event.target.value } }))}>
                <option value="">Provider 默认</option>
                {draft.effort && !standardEfforts.includes(draft.effort) && <option value={draft.effort}>{draft.effort}</option>}
                {standardEfforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
              </select></label>
            </div>;
          })}
          <div className="subagent-settings-actions"><span>保存后会自动重启 DevSpace 后端，让新默认值生效。</span><button className="primary" disabled={busy !== null || configuredProviders.length === 0} onClick={() => void saveSubagentDefaults()}>保存设置</button></div>
        </div>}
        <footer><button className="ghost" disabled={plugin.id !== "subagents" || busy !== null} onClick={() => plugin.id === "subagents" && setSubagentSettingsOpen((open) => !open)}>{plugin.id === "subagents" && subagentSettingsOpen ? "收起" : "设置"}</button><span>内置模块</span></footer>
      </article>)}
      {status.providers.map((provider, index) => {
        const id = provider.id || provider.name || `provider-${index}`;
        const active = provider.usable ?? provider.available ?? false;
        return <article className="plugin-card provider-card" key={id}>
          <div className="plugin-heading"><div className="plugin-icon">AI</div><div><h3>{id}</h3><small>{provider.model || "Provider"}</small></div><span className={`provider-dot ${active ? "on" : ""}`} /></div>
          <p>{provider.note || "本地 Agent Provider。"}</p>
          <div className="plugin-meta"><span>可用性</span><strong>{active ? "Available" : "Unavailable"}</strong></div>
          <footer><span>Provider</span><span>{provider.enabled === false ? "配置禁用" : "自动检测"}</span></footer>
        </article>;
      })}
    </div>
  </>;
}

function McpPage({ status, sessions, busy, onReload, onDisconnect, onDisconnectAll }: { status: AdminStatus; sessions: Session[]; busy: string | null; onReload: () => void; onDisconnect: (id: string) => void; onDisconnectAll: () => void }) {
  return <>
    <SectionHeader eyebrow="MCP HOST CONTROL" title="MCP / 会话管理" description="这里直接看 Host 当前拿到的是哪一版 Schema，并可强制重连刷新 tools/list。" actions={<><button className="secondary" disabled={busy !== null} onClick={onReload}>↻ 重新加载工具</button><button className="danger" disabled={sessions.length === 0} onClick={onDisconnectAll}>断开全部会话</button></>} />
    <div className="mcp-summary">
      <div><small>当前 Schema</small><strong>rev {status.schemaRevision}</strong></div>
      <div><small>核心工具</small><strong>{status.exposedCoreToolCount}</strong></div>
      <div><small>活动会话</small><strong>{sessions.length}</strong></div>
      <div><small>Tool Mode</small><strong>{status.settings.toolMode}</strong></div>
    </div>
    <section className="panel table-panel">
      <div className="session-table table-head"><span>Host</span><span>Session ID</span><span>连接时间</span><span>Schema</span><span>最后活动</span><span>操作</span></div>
      {sessions.map((session) => <div className="session-table table-row" key={session.sessionId}>
        <div className="host-cell"><span className="pulse" /><strong>{session.client || "MCP client"}</strong></div>
        <code>{session.sessionId}</code><span>{formatDate(session.connectedAt)}</span><span className={session.schemaRevision === status.schemaRevision ? "schema-current" : "schema-old"}>rev {session.schemaRevision ?? "—"}</span><span>{formatDate(session.lastActivityAt)}</span><button className="danger-soft" onClick={() => onDisconnect(session.sessionId)}>断开</button>
      </div>)}
      {sessions.length === 0 && <div className="empty-block">当前没有活动 MCP 会话。Host 下次连接时会获取 revision {status.schemaRevision}。</div>}
    </section>
    <div className="info-banner"><span>i</span><div><strong>为什么这里需要“重新加载工具”？</strong><p>部分 MCP Host 不会在服务端能力变化后自动重新执行 tools/list。这里会关闭旧会话，让下一次连接从最新 Schema 初始化，避免再次出现 8 个 / 9 个工具不一致。</p></div></div>
  </>;
}

function Workspaces({ projects, total, query, setQuery, onRefresh, onOpen, onCopy }: { projects: Project[]; total: number; query: string; setQuery: (value: string) => void; onRefresh: () => Promise<void>; onOpen: (path: string) => void; onCopy: (path: string) => void }) {
  return <>
    <SectionHeader eyebrow="ALLOWED ROOTS" title="工作区" description="保留原来的项目发现能力，但现在它只是控制台中的一个模块。" actions={<button className="secondary" onClick={() => void onRefresh()}>↻ 重新扫描</button>} />
    <div className="workspace-toolbar"><div><strong>{projects.length}</strong><span>/ {total} 个项目</span></div><label>⌕<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目名称或绝对路径" /></label></div>
    <div className="workspace-list">{projects.map((project) => <article key={project.path}><div className="workspace-mark">▰</div><div><h3>{project.name}</h3><code>{project.path}</code><small>ROOT · {project.root}</small></div><div><button onClick={() => onCopy(project.path)}>复制路径</button><button className="primary" onClick={() => onOpen(project.path)}>打开文件夹 ↗</button></div></article>)}{projects.length === 0 && <div className="empty-block">没有匹配的项目。</div>}</div>
  </>;
}

function Network({ status }: { status: AdminStatus }) {
  const copy = (value: string) => void navigator.clipboard.writeText(value);
  return <>
    <SectionHeader eyebrow="REMOTE ACCESS" title="网络与远程访问" description="集中查看公网入口、MCP 地址和访问边界；Tunnel 的启停在“服务”页控制。" />
    <div className="network-grid">
      <article className="network-card featured"><span className="card-kicker">PUBLIC URL</span><h3>{status.publicBaseUrl}</h3><p>供远程 MCP Host 通过 HTTPS 访问 DevSpace。</p><button onClick={() => copy(status.publicBaseUrl)}>复制公网地址</button></article>
      <article className="network-card"><span className="card-kicker">MCP URL</span><h3>{status.mcpUrl}</h3><p>客户端 MCP Endpoint。</p><button onClick={() => copy(status.mcpUrl)}>复制 MCP URL</button></article>
      <article className="network-card"><span className="card-kicker">ALLOWED HOSTS</span><div className="host-list">{status.allowedHosts.map((host) => <code key={host}>{host}</code>)}</div><p>Host header 访问边界。</p></article>
      <article className="network-card"><span className="card-kicker">OAUTH</span><h3><span className="pulse" /> Enabled</h3><p>单用户 Owner Token OAuth flow；敏感 Token 不在控制台展示。</p><span className="quiet-badge">Protected</span></article>
    </div>
  </>;
}

function Logs({ source, setSource, lines, onRefresh }: { source: "server" | "tunnel" | "agent"; setSource: (value: "server" | "tunnel" | "agent") => void; lines: string[]; onRefresh: () => Promise<void> }) {
  return <>
    <SectionHeader eyebrow="LIVE OUTPUT" title="日志" description="从实际服务日志读取，页面每 2.5 秒刷新一次。" actions={<><select value={source} onChange={(event) => setSource(event.target.value as typeof source)}><option value="server">Supervisor + MCP Server</option><option value="tunnel">Cloudflare Tunnel</option><option value="agent">Agent Daemon</option></select><button className="secondary" onClick={() => void onRefresh()}>↻ 刷新</button></>} />
    <section className="log-console"><header><span className="console-dot red" /><span className="console-dot amber" /><span className="console-dot green" /><strong>{source}.log</strong><small>{lines.length} lines</small></header><pre>{lines.length > 0 ? lines.join("\n") : "暂无日志。"}</pre></section>
  </>;
}

function Settings({ status, roots, setRoots, busy, onAdminMode, onSave }: { status: AdminStatus; roots: string[]; setRoots: (roots: string[]) => void; busy: string | null; onAdminMode: (enabled: boolean) => Promise<void>; onSave: (patch: Record<string, unknown>) => Promise<void> }) {
  const [toolMode, setToolMode] = useState<ToolMode>(status.settings.toolMode);
  const [widgets, setWidgets] = useState<WidgetMode>(status.settings.widgets);
  useEffect(() => { setToolMode(status.settings.toolMode); setWidgets(status.settings.widgets); }, [status.settings.toolMode, status.settings.widgets]);
  const save = () => onSave({ allowedRoots: roots.filter((root) => root.trim()), toolMode, widgets });
  return <>
    <SectionHeader eyebrow="PERSISTED CONFIG" title="设置" description="这些设置会写入 ~/.devspace/config.json；环境变量仍具有更高优先级。" actions={<button className="primary" disabled={busy !== null || roots.every((root) => !root.trim())} onClick={() => void save()}>保存设置</button>} />
    <div className="settings-grid">
      <section className="panel settings-panel wide"><div className="settings-title"><div><h2>Allowed Roots</h2><p>允许 DevSpace 打开工作区的文件系统边界。</p></div><button className="secondary" onClick={() => setRoots([...roots, ""])}>＋ 添加 Root</button></div>
        <div className="root-editor">{roots.map((root, index) => <div key={`${index}:${root}`}><input value={root} placeholder="E:\\Projects" onChange={(event) => setRoots(roots.map((value, position) => position === index ? event.target.value : value))} /><button className="danger-soft" disabled={roots.length <= 1} onClick={() => setRoots(roots.filter((_, position) => position !== index))}>删除</button></div>)}</div>
      </section>
      <section className="panel settings-panel wide permission-panel">
        <div className="settings-title"><div><h2>权限与启动</h2><p>切换 Windows 计划任务的 RunLevel。开启后 Supervisor 与它启动的 MCP Server 都会继承管理员令牌。</p></div></div>
        {status.privileges ? <div className="permission-console">
          <div className="permission-console-title">Windows 权限</div>
          <div className="permission-row"><span>Supervisor</span><strong className={status.privileges.supervisor === "administrator" ? "admin" : "limited"}>{privilegeLabel(status.privileges.supervisor)}</strong></div>
          <div className="permission-row"><span>MCP Server</span><strong className={status.privileges.mcpServer === "administrator" ? "admin" : "limited"}>{status.backendRunning ? privilegeLabel(status.privileges.mcpServer) : "Stopped"}</strong></div>
          <div className="permission-separator" />
          <div className="permission-row admin-mode-row"><span>管理员模式</span><strong className={status.privileges.adminMode ? "admin" : "limited"}>{status.privileges.adminMode ? "ON" : "OFF"}</strong></div>
          <div className="permission-task-meta"><span>DevSpace Server RunLevel</span><code>{status.privileges.taskRunLevel === "highest" ? "Highest" : status.privileges.taskRunLevel === "limited" ? "Limited" : status.privileges.taskRunLevel}</code></div>
          <button className={status.privileges.adminMode ? "danger-soft admin-mode-button" : "primary admin-mode-button"} disabled={!status.privileges.supported || busy === "admin-mode"} onClick={() => void onAdminMode(!status.privileges!.adminMode)}>{busy === "admin-mode" ? "正在切换…" : status.privileges.adminMode ? "关闭管理员模式" : "启用管理员模式"}</button>
        </div> : <div className="permission-console"><div className="empty-inline">权限状态不可用。</div></div>}
        <div className="permission-warning"><span>!</span><p><strong>这是全局权限模式。</strong>开启后所有连接到当前 DevSpace MCP Server 的对话和工具调用都会获得管理员权限，不是仅当前对话。启用时 Windows 会弹出一次 UAC；批准后页面会短暂断线并自动恢复。</p></div>
      </section>
      <section className="panel settings-panel"><h2>MCP Tool Mode</h2><p>决定默认工具面。Full 对应当前 9 个核心工具。</p><select value={toolMode} onChange={(event) => setToolMode(event.target.value as ToolMode)}><option value="minimal">minimal · 精简</option><option value="full">full · 完整</option><option value="codex">codex · Codex 兼容</option></select><div className="setting-current"><span>当前运行值</span><strong>{status.settings.toolMode}</strong></div></section>
      <section className="panel settings-panel"><h2>Widget Mode</h2><p>控制 MCP 工具结果是否附带 DevSpace 卡片。</p><select value={widgets} onChange={(event) => setWidgets(event.target.value as WidgetMode)}><option value="full">full · 完整卡片</option><option value="changes">changes · 变更审阅</option><option value="off">off · 关闭</option></select><div className="setting-current"><span>当前运行值</span><strong>{status.settings.widgets}</strong></div></section>
      <section className="panel settings-panel system-info"><h2>运行信息</h2><dl><div><dt>Version</dt><dd>{status.version}</dd></div><div><dt>Supervisor PID</dt><dd>{status.supervisor?.pid ?? "—"}</dd></div><div><dt>MCP PID</dt><dd>{status.pid || "Stopped"}</dd></div><div><dt>Public Port</dt><dd>{status.supervisor?.port ?? status.port}</dd></div><div><dt>Backend Port</dt><dd>{status.supervisor?.backendPort ?? "—"}</dd></div><div><dt>Schema</dt><dd>rev {status.schemaRevision}</dd></div><div><dt>MCP Uptime</dt><dd>{status.backendRunning ? formatDuration(status.uptimeSeconds) : "Stopped"}</dd></div></dl></section>
    </div>
    <div className="warning-banner"><span>!</span><p><strong>配置生效方式：</strong>Supervisor 会持久化设置；运行时配置发生变化时会自动重启 MCP 子进程。工具 Schema 变化会断开现有 MCP Session，客户端需要重新连接后获取最新 tools/list。</p></div>
  </>;
}

createRoot(document.getElementById("app")!).render(<App />);
