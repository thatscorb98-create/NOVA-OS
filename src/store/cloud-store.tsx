import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Session } from '@supabase/supabase-js';

import * as cloudApi from '@/lib/cloud/api';
import { getSupabase } from '@/lib/cloud/client';
import { isCloudConfigured, missingCloudVariables } from '@/lib/cloud/config';
import type {
  AutonomyMode,
  CloudCatalogService,
  CloudDiscoveryRun,
  CloudEvent,
  CloudHealth,
  CloudJob,
  CloudLead,
  CloudResult,
} from '@/lib/cloud/types';
import { useNova } from '@/store/nova-store';

/**
 * Cloud provider.
 *
 * Sits beside the local-first workspace rather than replacing it: the phone
 * keeps every mission, conversation and memory in AsyncStorage whether or not a
 * cloud project is configured or the owner is signed in.
 *
 * It never invents state. Health, jobs and events are whatever the database
 * returned on the last refresh.
 */

export type CloudStatus = 'unconfigured' | 'signed_out' | 'connecting' | 'online' | 'error';

type BusyKey =
  | 'signin'
  | 'signup'
  | 'refresh'
  | 'worker'
  | 'ping'
  | 'sync'
  | 'mode'
  | 'cancel'
  | 'discovery'
  | 'catalog'
  | 'settings'
  | null;

interface CloudContextValue {
  configured: boolean;
  missingVariables: string[];
  session: Session | null;
  status: CloudStatus;
  health: CloudHealth | null;
  jobs: CloudJob[];
  events: CloudEvent[];
  leads: CloudLead[];
  catalog: CloudCatalogService[];
  discoveryRuns: CloudDiscoveryRun[];
  lastError: string | null;
  lastMessage: string | null;
  busy: BusyKey;
  refresh: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<CloudResult>;
  signUp: (email: string, password: string) => Promise<CloudResult>;
  signOut: () => Promise<void>;
  runWorker: () => Promise<CloudResult>;
  queuePing: () => Promise<CloudResult>;
  syncMemory: () => Promise<CloudResult>;
  setMode: (mode: AutonomyMode) => Promise<CloudResult>;
  cancel: (jobId: string) => Promise<CloudResult>;
  runDiscovery: (query?: string) => Promise<CloudResult>;
  setDiscoveryEnabled: (enabled: boolean) => Promise<CloudResult>;
  setCatalogPrice: (
    id: string,
    priceCents: number,
    deliveryDays: number,
  ) => Promise<CloudResult>;
  clearNotice: () => void;
}

const CloudContext = createContext<CloudContextValue | null>(null);

export function CloudProvider({ children }: { children: React.ReactNode }) {
  const nova = useNova();
  const memoriesRef = useRef(nova.memories);
  memoriesRef.current = nova.memories;

  const [session, setSession] = useState<Session | null>(null);
  const [health, setHealth] = useState<CloudHealth | null>(null);
  const [jobs, setJobs] = useState<CloudJob[]>([]);
  const [events, setEvents] = useState<CloudEvent[]>([]);
  const [leads, setLeads] = useState<CloudLead[]>([]);
  const [catalog, setCatalog] = useState<CloudCatalogService[]>([]);
  const [discoveryRuns, setDiscoveryRuns] = useState<CloudDiscoveryRun[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyKey>(null);

  const missingVariables = useMemo(
    () => (isCloudConfigured ? [] : missingCloudVariables()),
    [],
  );

  useEffect(() => {
    const client = getSupabase();
    if (!client) return;

    let alive = true;

    void client.auth.getSession().then(({ data }) => {
      if (alive) setSession(data.session ?? null);
    });

    const { data: subscription } = client.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => {
      alive = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  const refresh = useCallback(async () => {
    const client = getSupabase();
    if (!client) return;

    const { data: sessionData } = await client.auth.getSession();
    if (!sessionData.session) {
      setHealth(null);
      setJobs([]);
      setEvents([]);
      setLeads([]);
      setCatalog([]);
      setDiscoveryRuns([]);
      return;
    }

    setBusy('refresh');
    try {
      const [nextHealth, nextJobs, nextEvents, nextLeads, nextCatalog, nextRuns] =
        await Promise.all([
          cloudApi.loadHealth(client),
          cloudApi.loadJobs(client),
          cloudApi.loadEvents(client),
          cloudApi.loadLeads(client),
          cloudApi.loadCatalog(client),
          cloudApi.loadDiscoveryRuns(client),
        ]);

      setHealth(nextHealth);
      setJobs(nextJobs);
      setEvents(nextEvents);
      setLeads(nextLeads);
      setCatalog(nextCatalog);
      setDiscoveryRuns(nextRuns);
      setLastError(null);
    } catch (error) {
      setLastError(cloudApi.describeCloudError(error));
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    if (!session) {
      setHealth(null);
      setJobs([]);
      setEvents([]);
      setLeads([]);
      setCatalog([]);
      setDiscoveryRuns([]);
      return;
    }
    void refresh();
  }, [session, refresh]);

  const signIn = useCallback(async (email: string, password: string): Promise<CloudResult> => {
    const client = getSupabase();
    if (!client) return { ok: false, error: 'No cloud project is configured.' };

    setBusy('signin');
    setLastError(null);
    setLastMessage(null);

    const result = await cloudApi.signInWithPassword(client, email, password);
    setBusy(null);

    if (!result.ok) setLastError(result.error ?? 'Sign in failed.');
    return result;
  }, []);

  const signUp = useCallback(async (email: string, password: string): Promise<CloudResult> => {
    const client = getSupabase();
    if (!client) return { ok: false, error: 'No cloud project is configured.' };

    setBusy('signup');
    setLastError(null);
    setLastMessage(null);

    const result = await cloudApi.signUpWithPassword(client, email, password);
    setBusy(null);

    if (!result.ok) setLastError(result.error ?? 'Could not create the account.');
    else setLastMessage(result.detail ?? 'Account created.');

    return result;
  }, []);

  const signOut = useCallback(async () => {
    const client = getSupabase();
    if (!client) return;

    await client.auth.signOut();
    setSession(null);
    setHealth(null);
    setJobs([]);
    setEvents([]);
    setLeads([]);
    setCatalog([]);
    setDiscoveryRuns([]);
    setLastError(null);
    setLastMessage(null);
  }, []);

  const runWorker = useCallback(async (): Promise<CloudResult> => {
    const client = getSupabase();
    if (!client) return { ok: false, error: 'No cloud project is configured.' };

    setBusy('worker');
    setLastError(null);
    setLastMessage(null);

    try {
      const summary = await cloudApi.runWorker(client);
      const detail =
        summary.claimed === 0
          ? 'The queue was empty. Nothing to run.'
          : `${summary.claimed} job(s): ${summary.succeeded} succeeded, ${summary.failed} failed, ${summary.released} deferred.`;

      setLastMessage(detail);
      await refresh();
      return { ok: true, detail };
    } catch (error) {
      const message = cloudApi.describeCloudError(error);
      setLastError(message);
      return { ok: false, error: message };
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const queuePing = useCallback(async (): Promise<CloudResult> => {
    const client = getSupabase();
    if (!client) return { ok: false, error: 'No cloud project is configured.' };

    setBusy('ping');
    setLastError(null);
    setLastMessage(null);

    try {
      const jobId = await cloudApi.enqueuePing(client);
      const detail = jobId
        ? `Ping queued (${jobId.slice(0, 8)}). Run the worker to process it.`
        : 'A ping for this minute already exists.';

      setLastMessage(detail);
      await refresh();
      return { ok: true, detail };
    } catch (error) {
      const message = cloudApi.describeCloudError(error);
      setLastError(message);
      return { ok: false, error: message };
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const syncMemory = useCallback(async (): Promise<CloudResult> => {
    const client = getSupabase();
    if (!client) return { ok: false, error: 'No cloud project is configured.' };

    setBusy('sync');
    setLastError(null);
    setLastMessage(null);

    try {
      const result = await cloudApi.syncLocalMemories(client, memoriesRef.current);
      const detail =
        result.received === 0
          ? 'There are no local memories to import yet.'
          : `${result.inserted} imported, ${result.skipped} already present. Local copies untouched.`;

      setLastMessage(detail);
      await refresh();
      return { ok: true, detail };
    } catch (error) {
      const message = cloudApi.describeCloudError(error);
      setLastError(message);
      return { ok: false, error: message };
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const setMode = useCallback(
    async (mode: AutonomyMode): Promise<CloudResult> => {
      const client = getSupabase();
      if (!client) return { ok: false, error: 'No cloud project is configured.' };

      setBusy('mode');
      setLastError(null);
      setLastMessage(null);

      try {
        await cloudApi.setAutonomyMode(client, mode);
        await refresh();
        setLastMessage(`Company mode set to ${mode}.`);
        return { ok: true };
      } catch (error) {
        const message = cloudApi.describeCloudError(error);
        setLastError(message);
        return { ok: false, error: message };
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const cancel = useCallback(
    async (jobId: string): Promise<CloudResult> => {
      const client = getSupabase();
      if (!client) return { ok: false, error: 'No cloud project is configured.' };

      setBusy('cancel');
      setLastError(null);

      try {
        const cancelled = await cloudApi.cancelJob(client, jobId);
        await refresh();
        return cancelled
          ? { ok: true, detail: 'Job cancelled.' }
          : { ok: false, error: 'That job is no longer cancellable.' };
      } catch (error) {
        const message = cloudApi.describeCloudError(error);
        setLastError(message);
        return { ok: false, error: message };
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const clearNotice = useCallback(() => {
    setLastError(null);
    setLastMessage(null);
  }, []);

  const runDiscovery = useCallback(
    async (query?: string): Promise<CloudResult> => {
      const client = getSupabase();
      if (!client) return { ok: false, error: 'No cloud project is configured.' };

      setBusy('discovery');
      setLastError(null);
      setLastMessage(null);

      try {
        const jobId = await cloudApi.enqueueDiscovery(client, query);
        const detail = jobId
          ? 'Discovery queued. Run the worker to execute the search.'
          : 'A discovery run was already queued for this minute.';

        setLastMessage(detail);
        await refresh();
        return { ok: true, detail };
      } catch (error) {
        const message = cloudApi.describeCloudError(error);
        setLastError(message);
        return { ok: false, error: message };
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const setDiscoveryEnabled = useCallback(
    async (enabled: boolean): Promise<CloudResult> => {
      const client = getSupabase();
      if (!client) return { ok: false, error: 'No cloud project is configured.' };

      setBusy('settings');
      setLastError(null);

      try {
        await cloudApi.updateCompanySettings(client, { discovery_enabled: enabled });
        await refresh();
        setLastMessage(enabled ? 'Discovery enabled.' : 'Discovery disabled.');
        return { ok: true };
      } catch (error) {
        const message = cloudApi.describeCloudError(error);
        setLastError(message);
        return { ok: false, error: message };
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const setCatalogPrice = useCallback(
    async (id: string, priceCents: number, deliveryDays: number): Promise<CloudResult> => {
      const client = getSupabase();
      if (!client) return { ok: false, error: 'No cloud project is configured.' };

      setBusy('catalog');
      setLastError(null);

      try {
        await cloudApi.updateCatalogService(client, id, {
          price_cents: Math.max(0, Math.round(priceCents)),
          delivery_days: Math.max(1, Math.min(90, Math.round(deliveryDays))),
          enabled: true,
        });
        await refresh();
        setLastMessage('Service price saved and the service is enabled.');
        return { ok: true };
      } catch (error) {
        const message = cloudApi.describeCloudError(error);
        setLastError(message);
        return { ok: false, error: message };
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const status: CloudStatus = !isCloudConfigured
    ? 'unconfigured'
    : !session
      ? 'signed_out'
      : health?.ok
        ? 'online'
        : lastError
          ? 'error'
          : 'connecting';

  const value = useMemo<CloudContextValue>(
    () => ({
      configured: isCloudConfigured,
      missingVariables,
      session,
      status,
      health,
      jobs,
      events,
      leads,
      catalog,
      discoveryRuns,
      lastError,
      lastMessage,
      busy,
      refresh,
      signIn,
      signUp,
      signOut,
      runWorker,
      queuePing,
      syncMemory,
      setMode,
      cancel,
      runDiscovery,
      setDiscoveryEnabled,
      setCatalogPrice,
      clearNotice,
    }),
    [
      missingVariables,
      session,
      status,
      health,
      jobs,
      events,
      leads,
      catalog,
      discoveryRuns,
      lastError,
      lastMessage,
      busy,
      refresh,
      signIn,
      signUp,
      signOut,
      runWorker,
      queuePing,
      syncMemory,
      setMode,
      cancel,
      runDiscovery,
      setDiscoveryEnabled,
      setCatalogPrice,
      clearNotice,
    ],
  );

  return <CloudContext.Provider value={value}>{children}</CloudContext.Provider>;
}

export function useCloud(): CloudContextValue {
  const context = useContext(CloudContext);
  if (!context) {
    throw new Error('useCloud must be used inside <CloudProvider>');
  }
  return context;
}
