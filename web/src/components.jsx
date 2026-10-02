import React from 'react';
import { Link, NavLink } from 'react-router-dom';
import { ArrowRight, Check, CircleAlert, LoaderCircle, Moon, Music2, Sun, X } from 'lucide-react';

export function Brand({ compact = false }) {
  return <Link to="/" className="brand" aria-label="MusicMove home"><span className="brand-mark"><Music2 size={18} /></span>{!compact && <span>MusicMove</span>}</Link>;
}

export function ThemeButton({ theme, setTheme }) {
  return <button className="icon-button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button>;
}

export function PublicHeader({ theme, setTheme }) {
  return <header className="public-header wrap"><Brand /><nav><Link to="/login" className="button ghost small">Sign in</Link><ThemeButton theme={theme} setTheme={setTheme} /></nav></header>;
}

export function AppShell({ children, theme, setTheme }) {
  return <div className="app-frame">
    <aside className="sidebar">
      <Brand />
      <nav className="side-nav" aria-label="Main navigation">
        <NavLink to="/migrate">Move music</NavLink>
        <NavLink to="/history">History</NavLink>
        <NavLink to="/connections">Connections</NavLink>
        <NavLink to="/settings">Settings</NavLink>
      </nav>
      <div className="sidebar-footer"><ThemeButton theme={theme} setTheme={setTheme} /><span>Theme</span></div>
    </aside>
    <div className="mobile-bar"><Brand compact /><nav><NavLink to="/migrate">Move</NavLink><NavLink to="/history">History</NavLink><NavLink to="/settings">Settings</NavLink></nav></div>
    <main className="app-main">{children}</main>
  </div>;
}

export function Button({ children, variant = 'primary', loading = false, icon, ...props }) {
  return <button className={`button ${variant}`} disabled={loading || props.disabled} {...props}>{loading ? <LoaderCircle className="spin" size={17} /> : icon}{children}</button>;
}

export function PageHeader({ eyebrow, title, description, action }) {
  return <div className="page-header"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>;
}

export function ProviderIcon({ provider }) {
  return <span className={`provider-icon ${provider}`} aria-hidden="true">{provider === 'spotify' ? 'S' : '▶'}</span>;
}

const connectionLabels = {
  not_connected: 'Not connected',
  connected: 'Connected',
  expired_refreshable: 'Expired · refresh available',
  authentication_invalid: 'Authentication revoked or invalid',
  reconnect_required: 'Reconnect required',
};

export function ProviderCard({ provider, name, connected, usable, status = connected ? 'connected' : 'not_connected', accountName, href, onDisconnect }) {
  const needsReconnect = connected && !usable;
  return <article className="provider-card">
    <div className="provider-copy"><ProviderIcon provider={provider} /><div><h3>{name}</h3><p>{connected ? accountName || 'Connected account' : `Connect your ${name} account`}</p></div></div>
    <div className={`status-pill ${usable ? 'connected' : status}`}>{usable && <Check size={14} />}{connectionLabels[status] || 'Reconnect required'}</div>
    <div className="provider-action">{needsReconnect || !connected ? <a className="button secondary small" href={href}>{needsReconnect ? 'Reconnect' : 'Connect'} <ArrowRight size={15} /></a> : <button className="text-button danger" onClick={onDisconnect}>Disconnect</button>}</div>
  </article>;
}

export function Notice({ type = 'info', children, action }) {
  const Icon = type === 'success' ? Check : type === 'error' ? X : CircleAlert;
  return <div className={`notice ${type}`}><Icon size={18} /><div>{children}</div>{action}</div>;
}

export function ProgressBar({ value }) {
  const normalized = Math.max(0, Math.min(100, Number(value) || 0));
  return <div className="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(normalized)}><span style={{ width: `${normalized}%` }} /></div>;
}

export function Stat({ value, label, tone = '' }) {
  return <div className={`stat ${tone}`}><strong>{Number(value || 0).toLocaleString()}</strong><span>{label}</span></div>;
}

export function EmptyState({ title, children, action }) {
  return <div className="empty-state"><span className="empty-icon"><Music2 size={23} /></span><h2>{title}</h2><p>{children}</p>{action}</div>;
}

export function ErrorPanel({ error, onRetry }) {
  if (!error) return null;
  return <Notice type="error" action={onRetry && <button className="text-button" onClick={onRetry}>Try again</button>}>{error.message || String(error)}</Notice>;
}

export function LoadingPage({ label = 'Loading your music…' }) {
  return <div className="center-state"><LoaderCircle className="spin" size={28} /><p>{label}</p></div>;
}

export function formatDuration(ms) {
  if (!ms) return '—';
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function providerLabel(source, destination) {
  return `${source === 'spotify' ? 'Spotify' : source} → ${destination === 'youtube_music' ? 'YouTube Music' : destination}`;
}
