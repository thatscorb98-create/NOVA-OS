import React, { useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppText } from '@/components/ui/AppText';
import { Chip, StatusDot } from '@/components/ui/Bits';
import { EmptyState } from '@/components/ui/EmptyState';
import { FadeInView } from '@/components/ui/FadeInView';
import { FormField } from '@/components/ui/FormField';
import { NeonButton } from '@/components/ui/NeonButton';
import { Panel, SectionHeader } from '@/components/ui/Panel';
import { Screen } from '@/components/ui/Screen';
import type { CloudCatalogService, CloudLead } from '@/lib/cloud/types';
import { formatRelative } from '@/lib/time';
import { useCloud } from '@/store/cloud-store';
import { colors, fonts, radius, spacing } from '@/theme';

function relativeFromIso(iso: string | null): string {
  if (!iso) return 'never';
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? formatRelative(parsed) : 'unknown';
}

function money(cents: number | null): string {
  if (cents === null) return 'not priced';
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

function scoreTone(score: number | null): string {
  if (score === null) return colors.textDim;
  if (score >= 80) return colors.success;
  if (score >= 60) return colors.cyan;
  if (score >= 40) return colors.amber;
  return colors.danger;
}

function leadTone(status: CloudLead['status']): string {
  switch (status) {
    case 'qualified':
      return colors.success;
    case 'researched':
      return colors.cyan;
    case 'rejected':
      return colors.danger;
    case 'archived':
      return colors.textDim;
    default:
      return colors.violetBright;
  }
}

function CatalogRow({
  service,
  draft,
  onChange,
  onSave,
  saving,
}: {
  service: CloudCatalogService;
  draft: string;
  onChange: (value: string) => void;
  onSave: () => void;
  saving: boolean;
}) {
  return (
    <View
      style={{
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.md,
        borderTopWidth: 1,
        borderTopColor: colors.hairline,
        gap: spacing.sm,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <AppText variant="bodyStrong" style={{ flex: 1, fontSize: 13.5 }} numberOfLines={1}>
          {service.name}
        </AppText>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs + 2 }}>
          <StatusDot color={service.enabled ? colors.success : colors.textDim} size={5} />
          <AppText
            variant="micro"
            style={{ color: service.enabled ? colors.success : colors.textDim }}
          >
            {service.enabled ? 'ENABLED' : 'OFF'}
          </AppText>
        </View>
      </View>

      <AppText variant="micro" style={{ letterSpacing: 0.3, color: colors.textDim }}>
        {`${service.delivery_days} DAYS · ${service.revisions} REVISION(S) · ${money(
          service.price_cents,
        ).toUpperCase()}`}
      </AppText>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <View style={{ flex: 1 }}>
          <TextInput
            value={draft}
            onChangeText={onChange}
            placeholder="Price in USD"
            placeholderTextColor={colors.textDim}
            keyboardType="decimal-pad"
            maxLength={9}
            style={{
              color: colors.text,
              fontFamily: fonts.body,
              fontSize: 14,
              paddingHorizontal: spacing.md,
              paddingVertical: spacing.sm + 2,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: colors.panelBorder,
              backgroundColor: 'rgba(10, 14, 28, 0.9)',
            }}
          />
        </View>
        <Pressable
          onPress={onSave}
          disabled={saving}
          style={({ pressed }) => ({
            opacity: saving ? 0.5 : pressed ? 0.7 : 1,
            paddingHorizontal: spacing.lg,
            paddingVertical: spacing.sm + 2,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: `${colors.violet}55`,
            backgroundColor: 'rgba(139, 92, 246, 0.12)',
          })}
        >
          <AppText variant="micro" style={{ color: colors.violetBright }}>
            SAVE & ENABLE
          </AppText>
        </Pressable>
      </View>
    </View>
  );
}

export default function CompanyScreen() {
  const cloud = useCloud();
  const router = useRouter();

  const [query, setQuery] = useState('');
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  // null means "not edited yet", so the stored value shows and a refresh wins.
  const [industriesDraft, setIndustriesDraft] = useState<string | null>(null);
  const [geographyDraft, setGeographyDraft] = useState<string | null>(null);
  const [capDraft, setCapDraft] = useState<string | null>(null);
  const [thresholdDraft, setThresholdDraft] = useState<string | null>(null);

  const settings = cloud.health?.settings;
  const discoveryEnabled = settings?.discovery_enabled ?? false;
  const cap = settings?.daily_lead_cap ?? 0;
  const threshold = settings?.score_threshold ?? 60;
  const lastRun = cloud.discoveryRuns[0] ?? null;

  const industriesText = industriesDraft ?? (settings?.industries ?? []).join(', ');
  const geographyText = geographyDraft ?? (settings?.geography ?? []).join(', ');
  const capText = capDraft ?? String(cap);
  const thresholdText = thresholdDraft ?? String(threshold);

  const parseList = (value: string): string[] => {
    const seen = new Set<string>();
    const items: string[] = [];
    for (const raw of value.split(',')) {
      const item = raw.trim().replace(/\s+/g, ' ').slice(0, 60);
      if (!item) continue;
      const key = item.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
      if (items.length >= 8) break;
    }
    return items;
  };

  const saveDiscoverySettings = async () => {
    const capValue = Number.parseInt(capText, 10);
    const thresholdValue = Number.parseInt(thresholdText, 10);

    const result = await cloud.updateSettings({
      industries: parseList(industriesText),
      geography: parseList(geographyText),
      daily_lead_cap: Number.isFinite(capValue) ? Math.max(0, Math.min(200, capValue)) : cap,
      score_threshold: Number.isFinite(thresholdValue)
        ? Math.max(0, Math.min(100, thresholdValue))
        : threshold,
    });

    if (result.ok) {
      setIndustriesDraft(null);
      setGeographyDraft(null);
      setCapDraft(null);
      setThresholdDraft(null);
    }
  };

  const savePrice = async (service: CloudCatalogService) => {
    const draft = prices[service.id];
    const value = Number.parseFloat(draft ?? '');
    if (!Number.isFinite(value) || value < 0) {
      return;
    }
    setSavingId(service.id);
    await cloud.setCatalogPrice(service.id, Math.round(value * 100), service.delivery_days);
    setSavingId(null);
  };

  if (!cloud.session) {
    return (
      <Screen eyebrow="Nova OS" title="Company" subtitle="Discovery, catalog and leads.">
        <Panel accent={colors.amber}>
          <EmptyState
            icon="lock-closed-outline"
            title="Sign in to the cloud"
            body="Discovery runs on the worker, not on this phone. Sign in on the Cloud screen to reach the queue, the catalog and the leads."
            actionLabel="Open cloud"
            onAction={() => router.push('/cloud')}
          />
        </Panel>
      </Screen>
    );
  }

  return (
    <Screen
      eyebrow="Nova OS"
      title="Company"
      subtitle="Local Reach Workshop · discovery to pipeline."
    >
      <FadeInView>
        <Panel accent={discoveryEnabled ? colors.success : colors.amber}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <StatusDot color={discoveryEnabled ? colors.success : colors.amber} size={7} />
            <AppText variant="heading">
              {discoveryEnabled ? 'DISCOVERY ARMED' : 'DISCOVERY OFF'}
            </AppText>
          </View>
          <AppText variant="caption" style={{ marginTop: spacing.sm }}>
            {discoveryEnabled
              ? `ATLAS will keep real businesses it finds. Daily cap ${cap}, qualification threshold ${threshold}.`
              : 'Nothing is searched until you arm discovery. Scores and the worker stay available.'}
          </AppText>

          <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md }}>
            <View style={{ flex: 1 }}>
              <NeonButton
                label={discoveryEnabled ? 'Disarm' : 'Arm discovery'}
                icon={discoveryEnabled ? 'pause-outline' : 'play-outline'}
                variant={discoveryEnabled ? 'ghost' : 'solid'}
                onPress={() => void cloud.setDiscoveryEnabled(!discoveryEnabled)}
                loading={cloud.busy === 'settings'}
              />
            </View>
            <View style={{ flex: 1 }}>
              <NeonButton
                label="Outreach"
                icon="mail-outline"
                variant="ghost"
                onPress={() => router.push('/outreach')}
              />
            </View>
          </View>

          <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm }}>
            <View style={{ flex: 1 }}>
              <NeonButton
                label="Quotes"
                icon="document-text-outline"
                variant="ghost"
                onPress={() => router.push('/quotes')}
              />
            </View>
            <View style={{ flex: 1 }}>
              <NeonButton
                label="Pipeline"
                icon="git-branch-outline"
                variant="ghost"
                onPress={() => router.push('/pipeline')}
              />
            </View>
          </View>
        </Panel>
      </FadeInView>

      <FadeInView delay={30} style={{ marginTop: spacing.xxl }}>
        <SectionHeader label="Discovery settings" />
        <Panel style={{ gap: spacing.md }}>
          <AppText variant="caption">
            ATLAS searches these industries in these areas and keeps what it finds. Leave a field
            empty and the run falls back to a generic small-business query.
          </AppText>

          <FormField
            label="Industries"
            placeholder="dentists, plumbers, cafes"
            value={industriesText}
            onChangeText={setIndustriesDraft}
            autoCapitalize="none"
            maxLength={240}
            hint="Comma separated, up to 8. The first one shapes the search query."
          />

          <FormField
            label="Areas"
            placeholder="Leeds, Bradford"
            value={geographyText}
            onChangeText={setGeographyDraft}
            autoCapitalize="words"
            maxLength={160}
            hint="Comma separated, up to 8. The first one is used in the query."
          />

          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            <View style={{ flex: 1 }}>
              <FormField
                label="Daily lead cap"
                placeholder="20"
                value={capText}
                onChangeText={setCapDraft}
                keyboardType="number-pad"
                maxLength={3}
                hint="0 pauses keeping new leads."
              />
            </View>
            <View style={{ flex: 1 }}>
              <FormField
                label="Score threshold"
                placeholder="60"
                value={thresholdText}
                onChangeText={setThresholdDraft}
                keyboardType="number-pad"
                maxLength={3}
                hint="At or above this, a lead qualifies."
              />
            </View>
          </View>

          <NeonButton
            label="Save settings"
            icon="save-outline"
            onPress={() => void saveDiscoverySettings()}
            loading={cloud.busy === 'settings'}
          />
        </Panel>
      </FadeInView>

      <FadeInView delay={40} style={{ marginTop: spacing.xxl }}>
        <SectionHeader label="Run discovery" />
        <Panel style={{ gap: spacing.md }}>
          <AppText variant="caption">
            ATLAS searches public web results, keeps businesses it can name and reach, then researches
            one public page each and scores them. It needs a search provider configured in Supabase
            function secrets: `SEARCH_PROVIDER` plus `TAVILY_API_KEY` or `BRAVE_SEARCH_API_KEY`.
          </AppText>

          <FormField
            label="Query (optional)"
            placeholder="dentists in Leeds with no website"
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            maxLength={200}
            hint="Leave empty to use your configured industries and areas."
          />

          <NeonButton
            label="Queue discovery"
            icon="search-outline"
            onPress={() => void cloud.runDiscovery(query)}
            loading={cloud.busy === 'discovery'}
            disabled={!discoveryEnabled}
          />
          <NeonButton
            label="Run worker now"
            icon="flash-outline"
            variant="ghost"
            onPress={() => void cloud.runWorker()}
            loading={cloud.busy === 'worker'}
          />

          {lastRun ? (
            <View
              style={{
                marginTop: spacing.sm,
                paddingTop: spacing.md,
                borderTopWidth: 1,
                borderTopColor: colors.hairline,
                gap: 3,
              }}
            >
              <AppText variant="micro" style={{ letterSpacing: 1, color: colors.textMuted }}>
                {`LAST RUN · ${lastRun.status.toUpperCase()} · ${relativeFromIso(lastRun.started_at)}`}
              </AppText>
              <AppText variant="caption" numberOfLines={2}>
                {lastRun.query || 'no query'}
              </AppText>
              <AppText variant="micro" style={{ letterSpacing: 0.4 }}>
                {`FOUND ${lastRun.found} · KEPT ${lastRun.inserted} · SKIPPED ${lastRun.skipped}`}
              </AppText>
              {lastRun.error ? (
                <AppText variant="micro" style={{ color: colors.danger, letterSpacing: 0 }}>
                  {lastRun.error}
                </AppText>
              ) : null}
            </View>
          ) : null}
        </Panel>
      </FadeInView>

      <FadeInView delay={80} style={{ marginTop: spacing.xxl }}>
        <SectionHeader label="Service catalog" />
        <Panel padded={false}>
          <View style={{ padding: spacing.lg, paddingBottom: spacing.sm }}>
            <AppText variant="caption">
              A service cannot be enabled without a price, and NOVA never invents one. Set your price
              here and the service becomes recommendable.
            </AppText>
          </View>
          {cloud.catalog.length === 0 ? (
            <View style={{ padding: spacing.lg }}>
              <EmptyState
                compact
                icon="pricetags-outline"
                title="No services yet"
                body="The catalog is seeded when your owner account is created. Refresh if this stays empty."
              />
            </View>
          ) : (
            cloud.catalog.map((service) => (
              <CatalogRow
                key={service.id}
                service={service}
                draft={
                  prices[service.id] ??
                  (service.price_cents !== null ? (service.price_cents / 100).toFixed(2) : '')
                }
                onChange={(value) =>
                  setPrices((previous) => ({ ...previous, [service.id]: value }))
                }
                onSave={() => void savePrice(service)}
                saving={savingId === service.id}
              />
            ))
          )}
        </Panel>
      </FadeInView>

      <FadeInView delay={120} style={{ marginTop: spacing.xxl }}>
        <SectionHeader
          label={`Leads · ${cloud.leads.length}`}
          actionLabel={cloud.busy === 'refresh' ? 'Refreshing' : 'Refresh'}
          onAction={() => void cloud.refresh()}
        />
        <Panel padded={false}>
          {cloud.leads.length === 0 ? (
            <View style={{ padding: spacing.lg }}>
              <EmptyState
                compact
                icon="business-outline"
                title="No leads yet"
                body="Arm discovery, queue a run and let the worker execute it. Only real businesses it found will appear here."
              />
            </View>
          ) : (
            cloud.leads.map((lead) => (
              <View
                key={lead.id}
                style={{
                  paddingHorizontal: spacing.lg,
                  paddingVertical: spacing.md,
                  borderTopWidth: 1,
                  borderTopColor: colors.hairline,
                  gap: 3,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                  <AppText variant="bodyStrong" style={{ flex: 1, fontSize: 13.5 }} numberOfLines={1}>
                    {lead.business_name}
                  </AppText>
                  <AppText variant="title" style={{ fontSize: 16, color: scoreTone(lead.score) }}>
                    {lead.score === null ? '—' : String(lead.score)}
                  </AppText>
                </View>
                <AppText variant="micro" numberOfLines={1} style={{ letterSpacing: 0.4 }}>
                  {lead.domain ?? lead.website ?? 'no website'} · {lead.status.toUpperCase()}
                </AppText>
                {lead.recommended_service ? (
                  <AppText variant="micro" style={{ color: colors.violetBright, letterSpacing: 0.3 }}>
                    {`RECOMMENDED · ${lead.recommended_service.toUpperCase()}`}
                  </AppText>
                ) : (
                  <AppText variant="micro" style={{ color: colors.amber, letterSpacing: 0.3 }}>
                    NO PRICED SERVICE ENABLED
                  </AppText>
                )}
                <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'center' }}>
                  <StatusDot color={leadTone(lead.status)} size={4} />
                  <AppText variant="micro" style={{ letterSpacing: 0.4 }}>
                    {`FOUND ${relativeFromIso(lead.discovered_at)} · CONFIDENCE ${
                      lead.research_confidence === null
                        ? '—'
                        : `${Math.round(lead.research_confidence * 100)}%`
                    }`}
                  </AppText>
                </View>
              </View>
            ))
          )}
        </Panel>
      </FadeInView>

      <FadeInView delay={160} style={{ marginTop: spacing.xxl }}>
        <Panel>
          <AppText variant="caption">
            Scores are deterministic: industry match, area match, website presence and reachability,
            HTTPS, content depth, a public contact address and captured evidence. Every reason is stored
            with the lead, so a score can always be explained.
          </AppText>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md }}>
            <Chip label={`Cap ${cap}/day`} color={colors.cyan} />
            <Chip label={`Threshold ${threshold}`} color={colors.violet} />
            <Chip label={`${cloud.catalog.filter((s) => s.enabled).length} priced services`} color={colors.emerald} />
          </View>
        </Panel>
      </FadeInView>
    </Screen>
  );
}
