import React from 'react';
import { Routes, Route, Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowLeft, ArrowRight, Check, ChevronRight, Clock3, ExternalLink, Keyboard, LockKeyhole, Music2, Pause, Play, RefreshCw, Search, ShieldCheck, SkipForward, Sparkles, Trash2 } from 'lucide-react';
import { api, providerUrl } from './api';
import { AuthProvider, RequireAuth, useAuth, useMigration } from './hooks';
import { AppShell, Brand, Button, EmptyState, ErrorPanel, LoadingPage, Notice, PageHeader, ProgressBar, ProviderCard, ProviderIcon, PublicHeader, Stat, ThemeButton, formatDuration, providerLabel } from './components';

function Landing({ theme, setTheme }) {
  return <div className="landing">
    <PublicHeader theme={theme} setTheme={setTheme} />
    <main>
      <section className="hero wrap">
        <div className="hero-badge"><Sparkles size={14} /> Your likes deserve to travel</div>
        <h1>Your music, wherever<br />you want it.</h1>
        <p className="hero-copy">Move your Spotify liked songs to YouTube Music in a few clicks.</p>
        <div className="hero-actions"><Link className="button primary large" to="/login">Get started <ArrowRight size={18} /></Link><a className="button ghost large" href="#how">See how it works</a></div>
        <p className="hero-note">No playlists. No manual searching. Just your liked songs.</p>
        <TransferVisual />
      </section>
      <section className="how-section wrap" id="how">
        <div className="section-heading"><span className="eyebrow">Simple by design</span><h2>From liked to loved—without the busywork.</h2></div>
        <div className="steps-grid">
          <Step number="01" title="Connect" text="Sign in directly with Spotify and Google. We never ask for your passwords or browser cookies." />
          <Step number="02" title="Preview" text="We scan and score each possible match. Anything uncertain waits for your review." />
          <Step number="03" title="Move" text="Confident matches are liked for you while progress stays safely saved." />
        </div>
      </section>
      <section className="privacy-section wrap">
        <div className="privacy-icon"><ShieldCheck size={28} /></div>
        <div><span className="eyebrow">Privacy first</span><h2>Authorization, without awkward workarounds.</h2><p>MusicMove uses provider OAuth. Passwords are entered only on Spotify or Google, access tokens stay encrypted on the server, and the browser never receives provider credentials.</p></div>
        <div className="privacy-points"><span><Check size={15} /> No password collection</span><span><Check size={15} /> No copied cookies</span><span><Check size={15} /> Disconnect anytime</span></div>
      </section>
    </main>
    <footer className="wrap footer"><Brand /><span>Move music, keep the feeling.</span></footer>
  </div>;
}

function TransferVisual() {
  return <div className="transfer-card" aria-label="Spotify to YouTube Music transfer illustration">
    <div className="transfer-provider"><ProviderIcon provider="spotify" /><div><strong>Spotify</strong><span>Liked songs</span></div></div>
    <div className="transfer-line"><span /><div className="moving-note"><Music2 size={15} /></div><ArrowRight size={19} /></div>
    <div className="transfer-provider"><ProviderIcon provider="youtube" /><div><strong>YouTube Music</strong><span>Your library</span></div></div>
    <div className="floating-chip chip-one">♪ Midnight City</div><div className="floating-chip chip-two">♪ Blinding Lights</div>
  </div>;
}

function Step({ number, title, text }) { return <article className="step"><span>{number}</span><h3>{title}</h3><p>{text}</p></article>; }

function Login({ theme, setTheme }) {
  const { user } = useAuth();
  if (user) return <Navigate to="/connections" replace />;
  return <div className="auth-page">
    <div className="auth-top"><Brand /><ThemeButton theme={theme} setTheme={setTheme} /></div>
    <div className="auth-card">
      <div className="auth-icon"><Music2 size={25} /></div><h1>Bring your music with you</h1><p>Connect either account to get started. You can add the other one next.</p>
      <a href={providerUrl('spotify')} className="oauth-button spotify"><ProviderIcon provider="spotify" /><span>Continue with Spotify</span><ChevronRight size={18} /></a>
      <a href={providerUrl('google')} className="oauth-button google"><ProviderIcon provider="youtube" /><span>Continue with Google</span><ChevronRight size={18} /></a>
      <div className="auth-fine"><LockKeyhole size={14} /> Secure OAuth — your passwords never touch MusicMove.</div>
    </div>
    <Link to="/" className="back-link"><ArrowLeft size={15} /> Back home</Link>
  </div>;
}

function Connections() {
  const [connections, setConnections] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [params] = useSearchParams();
  const load = React.useCallback(() => api('/connections').then(setConnections).catch(setError), []);
  React.useEffect(() => { load(); }, [load]);
  const disconnect = async (provider) => { if (!window.confirm(`Disconnect ${provider === 'spotify' ? 'Spotify' : 'YouTube Music'}? Active migrations may pause.`)) return; await api(`/connections/${provider}`, { method: 'DELETE' }); load(); };
  if (!connections && !error) return <LoadingPage label="Checking your connections…" />;
  const ready = connections?.spotify.usable && connections?.youtube.usable;
  return <div className="page narrow">
    <PageHeader eyebrow="Accounts" title="Connect your music" description="Both accounts are needed before anything is moved." />
    {params.get('connected') && <Notice type="success">Account connected successfully.</Notice>}
    {params.get('auth_error') && <Notice type="error">Connection was cancelled. Nothing was changed.</Notice>}
    <ErrorPanel error={error} onRetry={load} />
    {connections && <div className="provider-stack">
      <ProviderCard provider="spotify" name="Spotify" {...connections.spotify} href={providerUrl('spotify')} onDisconnect={() => disconnect('spotify')} />
      <div className="connector-arrow"><ArrowDown size={17} /></div>
      <ProviderCard provider="youtube" name="YouTube Music" {...connections.youtube} href={providerUrl('google')} onDisconnect={() => disconnect('youtube')} />
    </div>}
    <div className="page-actions"><Link className={`button primary large ${!ready ? 'disabled' : ''}`} aria-disabled={!ready} to={ready ? '/migrate' : '#'}>Continue <ArrowRight size={18} /></Link></div>
    <p className="center-fine">You can disconnect either account from Settings at any time.</p>
  </div>;
}

function MigrationSetup() {
  const navigate = useNavigate();
  const [connections, setConnections] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [trackLimit, setTrackLimit] = React.useState('full');
  React.useEffect(() => { api('/connections').then(setConnections).catch(setError); }, []);
  React.useEffect(() => { if (connections?.migrationLimits.maximum) setTrackLimit('1'); }, [connections]);
  const start = async () => {
    setLoading(true); setError(null);
    try { const { migration } = await api('/migrations', { method: 'POST', body: { trackLimit: trackLimit === 'full' ? null : Number(trackLimit) } }); await api(`/migrations/${migration.id}/scan`, { method: 'POST' }); navigate(`/migrations/${migration.id}/scan`); }
    catch (nextError) { setError(nextError); setLoading(false); }
  };
  if (!connections && !error) return <LoadingPage />;
  const ready = connections?.spotify.usable && connections?.youtube.usable;
  const maximum = connections?.migrationLimits.maximum;
  return <div className="page narrow">
    <PageHeader eyebrow="New migration" title="Move your liked songs" description="We'll scan first. Nothing changes in YouTube Music until you approve the preview." />
    <ErrorPanel error={error} />
    {!ready && <Notice action={<Link to="/connections" className="text-button">Connect accounts</Link>}>Connect both accounts to continue.</Notice>}
    <div className="route-card">
      <div className="route-end"><ProviderIcon provider="spotify" /><div><span>Source</span><strong>Spotify</strong><small>{connections?.spotify.accountName || 'Liked songs'}</small></div></div>
      <div className="route-path"><span /><ArrowRight size={18} /></div>
      <div className="route-end"><ProviderIcon provider="youtube" /><div><span>Destination</span><strong>YouTube Music</strong><small>{connections?.youtube.accountName || 'Your library'}</small></div></div>
    </div>
    <div className="explain-list"><div><Search size={18} /><span><strong>Scan before moving</strong><small>See confident and ambiguous matches first.</small></span></div><div><ShieldCheck size={18} /><span><strong>Conservative matching</strong><small>Uncertain choices always wait for you.</small></span></div><div><Clock3 size={18} /><span><strong>Progress is saved</strong><small>Close the tab and return whenever you like.</small></span></div></div>
    <label className="limit-control"><span><strong>Migration scope</strong><small>{maximum ? `This environment enforces a maximum of ${maximum} tracks.` : 'Choose a controlled preview or your full library.'}</small></span><select value={trackLimit} onChange={(event) => setTrackLimit(event.target.value)}><option value="1">1 track</option>{(!maximum || maximum >= 3) && <option value="3">3 tracks</option>}{!maximum && <option value="full">Full library</option>}</select></label>
    <div className="page-actions"><Button variant="primary large" disabled={!ready} loading={loading} onClick={start}>Start scan <ArrowRight size={18} /></Button></div>
  </div>;
}

function ScanPage() {
  const { id } = useParams(); const navigate = useNavigate(); const { migration, error } = useMigration(id);
  React.useEffect(() => {
    if (migration?.status === 'ready') navigate(`/migrations/${id}/preview`, { replace: true });
    else if (migration && migration.status !== 'scanning' && migration.status !== 'draft') navigate(`/migrations/${id}/progress`, { replace: true });
  }, [migration, id, navigate]);
  if (!migration) return error ? <ErrorPanel error={error} /> : <LoadingPage label="Preparing your scan…" />;
  const pct = migration.totalTracks ? migration.processedTracks / migration.totalTracks * 100 : 0;
  return <div className="focus-page"><div className="scan-orbit"><span /><ProviderIcon provider="spotify" /><ProviderIcon provider="youtube" /></div><div className="eyebrow">Scanning</div><h1>Finding your music…</h1><p>We're comparing your Spotify likes with YouTube Music. This can take a while; it is safe to leave this page.</p><div className="focus-progress"><ProgressBar value={pct} /><div><strong>{migration.processedTracks.toLocaleString()} / {migration.totalTracks ? migration.totalTracks.toLocaleString() : '…'}</strong><span>{Math.round(pct)}%</span></div></div>{migration.currentTrack && <div className="current-track"><span className="playing-bars"><i/><i/><i/></span><div><small>Now scanning</small><strong>{migration.currentTrack.title}</strong><span>{migration.currentTrack.artist}</span></div></div>}<ErrorPanel error={migration.error || error} /></div>;
}

function PreviewPage() {
  const { id } = useParams(); const navigate = useNavigate(); const { migration, error } = useMigration(id); const [loading, setLoading] = React.useState(false);
  if (!migration) return error ? <ErrorPanel error={error} /> : <LoadingPage />;
  const start = async () => { setLoading(true); try { await api(`/migrations/${id}/start`, { method: 'POST' }); navigate(`/migrations/${id}/progress`); } catch { setLoading(false); } };
  return <div className="page narrow"><PageHeader eyebrow="Scan complete" title="Ready to migrate" description={`${migration.totalTracks.toLocaleString()} Spotify tracks scanned. Review the plan before anything changes.`} />
    {migration.limited && <Notice>This controlled run includes {migration.totalTracks.toLocaleString()} of {migration.sourceTotalTracks.toLocaleString()} source tracks. Completion applies only to this explicitly selected scope.</Notice>}
    <div className="summary-hero"><div className="summary-number">{migration.totalTracks.toLocaleString()}</div><span>liked songs found</span><div className="summary-stats"><Stat value={migration.confidentCount} label="confident matches" tone="green" /><Stat value={migration.reviewCount} label="need review" tone="amber" /><Stat value={migration.notFoundCount} label="not found" /></div></div>
    <Notice>Ambiguous tracks won't be changed automatically. You can choose them after the confident matches finish.</Notice>
    <div className="quota-note"><Clock3 size={17} /><p><strong>A note about YouTube limits</strong><br />YouTube limits how many likes an app can apply each day. If the quota is reached, we'll pause safely and let you resume later.</p></div>
    <div className="page-actions split"><Link className="button ghost" to="/migrate">Cancel</Link><Button variant="primary large" loading={loading} onClick={start}>Start migration <ArrowRight size={18} /></Button></div>
    <TrackStatusPanel migrationId={id} updatedAt={migration.updatedAt} />
  </div>;
}

function ProgressPage() {
  const { id } = useParams(); const navigate = useNavigate(); const { migration, error, refresh } = useMigration(id); const [working, setWorking] = React.useState(false);
  React.useEffect(() => { if (migration?.status === 'completed') navigate(`/migrations/${id}/complete`, { replace: true }); }, [migration, id, navigate]);
  if (!migration) return error ? <ErrorPanel error={error} /> : <LoadingPage />;
  const pct = migration.totalTracks ? migration.processedTracks / migration.totalTracks * 100 : 0;
  const action = async (name) => { setWorking(true); try { await api(`/migrations/${id}/${name}`, { method: 'POST' }); await refresh(); } finally { setWorking(false); } };
  const paused = ['paused', 'authentication_required', 'quota_paused', 'failed'].includes(migration.status);
  return <div className="page progress-page"><PageHeader eyebrow={paused ? 'Progress saved' : 'In progress'} title={paused ? 'Migration paused' : 'Migrating your music'} description={paused ? migration.error?.message || 'Resume whenever you are ready.' : 'You can close this tab. The migration continues on the server.'} action={!paused ? <Button variant="secondary" loading={working} onClick={() => action('pause')} icon={<Pause size={16} />}>Pause</Button> : null} />
    {migration.status === 'authentication_required' && <Notice type="error" action={<Link className="button secondary small" to="/connections">Reconnect</Link>}>YouTube Music needs to be connected again.</Notice>}
    {migration.status === 'quota_paused' && <Notice>Daily YouTube API quota reached. No progress was lost.</Notice>}
    <div className="progress-card"><div className="big-percent">{Math.round(pct)}<span>%</span></div><ProgressBar value={pct} /><div className="progress-count"><strong>{migration.processedTracks.toLocaleString()} / {migration.totalTracks.toLocaleString()}</strong><span>tracks processed</span></div><div className="metric-row"><Stat value={migration.likedCount} label="added" tone="green" /><Stat value={migration.alreadyLikedCount} label="already liked" /><Stat value={migration.reviewCount} label="review" tone="amber" /><Stat value={migration.failedCount} label="failed" tone={migration.failedCount ? 'red' : ''} /></div></div>
    {migration.currentTrack && <div className="current-track wide"><span className="album-placeholder"><Music2 size={21} /></span><div><small>Current track</small><strong>{migration.currentTrack.title}</strong><span>{migration.currentTrack.artist}</span></div><span className="playing-bars"><i/><i/><i/></span></div>}
    {paused && <div className="page-actions"><Button variant="primary large" loading={working} onClick={() => action('resume')} icon={<Play size={17} />}>Resume migration</Button></div>}
    <TrackStatusPanel migrationId={id} updatedAt={migration.updatedAt} />
  </div>;
}

function CompletePage() {
  const { id } = useParams(); const navigate = useNavigate(); const { migration, error } = useMigration(id); const [retrying, setRetrying] = React.useState(false);
  if (!migration) return error ? <ErrorPanel error={error} /> : <LoadingPage />;
  const retry = async () => { setRetrying(true); try { await api(`/migrations/${id}/retry`, { method: 'POST' }); navigate(`/migrations/${id}/progress`); } finally { setRetrying(false); } };
  return <div className="focus-page complete"><div className="success-mark"><Check size={34} /></div><div className="eyebrow">All confident matches processed</div><h1>Your migration is complete.</h1><p>{migration.totalTracks.toLocaleString()} tracks in this migration were processed. {migration.limited && `${migration.sourceTotalTracks.toLocaleString()} tracks exist in the source library; this completion covers only the selected staging scope.`} Your ambiguous matches are still waiting safely for you.</p><div className="completion-grid"><Stat value={migration.likedCount} label="added" tone="green" /><Stat value={migration.alreadyLikedCount} label="already existed" /><Stat value={migration.reviewCount} label="need review" tone="amber" /><Stat value={migration.failedCount} label="failed" tone={migration.failedCount ? 'red' : ''} /></div><div className="hero-actions">{migration.reviewCount > 0 && <Link className="button primary large" to={`/migrations/${id}/review`}>Review {migration.reviewCount.toLocaleString()} matches <ArrowRight size={18} /></Link>}{migration.failedCount > 0 && <Button variant="secondary large" loading={retrying} onClick={retry} icon={<RefreshCw size={17} />}>Retry failed</Button>}<Link className="button ghost large" to={`/migrations/${id}`}>View migration</Link></div><TrackStatusPanel migrationId={id} updatedAt={migration.updatedAt} /></div>;
}

const trackStatusLabels = {
  pending: 'Pending', scanning: 'Scanning', ready: 'Ready to like', review: 'Review needed',
  liking: 'Liking', liked: 'Liked', already_liked: 'Already liked', skipped: 'Skipped',
  not_found: 'Not found', failed: 'Failed',
};

function TrackStatusPanel({ migrationId, updatedAt }) {
  const [tracks, setTracks] = React.useState([]);
  const [total, setTotal] = React.useState(0);
  React.useEffect(() => {
    let active = true;
    api(`/migrations/${migrationId}/tracks?page=1&limit=100`).then((body) => {
      if (active) { setTracks(body.tracks); setTotal(body.total); }
    }).catch(() => {});
    return () => { active = false; };
  }, [migrationId, updatedAt]);
  if (!tracks.length) return null;
  return <section className="track-status-panel"><div className="track-status-heading"><h2>Track status</h2>{total > tracks.length && <span>Showing {tracks.length} of {total}</span>}</div>{tracks.map((track) => <div className="track-status-row" key={track.id}><span><strong>{track.spotify.title}</strong><small>{track.spotify.artists.join(', ')}</small></span><span className={`status-pill ${track.status}`}>{trackStatusLabels[track.status] || track.status.replaceAll('_', ' ')}</span></div>)}</section>;
}

function ReviewPage() {
  const { id } = useParams();
  const [data, setData] = React.useState(null); const [error, setError] = React.useState(null); const [busy, setBusy] = React.useState(false); const [query, setQuery] = React.useState('');
  const load = React.useCallback(() => api(`/migrations/${id}/reviews?page=1&limit=1`).then(setData).catch(setError), [id]);
  React.useEffect(() => { load(); }, [load]);
  const track = data?.reviews?.[0];
  const choose = React.useCallback(async (candidateId) => { if (!track || busy) return; setBusy(true); try { await api(`/migrations/${id}/reviews/${track.id}/choose`, { method: 'POST', body: { candidateId } }); await load(); } catch (next) { setError(next); } finally { setBusy(false); } }, [busy, id, load, track]);
  const skip = React.useCallback(async () => { if (!track || busy) return; setBusy(true); try { await api(`/migrations/${id}/reviews/${track.id}/skip`, { method: 'POST' }); await load(); } finally { setBusy(false); } }, [busy, id, load, track]);
  React.useEffect(() => { const handler = (event) => { if (event.target.matches('input, textarea')) return; const number = Number(event.key); if (number >= 1 && number <= (track?.candidates.length || 0)) choose(track.candidates[number - 1].id); if (event.key.toLowerCase() === 's') skip(); }; window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler); }, [choose, skip, track]);
  const search = async (event) => { event.preventDefault(); setBusy(true); try { const result = await api(`/migrations/${id}/reviews/${track.id}/search`, { method: 'POST', body: { query } }); setData((old) => ({ ...old, reviews: [result.review] })); } catch (next) { setError(next); } finally { setBusy(false); } };
  if (!data) return error ? <ErrorPanel error={error} /> : <LoadingPage label="Loading review queue…" />;
  if (!track) return <div className="page narrow"><EmptyState title="Review queue cleared" action={<Link className="button primary" to={`/migrations/${id}/complete`}>Back to summary</Link>}>Every ambiguous match has been chosen or skipped.</EmptyState></div>;
  return <div className="page review-page"><div className="review-top"><Link to={`/migrations/${id}/complete`} className="back-link"><ArrowLeft size={16} /> Summary</Link><span>{data.total.toLocaleString()} remaining</span></div><div className="review-layout"><section className="review-source"><div className="eyebrow">Spotify track</div><span className="review-art"><Music2 size={33} /></span><h1>{track.spotify.title}</h1><p>{track.spotify.artists.join(', ')}</p><dl><div><dt>Duration</dt><dd>{formatDuration(track.spotify.durationMs)}</dd></div>{track.spotify.album && <div><dt>Album</dt><dd>{track.spotify.album}</dd></div>}</dl><Notice>This match wasn't confident enough to automatically choose. {track.reason}</Notice></section><section className="candidate-panel"><div className="candidate-heading"><div><span className="eyebrow">Possible matches</span><h2>Choose the right version</h2></div><span className="shortcut"><Keyboard size={15} /> Keys 1–9</span></div><div className="candidate-list">{track.candidates.map((candidate, index) => <article className="candidate" key={candidate.id}><button disabled={busy} onClick={() => choose(candidate.id)} className="candidate-main"><span className="candidate-radio">{index + 1}</span><span><strong>{candidate.title}</strong><small>{candidate.artists.join(', ') || 'Unknown artist'} · {formatDuration(candidate.durationMs)} {candidate.resultType && `· ${candidate.resultType}`}</small></span><span className="score">{Math.round(candidate.score * 100)}%</span></button><a href={candidate.externalUrl} target="_blank" rel="noreferrer" aria-label="Open in YouTube Music"><ExternalLink size={16} /></a></article>)}</div><form className="manual-search" onSubmit={search}><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search YouTube Music manually" aria-label="Manual search" /><button disabled={busy || query.length < 2}>Search</button></form><div className="review-actions"><Button variant="ghost" disabled={busy} onClick={skip} icon={<SkipForward size={16} />}>Skip <kbd>S</kbd></Button><span>Choosing a result queues it to be liked securely.</span></div></section></div></div>;
}

function History() {
  const [items, setItems] = React.useState(null); const [error, setError] = React.useState(null);
  React.useEffect(() => { api('/migrations').then((body) => setItems(body.migrations)).catch(setError); }, []);
  if (!items) return error ? <ErrorPanel error={error} /> : <LoadingPage />;
  return <div className="page"><PageHeader eyebrow="Activity" title="Migration history" description="Your scans, active migrations, and completed moves." action={<Link className="button primary" to="/migrate">New migration</Link>} />{!items.length ? <EmptyState title="No migrations yet" action={<Link className="button primary" to="/migrate">Move your music</Link>}>Your migration history will appear here.</EmptyState> : <div className="history-list">{items.map((item) => <Link to={migrationLink(item)} className="history-row" key={item.id}><span className={`history-status ${item.status}`}><Music2 size={18} /></span><span className="history-main"><strong>{providerLabel(item.source, item.destination)}</strong><small>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(item.createdAt))}</small></span><span className="history-count"><strong>{item.totalTracks.toLocaleString()}</strong><small>tracks</small></span><span className={`status-pill ${item.status}`}>{item.status.replaceAll('_', ' ')}</span><ChevronRight size={17} /></Link>)}</div>}</div>;
}

function migrationLink(item) { if (item.status === 'draft' || item.status === 'scanning') return `/migrations/${item.id}/scan`; if (item.status === 'ready') return `/migrations/${item.id}/preview`; if (item.status === 'completed') return `/migrations/${item.id}/complete`; return `/migrations/${item.id}/progress`; }

function MigrationDetails() { const { id } = useParams(); const { migration, error } = useMigration(id); if (!migration) return error ? <ErrorPanel error={error} /> : <LoadingPage />; return <Navigate to={migrationLink(migration)} replace />; }

function Settings() {
  const { refresh } = useAuth(); const navigate = useNavigate(); const [connections, setConnections] = React.useState(null); const [error, setError] = React.useState(null);
  const load = React.useCallback(() => api('/connections').then(setConnections).catch(setError), []); React.useEffect(() => { load(); }, [load]);
  const disconnect = async (provider) => { if (!window.confirm('Disconnect this account? Active migrations may pause.')) return; await api(`/connections/${provider}`, { method: 'DELETE' }); load(); };
  const logout = async () => { await api('/logout', { method: 'POST' }); await refresh(); navigate('/'); };
  const remove = async () => { if (!window.confirm('Permanently delete your MusicMove account, connections, and migration data? This cannot be undone.')) return; await api('/account', { method: 'DELETE' }); await refresh(); navigate('/'); };
  return <div className="page narrow"><PageHeader eyebrow="Account" title="Settings" description="Manage connected accounts and your MusicMove data." /><ErrorPanel error={error} />
    <section className="settings-section"><h2>Connected accounts</h2>{connections && <div className="settings-rows"><SettingRow icon={<ProviderIcon provider="spotify" />} title="Spotify" detail={`${connections.spotify.accountName || 'Spotify'} · ${connections.spotify.status.replaceAll('_', ' ')}`} action={connections.spotify.usable ? <button className="text-button danger" onClick={() => disconnect('spotify')}>Disconnect</button> : <a className="text-button" href={providerUrl('spotify', '/settings')}>{connections.spotify.connected ? 'Reconnect' : 'Connect'}</a>} /><SettingRow icon={<ProviderIcon provider="youtube" />} title="YouTube Music" detail={`${connections.youtube.accountName || 'YouTube Music'} · ${connections.youtube.status.replaceAll('_', ' ')}`} action={connections.youtube.usable ? <button className="text-button danger" onClick={() => disconnect('youtube')}>Disconnect</button> : <a className="text-button" href={providerUrl('google', '/settings')}>{connections.youtube.connected ? 'Reconnect' : 'Connect'}</a>} /></div>}</section>
    <section className="settings-section"><h2>Privacy</h2><div className="privacy-copy"><ShieldCheck size={21} /><p>Provider tokens are encrypted server-side and never returned to this browser. Deleting your account removes connections and migration records from MusicMove.</p></div></section>
    <section className="settings-section"><h2>Session</h2><button className="button secondary" onClick={logout}>Sign out</button></section>
    <section className="settings-section danger-zone"><h2>Delete account and data</h2><p>Permanently remove your MusicMove account, saved connections, migration history, and review queue.</p><button className="button danger" onClick={remove}><Trash2 size={16} /> Delete my data</button></section>
  </div>;
}

function SettingRow({ icon, title, detail, action }) { return <div className="setting-row"><span>{icon}</span><div><strong>{title}</strong><small>{detail}</small></div>{action}</div>; }

function ProtectedRoutes({ theme, setTheme }) { return <RequireAuth><AppShell theme={theme} setTheme={setTheme}><Routes><Route path="/connections" element={<Connections />} /><Route path="/migrate" element={<MigrationSetup />} /><Route path="/migrations/:id" element={<MigrationDetails />} /><Route path="/migrations/:id/scan" element={<ScanPage />} /><Route path="/migrations/:id/preview" element={<PreviewPage />} /><Route path="/migrations/:id/progress" element={<ProgressPage />} /><Route path="/migrations/:id/complete" element={<CompletePage />} /><Route path="/migrations/:id/review" element={<ReviewPage />} /><Route path="/history" element={<History />} /><Route path="/settings" element={<Settings />} /><Route path="*" element={<Navigate to="/migrate" replace />} /></Routes></AppShell></RequireAuth>; }

export default function App() {
  const [theme, setTheme] = React.useState(() => localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
  React.useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('theme', theme); }, [theme]);
  return <AuthProvider><Routes><Route path="/" element={<Landing theme={theme} setTheme={setTheme} />} /><Route path="/login" element={<Login theme={theme} setTheme={setTheme} />} /><Route path="/*" element={<ProtectedRoutes theme={theme} setTheme={setTheme} />} /></Routes></AuthProvider>;
}
