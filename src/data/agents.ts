import type { Agent, AgentId } from '@/types/nova';
import { colors } from '@/theme';

/**
 * The NOVA agent roster.
 *
 * These are capability definitions only. Nothing here is a record of work:
 * live task counts are always derived from missions the user actually created.
 */
export const AGENTS: Agent[] = [
  {
    id: 'nova',
    name: 'NOVA',
    role: 'Central Intelligence',
    tagline: 'Understands goals, plans missions and coordinates the whole network.',
    description:
      'NOVA is the operating intelligence of the system. It translates a goal into a mission plan, routes work to the right specialist, tracks progress and reports back. Every other agent reports through NOVA.',
    accent: colors.violet,
    icon: 'planet',
    capabilities: ['Goal decomposition', 'Mission planning', 'Agent routing', 'Progress reporting'],
  },
  {
    id: 'atlas',
    name: 'ATLAS',
    role: 'Research & Analysis',
    tagline: 'Maps unknown territory and turns raw information into briefings.',
    description:
      'ATLAS investigates markets, competitors, technologies and open questions. It builds structured research briefs with sources so decisions are never made on guesswork.',
    accent: colors.cyan,
    icon: 'search',
    capabilities: ['Deep research', 'Competitor mapping', 'Source synthesis', 'Market sizing'],
  },
  {
    id: 'forge',
    name: 'FORGE',
    role: 'Engineering',
    tagline: 'Designs, writes and repairs software across the stack.',
    description:
      'FORGE is the engineering specialist. It plans implementation, writes code, reviews diffs and debugs failures, keeping changes small enough to verify.',
    accent: colors.orange,
    icon: 'code-slash',
    capabilities: ['Architecture', 'Code generation', 'Debugging', 'Code review'],
  },
  {
    id: 'echo',
    name: 'ECHO',
    role: 'Marketing & Content',
    tagline: 'Turns positioning into campaigns, copy and social presence.',
    description:
      'ECHO owns the voice of the business: launch narratives, content calendars, landing copy and social posts, always aligned to one clear message.',
    accent: colors.pink,
    icon: 'megaphone',
    capabilities: ['Content strategy', 'Copywriting', 'Campaign planning', 'Social scheduling'],
  },
  {
    id: 'sterling',
    name: 'STERLING',
    role: 'Business Strategy',
    tagline: 'Models revenue, pricing and the economics of every decision.',
    description:
      'STERLING analyses business models, unit economics, pricing and risk. It produces decision-ready financial summaries instead of raw spreadsheets.',
    accent: colors.emerald,
    icon: 'stats-chart',
    capabilities: ['Business modelling', 'Pricing strategy', 'Financial analysis', 'Risk review'],
  },
  {
    id: 'relay',
    name: 'RELAY',
    role: 'Operations',
    tagline: 'Keeps missions moving and dependencies unblocked.',
    description:
      'RELAY is the operations layer. It sequences work, tracks blockers, manages hand-offs between agents and makes sure nothing silently stalls.',
    accent: colors.blue,
    icon: 'git-network',
    capabilities: ['Task sequencing', 'Dependency tracking', 'Hand-offs', 'Status reporting'],
  },
  {
    id: 'sentinel',
    name: 'SENTINEL',
    role: 'Quality & Safety',
    tagline: 'Reviews output, guards safety and demands approval where needed.',
    description:
      'SENTINEL checks finished work for accuracy, risk and policy. It blocks anything that needs human approval before it leaves the system.',
    accent: colors.red,
    icon: 'shield-checkmark',
    capabilities: ['Quality review', 'Risk assessment', 'Policy checks', 'Approval gates'],
  },
];

export const AGENT_MAP: Record<AgentId, Agent> = AGENTS.reduce(
  (acc, agent) => ({ ...acc, [agent.id]: agent }),
  {} as Record<AgentId, Agent>,
);

export function getAgent(id: AgentId): Agent {
  return AGENT_MAP[id] ?? AGENT_MAP.nova;
}

export const DEFAULT_AGENT_ID: AgentId = 'nova';
