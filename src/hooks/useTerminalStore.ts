import { useEffect, useState, useCallback } from "react";

export type TerminalStoreInfo = {
  id: string;
  code: string;
  name: string;
  pin: string; // terminal PIN cached locally to re-validate on each marcaje
};

const KEY = "marcaje:terminal_store";

function read(): TerminalStoreInfo | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as TerminalStoreInfo;
  } catch {
    return null;
  }
}

export function useTerminalStore() {
  const [store, setStore] = useState<TerminalStoreInfo | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setStore(read());
    setReady(true);
  }, []);

  const save = useCallback((info: TerminalStoreInfo) => {
    localStorage.setItem(KEY, JSON.stringify(info));
    setStore(info);
  }, []);

  const clear = useCallback(() => {
    localStorage.removeItem(KEY);
    setStore(null);
  }, []);

  return { store, ready, save, clear };
}