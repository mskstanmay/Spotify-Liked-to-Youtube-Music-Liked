import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api, setCsrfToken } from './api';
import { LoadingPage } from './components';

const AuthContext = React.createContext(null);

export function AuthProvider({ children }) {
  const [state, setState] = React.useState({ loading: true, user: null, error: null });
  const refresh = React.useCallback(async () => {
    try {
      const body = await api('/me');
      setCsrfToken(body.csrfToken);
      setState({ loading: false, user: body.user, error: null });
    } catch (error) {
      if (error.status === 401) setState({ loading: false, user: null, error: null });
      else setState({ loading: false, user: null, error });
    }
  }, []);
  React.useEffect(() => { refresh(); }, [refresh]);
  return <AuthContext.Provider value={{ ...state, refresh }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return React.useContext(AuthContext);
}

export function RequireAuth({ children }) {
  const auth = useAuth();
  const location = useLocation();
  if (auth.loading) return <LoadingPage />;
  if (!auth.user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return children;
}

export function useMigration(id, intervalMs = 2000) {
  const [migration, setMigration] = React.useState(null);
  const [error, setError] = React.useState(null);
  const refresh = React.useCallback(async () => {
    try {
      const result = await api(`/migrations/${id}`);
      setMigration((current) => !current || new Date(result.migration.updatedAt) >= new Date(current.updatedAt) ? result.migration : current);
      setError(null);
    } catch (nextError) { setError(nextError); }
  }, [id]);
  React.useEffect(() => {
    refresh();
    const source = new EventSource(`/api/migrations/${id}/events`, { withCredentials: true });
    source.addEventListener('migration', (event) => {
      try {
        const next = JSON.parse(event.data);
        setMigration((current) => !current || new Date(next.updatedAt) >= new Date(current.updatedAt) ? next : current);
        setError(null);
      } catch { /* ignore malformed event */ }
    });
    source.onerror = () => {};
    const fallback = setInterval(refresh, intervalMs);
    return () => { source.close(); clearInterval(fallback); };
  }, [id, intervalMs, refresh]);
  return { migration, error, refresh };
}
