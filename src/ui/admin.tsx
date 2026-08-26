import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./admin.css";

type Project = { name: string; path: string; root: string };

function AdminApp() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<{ publicBaseUrl: string; allowedRoots: string[] } | null>(null);
  const [notice, setNotice] = useState("");
  const filtered = useMemo(() => projects.filter((p) => `${p.name} ${p.path}`.toLowerCase().includes(query.toLowerCase())), [projects, query]);
  const load = async () => {
    const [p, s] = await Promise.all([fetch("/api/admin/projects").then((r) => r.json()), fetch("/api/admin/status").then((r) => r.json())]);
    setProjects(p.projects ?? []); setStatus(s);
  };
  useEffect(() => { void load(); }, []);
  const copy = async (path: string) => { await navigator.clipboard.writeText(path); setNotice("路径已复制"); setTimeout(() => setNotice(""), 1800); };
  const open = async (path: string) => { const r = await fetch("/api/admin/open-folder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) }); setNotice(r.ok ? "已在资源管理器打开" : "打开失败"); setTimeout(() => setNotice(""), 1800); };
  return <div className="admin-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark">⌁</span><span>DEVSPACE</span><small>LOCAL CONTROL</small></div><div className="live"><i /> LOCAL SERVER ONLINE</div></header>
    <section className="hero"><div><p className="eyebrow">你的电脑 · 受控工作区</p><h1>把项目，放在<br /><em>手边。</em></h1><p className="lede">浏览允许访问的项目目录，复制路径，或直接在 Windows 资源管理器中打开。</p></div><div className="orb"><span>DS</span><b>/{projects.length.toString().padStart(2, "0")}</b></div></section>
    <section className="toolbar"><div><strong>项目目录</strong><span>{filtered.length} / {projects.length} 个可用项目</span></div><label>⌕ <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索项目名称或路径" /></label><button onClick={() => void load()}>↻ 刷新</button></section>
    <main className="project-grid">{filtered.map((p) => <article className="project" key={p.path}><div className="project-icon">▰</div><div className="project-info"><h2>{p.name}</h2><p>{p.path}</p><small>ROOT · {p.root}</small></div><div className="actions"><button onClick={() => void copy(p.path)}>复制路径</button><button className="primary" onClick={() => void open(p.path)}>打开文件夹 ↗</button></div></article>)}{filtered.length === 0 && <div className="empty">没有匹配的项目。试试清空搜索词。</div>}</main>
    <footer><span>DEVSPACE / LOCALHOST</span><span>{status?.allowedRoots?.join(" · ")}</span><span>{notice || "仅本机可访问"}</span></footer>
  </div>;
}

createRoot(document.getElementById("app")!).render(<AdminApp />);
