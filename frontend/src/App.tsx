import { useCallback, useEffect, useState } from "react";
import Home from "./pages/Home";
import AuthScreen from "./components/AuthScreen";
import {
  clearAuthState,
  loadAuthState,
  saveAuthState,
  type AuthState,
} from "./store/authStore";
import { setStorageNamespace } from "./store/persist";

export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);

  useEffect(() => {
    const existing = loadAuthState();
    if (existing) {
      setStorageNamespace(existing.user.id);
      setAuth(existing);
    }
  }, []);

  const handleAuth = useCallback((next: AuthState | null) => {
    if (next) {
      setStorageNamespace(next.user.id);
      saveAuthState(next);
      setAuth(next);
      return;
    }
    setStorageNamespace(null);
    clearAuthState();
    setAuth(null);
  }, []);

  if (!auth) {
    return <AuthScreen onAuth={handleAuth} />;
  }

  return <Home auth={auth} onAuthChange={handleAuth} />;
}
