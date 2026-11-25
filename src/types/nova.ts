import { Ionicons } from '@expo/vector-icons';

export type IconName = React.ComponentProps<typeof Ionicons>['name'];

export type AgentId =
  | 'nova'
  | 'atlas'
  | 'forge'
  | 'echo'
  | 'sterling'
  | 'relay'
  | 'sentinel';

export type AgentToolId =
  | 'delegate_task'
  | 'create_mission'
  | 'list_workspace'
  | 'complete_mission'
  | 'save_memory'
  | 'recall_memory';

export interface Agent {
  /** Stable identifier used in storage and routing. */
  id: AgentId;
  name: string;
  role: string;
  tagline: string;
  description: string;
  /** Accent colour used across cards, glyphs and detail screens. */
  accent: string;
  icon: IconName;
  capabilities: string[];
  /** System instructions sent to the model before every conversation. */
  systemPrompt: string;
  /** Style and temperament directives layered onto the system prompt. */
  personality: string;
  temperature: number;
  tools: AgentToolId[];
}

export type MissionStatus =
  | 'queued'
  | 'planning'
  | 'awaiting_approval'
  | 'active'
  | 'reviewing'
  | 'complete'
  | 'failed'
  | 'cancelled';

/** A single objective handed to one agent, or a NOVA-coordinated plan. */
export type MissionKind = 'single' | 'planned';

/** auto = plan and execute, review = plan waits for owner approval. */
export type MissionRunMode = 'auto' | 'review';

export interface MissionResult {
  text: string;
  agentId: AgentId;
  model: string;
  createdAt: number;
  durationMs: number;
  /** Real steps taken during the run (tool calls, delegations, tasks). */
  steps: string[];
}

export type MissionTaskStatus =
  | 'queued'
  | 'running'
  | 'review'
  | 'complete'
  | 'failed'
  | 'blocked';

export interface MissionTaskReview {
  verdict: 'pass' | 'retry';
  notes: string;
  model: string;
  createdAt: number;
}

/** One delegated unit of a planned mission. */
export interface MissionTask {
  id: string;
  title: string;
  brief: string;
  agentId: AgentId;
  status: MissionTaskStatus;
  /** Ids of tasks that must complete before this one runs. */
  dependsOn: string[];
  /** Work attempts already spent. */
  attempt: number;
  maxAttempts: number;
  output?: string;
  review?: MissionTaskReview;
  error?: string;
  model?: string;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
}

/** Hard limits for one mission, persisted so they survive restarts. */
export interface MissionBudget {
  maxTasks: number;
  maxCalls: number;
  maxAttempts: number;
  callsUsed: number;
  startedAt: number;
  /** End of the current run window; 0 means no window is active. */
  deadlineAt: number;
}

export type MissionApprovalKind = 'plan' | 'escalation';

/** A gate that stops the run until the owner decides. */
export interface MissionApproval {
  id: string;
  kind: MissionApprovalKind;
  status: 'pending' | 'approved' | 'rejected';
  note: string;
  taskId?: string;
  createdAt: number;
  resolvedAt?: number;
}

export interface MissionEvent {
  id: string;
  label: string;
  detail?: string;
  createdAt: number;
}

export interface MissionReport {
  text: string;
  model: string;
  createdAt: number;
  completed: number;
  failed: number;
  callsUsed: number;
  durationMs: number;
}

export interface Mission {
  id: string;
  title: string;
  objective: string;
  agentId: AgentId;
  projectId?: string;
  status: MissionStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  result?: MissionResult;
  /** single = one agent run, planned = NOVA plans and delegates. */
  kind: MissionKind;
  mode: MissionRunMode;
  tasks: MissionTask[];
  budget: MissionBudget;
  approval?: MissionApproval;
  report?: MissionReport;
  /** Ordered execution log for this mission. */
  history: MissionEvent[];
  planModel?: string;
  planCreatedAt?: number;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  accent: string;
  createdAt: number;
}

export type MessageRole = 'user' | 'nova' | 'agent' | 'system';

export interface Message {
  id: string;
  role: MessageRole;
  text: string;
  createdAt: number;
  agentId?: AgentId;
}

export type ActivityKind = 'mission' | 'project' | 'system' | 'chat' | 'agent';

export interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  label: string;
  detail?: string;
  createdAt: number;
}

/** Where a memory belongs and who may recall it. */
export type MemoryScope = 'global' | 'project' | 'agent' | 'conversation';

export type MemoryKind = 'fact' | 'preference' | 'decision' | 'summary' | 'note';

export type MemorySource = 'user' | 'agent' | 'nova' | 'mission' | 'conversation';

/**
 * One durable memory. Records are created by the owner, by agents through the
 * save_memory tool, and automatically from completed missions and conversations.
 * Every record is editable and deletable from the Memory screen.
 */
export interface MemoryRecord {
  id: string;
  text: string;
  scope: MemoryScope;
  kind: MemoryKind;
  source: MemorySource;
  /** Set for agent and conversation memories. */
  agentId?: AgentId;
  /** Set for project memories. */
  projectId?: string;
  /** Groups an exchange with the conversation it came from. */
  conversationId?: string;
  tags: string[];
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AgentState {
  enabled: boolean;
}

export interface AppSettings {
  /** Active NVIDIA NIM model id. */
  model: string;
}
