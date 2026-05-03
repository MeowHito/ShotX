'use client';

import { useEffect, useState } from 'react';
import { API_URL } from './api';

const TOKEN_KEY = 'shotx_token';

export type Photographer = {
  id: string;
  name: string;
  email: string;
  plan: string;
  status?: string;
  role?: string;
  avatar_url?: string | null;
};

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  window.localStorage.setItem(TOKEN_KEY, token);
  meCache = null;
  meInflight = null;
  notifyMeListeners();
}

export function clearToken() {
  window.localStorage.removeItem(TOKEN_KEY);
  meCache = null;
  meInflight = null;
  notifyMeListeners();
}

export async function authFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const isFormData = init?.body instanceof FormData;
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (!isFormData && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${path}`, { ...init, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

let meCache: Photographer | null | undefined;
let meInflight: Promise<Photographer | null> | null = null;
const meListeners = new Set<(p: Photographer | null) => void>();

function notifyMeListeners() {
  for (const listener of meListeners) listener(meCache ?? null);
}

async function fetchMe(): Promise<Photographer | null> {
  if (!getToken()) return null;
  try {
    const me = await authFetch<Photographer>('/auth/me');
    return me;
  } catch {
    if (typeof window !== 'undefined') window.localStorage.removeItem(TOKEN_KEY);
    return null;
  }
}

export function useMe() {
  const [me, setMe] = useState<Photographer | null>(meCache ?? null);
  const [loading, setLoading] = useState(meCache === undefined);

  useEffect(() => {
    const listener = (p: Photographer | null) => setMe(p);
    meListeners.add(listener);

    if (meCache !== undefined) {
      setMe(meCache);
      setLoading(false);
    } else {
      if (!meInflight) meInflight = fetchMe();
      meInflight.then((p) => {
        meCache = p;
        meInflight = null;
        notifyMeListeners();
        setLoading(false);
      });
    }

    return () => { meListeners.delete(listener); };
  }, []);

  return {
    me,
    loading,
    signOut: () => clearToken(),
  };
}
