import { getAgent } from '@/data/agents';
import { colors } from '@/theme';
import type {
  AgentId,
  MemoryKind,
  MemoryRecord,
  MemoryScope,
  Project,
} from '@/types/nova';
import type { IconName } from '@/types/nova';

/**
 * Local memory retrieval.
 *
 * Relevance is lexical (token overlap + recency + scope affinity), computed on
 * the device. That keeps recall free, private and offline, and means the app
 * never sends your saved memories anywhere except inside the model prompt.
 */

export const MEMORY_SCOPES: { key: MemoryScope; label: string; color: string; icon: IconName }[] = [
  { key: 'global', label: 'Global', color: colors.violetBright, icon: 'earth-outline' },
  { key: 'project', label: 'Project', color: colors.cyan, icon: 'layers-outline' },
  { key: 'agent', label: 'Agent', color: colors.emerald, icon: 'person-outline' },
  { key: 'conversation', label: 'Conversation', color: colors.amber, icon: 'chatbubbles-outline' },
];

export const MEMORY_KINDS: { key: MemoryKind; label: string }[] = [
  { key: 'fact', label: 'Fact' },
  { key: 'preference', label: 'Preference' },
  { key: 'decision', label: 'Decision' },
  { key: 'summary', label: 'Summary' },
  { key: 'note', label: 'Note' },
];

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'had', 'was', 'were',
  'are', 'you', 'your', 'yours', 'our', 'ours', 'their', 'them', 'they', 'his', 'her', 'its',
  'not', 'but', 'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must',
  'what', 'when', 'where', 'which', 'who', 'whom', 'why', 'how', 'all', 'any', 'some', 'more',
  'most', 'very', 'too', 'also', 'into', 'onto', 'over', 'under', 'about', 'after', 'before',
  'than', 'then', 'there', 'here', 'been', 'being', 'does', 'did', 'done', 'get', 'got',
  'make', 'made', 'just', 'like', 'want', 'need', 'please', 'give', 'tell', 'show', 'know',
  'think', 'going', 'use', 'using', 'used', 'one', 'two', 'out', 'off', 'own', 'per', 'via',
  'як', 'для', 'що', 'це', 'the', 'und', 'der', 'die', 'das', 'les', 'des', 'que', 'pour',
]);

export function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

export function normalizeMemoryText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Extract a few useful tags from free text, used for recall matching. */
export function extractTags(text: string, max = 6): string[] {
  const counts = new Map<string, number>();

  for (const token of tokenize(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([token]) => token);
}

export interface RecallContext {
  agentId?: AgentId;
  projectId?: string;
}

export function scoreMemory(
  memory: MemoryRecord,
  queryTokens: string[],
  context: RecallContext = {},
): number {
  const haystack = new Set(tokenize(`${memory.text} ${memory.tags.join(' ')}`));
  const uniqueQuery = [...new Set(queryTokens)];

  let overlap = 0;
  for (const token of uniqueQuery) {
    if (haystack.has(token)) overlap += 1;
  }

  const coverage = uniqueQuery.length === 0 ? 0 : overlap / Math.min(uniqueQuery.length, 8);

  let score = overlap * 1.5 + coverage * 5;

  if (memory.pinned) score += 6;
  if (memory.scope === 'global') score += 0.5;
  if (memory.kind === 'preference' || memory.kind === 'decision') score += 1;
  if (memory.agentId && memory.agentId === context.agentId) score += 2;
  if (memory.projectId && memory.projectId === context.projectId) score += 3;

  const ageDays = (Date.now() - memory.updatedAt) / 86_400_000;
  score += Math.max(0, 1.5 - ageDays / 21);

  return score;
}

/**
 * Return the memories most worth putting in front of an agent for this turn.
 * With an empty query, pinned and recent memories are returned instead, which
 * gives agents a stable baseline of context.
 */
export function recallMemories({
  memories,
  query,
  agentId,
  projectId,
  limit = 8,
  minScore = 2,
}: {
  memories: MemoryRecord[];
  query: string;
  agentId?: AgentId;
  projectId?: string;
  limit?: number;
  minScore?: number;
}): MemoryRecord[] {
  const tokens = tokenize(query);

  if (tokens.length === 0) {
    return memories
      .slice()
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  return memories
    .map((memory) => ({
      memory,
      score: scoreMemory(memory, tokens, { agentId, projectId }),
    }))
    .filter((entry) => entry.memory.pinned || entry.score >= minScore)
    .sort((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt)
    .slice(0, limit)
    .map((entry) => entry.memory);
}

export function memoryScopeLabel(
  memory: MemoryRecord,
  projects: Project[] = [],
): string {
  if (memory.scope === 'project') {
    return projects.find((project) => project.id === memory.projectId)?.name ?? 'Project';
  }
  if (memory.scope === 'agent') {
    return memory.agentId ? getAgent(memory.agentId).name : 'Agent';
  }
  if (memory.scope === 'conversation') {
    return memory.agentId ? `${getAgent(memory.agentId).name} chat` : 'Conversation';
  }
  return 'Global';
}

function memoryLine(memory: MemoryRecord, projects: Project[]): string {
  const where = memoryScopeLabel(memory, projects);
  const pin = memory.pinned ? ' · pinned' : '';
  return `- [${memory.kind} · ${where}${pin}] ${memory.text}`;
}

/**
 * Format recalled memories for the model prompt, bounded so memory can never
 * crowd out the actual conversation.
 */
export function formatMemoriesForPrompt(
  memories: MemoryRecord[],
  projects: Project[] = [],
  maxChars = 2400,
): string {
  const lines: string[] = [];
  let used = 0;

  for (const memory of memories) {
    const line = memoryLine(memory, projects);
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }

  return lines.join('\n');
}

export function countMemoriesByScope(memories: MemoryRecord[]): Record<MemoryScope, number> {
  return memories.reduce(
    (acc, memory) => {
      acc[memory.scope] += 1;
      return acc;
    },
    { global: 0, project: 0, agent: 0, conversation: 0 } as Record<MemoryScope, number>,
  );
}

/** Search across all fields the Memory screen lets you filter on. */
export function searchMemories(
  memories: MemoryRecord[],
  query: string,
  projects: Project[] = [],
): MemoryRecord[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return memories;

  return memories.filter((memory) => {
    const haystack = [
      memory.text,
      memory.kind,
      memory.scope,
      memory.tags.join(' '),
      memoryScopeLabel(memory, projects),
    ]
      .join(' ')
      .toLowerCase();

    return haystack.includes(needle);
  });
}
