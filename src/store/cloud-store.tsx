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
  CloudAuditRun,
  CloudCatalogService,
  CloudCompanyCycle,
  CloudCustomerHistory,
  CloudDeal,
  CloudDeliverable,
  CloudDeliveryLink,
  CloudDiscoveryRun,
  CloudEmailAccount,
  CloudEvent,
  CloudExpense,
  CloudFinanceSummary,
  CloudHealth,
  CloudJob,
  CloudLead,
  CloudLoopSnapshot,
  CloudOrder,
  CloudOutreachMessage,
  CloudPaymentIntent,
  CloudQuote,
  CloudReadyLead,
  CloudReply,
  CloudResult,
  DealStage,
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
  | 'outreach'
  | 'quote'
  | 'deal'
  | 'delivery'
  | 'payment'
  | 'finance'
  | 'audit'
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
  outreach: CloudOutreachMessage[];
  emailAccount: CloudEmailAccount | null;
  readyLeads: CloudReadyLead[];
  readyTotal: number;
  readyStats: { ready: number; withoutContact: number };
  readyLoading: boolean;
  deliverables: CloudDeliverable[];
  deliveryLinks: CloudDeliveryLink[];
  customerHistory: CloudCustomerHistory[];
  companyCycles: CloudCompanyCycle[];
  loopSnapshot: CloudLoopSnapshot | null;
  auditRuns: CloudAuditRun[];
  quotes: CloudQuote[];
  paymentIntents: CloudPaymentIntent[];
  orders: CloudOrder[];
  finance: CloudFinanceSummary | null;
  expenses: CloudExpense[];
  deals: CloudDeal[];
  replies: CloudReply[];
  lastError: string | null;
  lastMessage: string | null;
  busy: BusyKey;
  refresh: () => Promise<void>;
  loadMoreReadyLeads: () => Promise<void>;
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
  updateSettings: (patch: {
    industries?: string[];
    geography?: string[];
    daily_lead_cap?: number;
    score_threshold?: number;
    payments_live?: boolean;
    stripe_live_mode?: boolean;
  }) => Promise<CloudResult>;
  approveMessage: (id: string) => Promise<CloudResult>;
  draftForLead: (leadId: string) => Promise<CloudResult>;
  createQuote: (input: {
    leadId: string;
    title: string;
    scope: string;
    deliverables?: string;
    terms?: string;
    amountCents: number;
    deliveryDays: number;
    expiresInDays: number;
  }) => Promise<CloudResult>;
  sendQuote: (id: string) => Promise<CloudResult>;
  quoteLink: (id: string) => Promise<CloudResult>;
  recordPaymentDue: (quoteId: string) => Promise<CloudResult>;
  createCheckout: (quoteId: string) => Promise<CloudResult>;
  addExpense: (input: {
    category: CloudExpense['category'];
    note: string;
    amountCents: number;
  }) => Promise<CloudResult>;
  removeExpense: (id: string) => Promise<CloudResult>;
  setDealStage: (id: string, stage: DealStage) => Promise<CloudResult>;
  openDelivery: (quoteId: string) => Promise<CloudResult>;
  startDeliverable: (id: string) => Promise<CloudResult>;
  deliverWork: (id: string, artifactUrl: string) => Promise<CloudResult>;
  acceptWork: (id: string) => Promise<CloudResult>;
  requestRevision: (id: string, note: string) => Promise<CloudResult>;
  mintDeliveryLink: (id: string) => Promise<{ ok: boolean; url?: string; error?: string }>;
  sendDeliveryEmail: (id: string) => Promise<CloudResult>;
  scheduleDeliveryFollowUps: (messageId: string) => Promise<CloudResult>;
  revokeDeliveryLinks: (deliverableId: string) => Promise<CloudResult>;
  runCompanyCycle: () => Promise<CloudResult>;
  runAudit: () => Promise<CloudResult>;
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
  const [outreach, setOutreach] = useState<CloudOutreachMessage[]>([]);
  const [emailAccount, setEmailAccount] = useState<CloudEmailAccount | null>(null);
  const [readyLeads, setReadyLeads] = useState<CloudReadyLead[]>([]);
  const [readyTotal, setReadyTotal] = useState(0);
  const [readyStats, setReadyStats] = useState({ ready: 0, withoutContact: 0 });
  const [readyLoading, setReadyLoading] = useState(false);
  const [deliverables, setDeliverables] = useState<CloudDeliverable[]>([]);
  const [deliveryLinks, setDeliveryLinks] = useState<CloudDeliveryLink[]>([]);
  const [quotes, setQuotes] = useState<CloudQuote[]>([]);
  const [paymentIntents, setPaymentIntents] = useState<CloudPaymentIntent[]>([]);
  const [orders, setOrders] = useState<CloudOrder[]>([]);
  const [finance, setFinance] = useState<CloudFinanceSummary | null>(null);
  const [expenses, setExpenses] = useState<CloudExpense[]>([]);
  const [deals, setDeals] = useState<CloudDeal[]>([]);
  const [replies, setReplies] = useState<CloudReply[]>([]);
  const [customerHistory, setCustomerHistory] = useState<CloudCustomerHistory[]>([]);
  const [companyCycles, setCompanyCycles] = useState<CloudCompanyCycle[]>([]);
  const [loopSnapshot, setLoopSnapshot] = useState<CloudLoopSnapshot | null>(null);
  const [auditRuns, setAuditRuns] = useState<CloudAuditRun[]>([]);
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
      setOutreach([]);
      setEmailAccount(null);
      setReadyLeads([]);
      setDeliverables([]);
      setDeliveryLinks([]);
      setQuotes([]);
      setPaymentIntents([]);
      setOrders([]);
      setFinance(null);
      setExpenses([]);
      setDeals([]);
      setReplies([]);
      setCustomerHistory([]);
      setCompanyCycles([]);
      setLoopSnapshot(null);
      setAuditRuns([]);
      return;
    }

    setBusy('refresh');
    try {
      const [
        nextHealth,
        nextJobs,
        nextEvents,
        nextLeads,
        nextCatalog,
        nextRuns,
        nextOutreach,
        nextAccount,
        nextReadyPage,
        nextReadyStats,
        nextDeliverables,
        nextQuotes,
        nextIntents,
        nextOrders,
        nextFinance,
        nextExpenses,
        nextDeals,
        nextReplies,
        nextHistory,
        nextLinks,
        nextCycles,
        nextLoop,
        nextAudit,
      ] = await Promise.all([
        cloudApi.loadHealth(client),
        cloudApi.loadJobs(client),
        cloudApi.loadEvents(client),
        cloudApi.loadLeads(client),
        cloudApi.loadCatalog(client),
        cloudApi.loadDiscoveryRuns(client),
        cloudApi.loadOutreachMessages(client),
        cloudApi.loadEmailAccount(client),
        cloudApi.loadReadyLeads(client, 100, 0),
        cloudApi.loadReadyStats(client),
        cloudApi.loadDeliverables(client),
        cloudApi.loadQuotes(client),
        cloudApi.loadPaymentIntents(client),
        cloudApi.loadOrders(client),
        cloudApi.loadFinanceSummary(client),
        cloudApi.loadExpenses(client),
        cloudApi.loadDeals(client),
        cloudApi.loadReplies(client),
        cloudApi.loadCustomerHistory(client),
        cloudApi.loadDeliveryLinks(client),
        cloudApi.loadCompanyCycles(client),
        cloudApi.loadLoopSnapshot(client),
        cloudApi.loadAuditRuns(client),
      ]);

      setHealth(nextHealth);
      setJobs(nextJobs);
      setEvents(nextEvents);
      setLeads(nextLeads);
      setCatalog(nextCatalog);
      setDiscoveryRuns(nextRuns);
      setOutreach(nextOutreach);
      setEmailAccount(nextAccount);
      setReadyLeads(nextReadyPage.leads);
      setReadyTotal(nextReadyPage.total);
      setReadyStats(nextReadyStats);
      setDeliverables(nextDeliverables);
      setQuotes(nextQuotes);
      setPaymentIntents(nextIntents);
      setOrders(nextOrders);
      setFinance(nextFinance);
      setExpenses(nextExpenses);
      setDeals(nextDeals);
      setReplies(nextReplies);
      setCustomerHistory(nextHistory);
      setDeliveryLinks(nextLinks);
      setCompanyCycles(nextCycles);
      setLoopSnapshot(nextLoop);
      setAuditRuns(nextAudit);
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
      setOutreach([]);
      setEmailAccount(null);
      setReadyLeads([]);
      setDeliverables([]);
      setQuotes([]);
      setPaymentIntents([]);
      setOrders([]);
      setFinance(null);
      setExpenses([]);
      setDeals([]);
      setReplies([]);
      setCustomerHistory([]);
      setDeliveryLinks([]);
      setCompanyCycles([]);
      setLoopSnapshot(null);
      setAuditRuns([]);
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
    setOutreach([]);
    setEmailAccount(null);
    setReadyLeads([]);
    setDeliverables([]);
    setDeliveryLinks([]);
    setQuotes([]);
    setPaymentIntents([]);
    setDeals([]);
    setReplies([]);
    setCustomerHistory([]);
    setCompanyCycles([]);
    setLoopSnapshot(null);
    setAuditRuns([]);
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

  const updateSettings = useCallback(
    async (patch: {
      industries?: string[];
      geography?: string[];
      daily_lead_cap?: number;
      score_threshold?: number;
      payments_live?: boolean;
      stripe_live_mode?: boolean;
    }): Promise<CloudResult> => {
      const client = getSupabase();
      if (!client) return { ok: false, error: 'No cloud project is configured.' };

      setBusy('settings');
      setLastError(null);
      setLastMessage(null);

      try {
        await cloudApi.updateCompanySettings(client, patch);
        await refresh();
        setLastMessage(
          patch.stripe_live_mode !== undefined
            ? patch.stripe_live_mode
              ? 'Live mode is on. Every checkout now uses the configured live key; a real card can be charged.'
              : 'Live mode is off. Checkout stays in Stripe test mode.'
            : patch.payments_live === undefined
              ? 'Discovery settings saved.'
              : patch.payments_live
                ? 'Payments are switched on. Checkout still requires an accepted quote, and Stripe must confirm the payment before an order exists.'
                : 'Payments are switched off.',
        );
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

  const approveMessage = useCallback(
    async (id: string): Promise<CloudResult> => {
      const client = getSupabase();
      if (!client) return { ok: false, error: 'No cloud project is configured.' };

      setBusy('outreach');
      setLastError(null);
      setLastMessage(null);

      try {
        await cloudApi.approveOutreachMessage(client, id);
        await refresh();
        setLastMessage('Draft approved. It will only send once email is switched on.');
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

  const draftForLead = useCallback(
    async (leadId: string): Promise<CloudResult> => {
      const client = getSupabase();
      if (!client) return { ok: false, error: 'No cloud project is configured.' };

      setBusy('outreach');
      setLastError(null);
      setLastMessage(null);

      try {
        const jobId = await cloudApi.enqueueDraft(client, leadId);
        const detail = jobId
          ? 'Draft queued. Run the worker to write it.'
          : 'A draft job for this lead is already queued.';

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

  const createQuote = useCallback(
    async (input: {
      leadId: string;
      title: string;
      scope: string;
      deliverables?: string;
      terms?: string;
      amountCents: number;
      deliveryDays: number;
      expiresInDays: number;
    }): Promise<CloudResult> => {
      const client = getSupabase();
      if (!client) return { ok: false, error: 'No cloud project is configured.' };

      setBusy('quote');
      setLastError(null);
      setLastMessage(null);

      try {
        await cloudApi.createQuote(client, input);
        await refresh();
        setLastMessage('Quote saved as a draft. Send it when the amount is right.');
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

  const sendQuote = useCallback(
    async (id: string): Promise<CloudResult> => {
      const client = getSupabase();
      if (!client) return { ok: false, error: 'No cloud project is configured.' };

      setBusy('quote');
      setLastError(null);
      setLastMessage(null);

      try {
        await cloudApi.sendQuote(client, id);
        await refresh();
        setLastMessage('Quote released. Create the acceptance link when you are ready to send it.');
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

  const quoteLink = useCallback(
    async (id: string): Promise<CloudResult> => {
      const client = getSupabase();
      if (!client) return { ok: false, error: 'No cloud project is configured.' };

      setBusy('quote');
      setLastError(null);

      try {
        const link = await cloudApi.mintQuoteLink(client, id);
        return { ok: true, detail: link.url };
      } catch (error) {
        const message = cloudApi.describeCloudError(error);
        setLastError(message);
        return { ok: false, error: message };
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const recordPaymentDue = useCallback(
    async (quoteId: string): Promise<CloudResult> => {
      const client = getSupabase();
      if (!client) return { ok: false, error: 'No cloud project is configured.' };

      setBusy('quote');
      setLastError(null);
      setLastMessage(null);

      try {
        const jobId = await cloudApi.enqueuePaymentIntent(client, quoteId);
        const detail = jobId
          ? 'Payment record queued. Run the worker to store it.'
          : 'A payment record job for this quote is already queued.';

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

  const createCheckout = useCallback(
    async (quoteId: string): Promise<CloudResult> => {
      const client = getSupabase();
      if (!client) return { ok: false, error: 'No cloud project is configured.' };

      setBusy('payment');
      setLastError(null);
      setLastMessage(null);

      try {
        const checkout = await cloudApi.createCheckout(client, quoteId);
        await refresh();
        setLastMessage(
          checkout.mode === 'live'
            ? 'Live checkout created. Stripe must confirm the payment by signed webhook before an order exists.'
            : 'Test-mode checkout created. No real money can move; Stripe must confirm it by signed webhook.',
        );
        return { ok: true, detail: checkout.url };
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

  const addExpense = useCallback(
    async (input: {
      category: CloudExpense['category'];
      note: string;
      amountCents: number;
    }): Promise<CloudResult> => {
      const client = getSupabase();
      if (!client) return { ok: false, error: 'No cloud project is configured.' };

      setBusy('finance');
      setLastError(null);
      setLastMessage(null);

      try {
        await cloudApi.addExpense(client, input);
        await refresh();
        setLastMessage('Expense recorded.');
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

  const removeExpense = useCallback(
    async (id: string): Promise<CloudResult> => {
      const client = getSupabase();
      if (!client) return { ok: false, error: 'No cloud project is configured.' };

      setBusy('finance');
      setLastError(null);
      setLastMessage(null);

      try {
        await cloudApi.deleteExpense(client, id);
        await refresh();
        setLastMessage('Expense removed.');
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

  const setDealStage = useCallback(
    async (id: string, stage: DealStage): Promise<CloudResult> => {
      const client = getSupabase();
      if (!client) return { ok: false, error: 'No cloud project is configured.' };

      setBusy('deal');
      setLastError(null);
      setLastMessage(null);

      try {
        await cloudApi.setDealStage(client, id, stage);
        await refresh();
        setLastMessage('Deal stage updated by you.');
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

  const openDelivery = useCallback(
    async (quoteId: string): Promise<CloudResult> => {
      const client = getSupabase();
      if (!client) return { ok: false, error: 'No cloud project is configured.' };

      setBusy('delivery');
      setLastError(null);
      setLastMessage(null);

      try {
        await cloudApi.openDelivery(client, quoteId);
        await refresh();
        setLastMessage('Delivery opened from the accepted quote. The due date comes from its delivery days.');
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

  const startDeliverable = useCallback(
    async (id: string): Promise<CloudResult> => {
      const client = getSupabase();
      if (!client) return { ok: false, error: 'No cloud project is configured.' };

      setBusy('delivery');
      setLastError(null);
      setLastMessage(null);

      try {
        await cloudApi.startDeliverable(client, id);
        await refresh();
        setLastMessage('Work marked in progress.');
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

  const deliverWork = useCallback(
    async (id: string, artifactUrl: string): Promise<CloudResult> => {
      const client = getSupabase();
      if (!client) return { ok: false, error: 'No cloud project is configured.' };

      setBusy('delivery');
      setLastError(null);
      setLastMessage(null);

      try {
        await cloudApi.markDeliverableDelivered(client, id, artifactUrl);
        await refresh();
        setLastMessage('Delivery recorded with its link.');
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

  const acceptWork = useCallback(
    async (id: string): Promise<CloudResult> => {
      const client = getSupabase();
      if (!client) return { ok: false, error: 'No cloud project is configured.' };

      setBusy('delivery');
      setLastError(null);
      setLastMessage(null);

      try {
        await cloudApi.acceptDeliverable(client, id);
        await refresh();
        setLastMessage('Delivery accepted. The deal is marked won.');
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

  const requestRevision = useCallback(
    async (id: string, note: string): Promise<CloudResult> => {
      const client = getSupabase();
      if (!client) return { ok: false, error: 'No cloud project is configured.' };

      setBusy('delivery');
      setLastError(null);
      setLastMessage(null);

      try {
        await cloudApi.requestDeliverableRevision(client, id, note);
        await refresh();
        setLastMessage('Revision requested, within the included allowance.');
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

  const mintDeliveryLink = useCallback(
    async (id: string): Promise<{ ok: boolean; url?: string; error?: string }> => {
      const client = getSupabase();
      if (!client) return { ok: false, error: 'No cloud project is configured.' };

      setBusy('delivery');
      setLastError(null);
      setLastMessage(null);

      try {
        const link = await cloudApi.mintDeliveryLink(client, id);
        setLastMessage('Private delivery link created. It expires in 14 days and can be revoked.');
        return { ok: true, url: link.url };
      } catch (error) {
        const message = cloudApi.describeCloudError(error);
        setLastError(message);
        return { ok: false, error: message };
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const sendDeliveryEmail = useCallback(
    async (id: string): Promise<CloudResult> => {
      const client = getSupabase();
      if (!client) return { ok: false, error: 'No cloud project is configured.' };

      setBusy('delivery');
      setLastError(null);
      setLastMessage(null);

      try {
        await cloudApi.enqueueDeliveryEmail(client, id);
        await refresh();
        setLastMessage(
          'Delivery email queued. It is marked delivered only after the provider returns a message id.',
        );
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

  const scheduleDeliveryFollowUps = useCallback(
    async (messageId: string): Promise<CloudResult> => {
      const client = getSupabase();
      if (!client) return { ok: false, error: 'No cloud project is configured.' };

      setBusy('delivery');
      setLastError(null);
      setLastMessage(null);

      try {
        const scheduled = await cloudApi.scheduleDeliveryFollowUps(client, messageId);
        await refresh();

        if (scheduled.length === 0) {
          const detail =
            'No follow-ups were added. The customer opted out, or the receipt, review and recurring checks are already scheduled.';
          setLastMessage(detail);
          return { ok: true, detail };
        }

        const detail = `Retention plan scheduled: ${scheduled.join(', ')}. Each becomes a draft for your approval, never an automatic send.`;
        setLastMessage(detail);
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

  const revokeDeliveryLinks = useCallback(
    async (deliverableId: string): Promise<CloudResult> => {
      const client = getSupabase();
      if (!client) return { ok: false, error: 'No cloud project is configured.' };

      setBusy('delivery');
      setLastError(null);
      setLastMessage(null);

      try {
        const revoked = await cloudApi.revokeDeliverableLinks(client, deliverableId);
        await refresh();

        const detail =
          revoked === 0
            ? 'There was no live delivery link to revoke.'
            : `${revoked} delivery link${revoked === 1 ? '' : 's'} revoked. The customer page now returns the generic unavailable notice.`;

        setLastMessage(detail);
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

  const runCompanyCycle = useCallback(async (): Promise<CloudResult> => {
    const client = getSupabase();
    if (!client) return { ok: false, error: 'No cloud project is configured.' };

    setBusy('worker');
    setLastError(null);
    setLastMessage(null);

    try {
      const jobId = await cloudApi.enqueueCompanyCycle(client);
      const summary = await cloudApi.runWorker(client, 6);
      await refresh();

      const detail = jobId
        ? `Company cycle queued. The worker ran ${summary.claimed} job(s): ${summary.succeeded} succeeded, ${summary.failed} failed, ${summary.released} deferred.`
        : 'The cycle was already queued for this moment.';

      setLastMessage(detail);
      return { ok: true, detail };
    } catch (error) {
      const message = cloudApi.describeCloudError(error);
      setLastError(message);
      return { ok: false, error: message };
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const runAudit = useCallback(async (): Promise<CloudResult> => {
    const client = getSupabase();
    if (!client) return { ok: false, error: 'No cloud project is configured.' };

    setBusy('audit');
    setLastError(null);
    setLastMessage(null);

    try {
      const run = await cloudApi.startAuditRun(client);
      const worker = await cloudApi.runWorker(client, 8);
      await refresh();

      const latest = (await cloudApi.loadAuditRuns(client, 1))[0] ?? run;
      const detail = `Dry-run audit is ${latest.status}. The worker ran ${worker.claimed} job(s): ${worker.succeeded} succeeded, ${worker.failed} failed.`;

      setLastMessage(detail);
      return { ok: true, detail };
    } catch (error) {
      const message = cloudApi.describeCloudError(error);
      setLastError(message);
      return { ok: false, error: message };
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const loadMoreReadyLeads = useCallback(async () => {
    const client = getSupabase();
    if (!client || readyLoading) return;

    setReadyLoading(true);
    setLastError(null);

    try {
      const page = await cloudApi.loadReadyLeads(client, 100, readyLeads.length);
      setReadyLeads((previous) => {
        const seen = new Set(previous.map((lead) => lead.id));
        return [...previous, ...page.leads.filter((lead) => !seen.has(lead.id))];
      });
      setReadyTotal(page.total);
    } catch (error) {
      setLastError(cloudApi.describeCloudError(error));
    } finally {
      setReadyLoading(false);
    }
  }, [readyLeads.length, readyLoading]);

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
      outreach,
      emailAccount,
      readyLeads,
      readyTotal,
      readyStats,
      readyLoading,
      deliverables,
      quotes,
      paymentIntents,
      orders,
      finance,
      expenses,
      deals,
      replies,
      lastError,
      lastMessage,
      busy,
      refresh,
      loadMoreReadyLeads,
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
      updateSettings,
      approveMessage,
      draftForLead,
      createQuote,
      sendQuote,
      quoteLink,
      recordPaymentDue,
      createCheckout,
      addExpense,
      removeExpense,
      setDealStage,
      openDelivery,
      startDeliverable,
      deliverWork,
      acceptWork,
      requestRevision,
      mintDeliveryLink,
      sendDeliveryEmail,
      scheduleDeliveryFollowUps,
      revokeDeliveryLinks,
      runCompanyCycle,
      runAudit,
      deliveryLinks,
      companyCycles,
      loopSnapshot,
      auditRuns,
      customerHistory,
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
      outreach,
      emailAccount,
      readyLeads,
      readyTotal,
      readyStats,
      readyLoading,
      deliverables,
      quotes,
      paymentIntents,
      orders,
      finance,
      expenses,
      deals,
      replies,
      lastError,
      lastMessage,
      busy,
      refresh,
      loadMoreReadyLeads,
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
      updateSettings,
      approveMessage,
      draftForLead,
      createQuote,
      sendQuote,
      quoteLink,
      recordPaymentDue,
      createCheckout,
      addExpense,
      removeExpense,
      setDealStage,
      openDelivery,
      startDeliverable,
      deliverWork,
      acceptWork,
      requestRevision,
      mintDeliveryLink,
      sendDeliveryEmail,
      scheduleDeliveryFollowUps,
      revokeDeliveryLinks,
      runCompanyCycle,
      runAudit,
      deliveryLinks,
      companyCycles,
      loopSnapshot,
      auditRuns,
      customerHistory,
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
