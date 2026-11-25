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
  | 'save_memory';

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

export type MissionStatus = 'queued' | 'active' | 'complete';

export interface MissionResult {
  text: string;
  agentId: AgentId;
  model: string;
  createdAt: number;
  durationMs: number;
  /** Real steps taken during the run (tool calls, delegations). */
  steps: string[];
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

export type MemorySource = 'agent' | 'user' | 'mission';

export interface MemoryNote {
  id: string;
  text: string;
  createdAt: number;
  source: MemorySource;
}

export interface AgentMemory {
  notes: MemoryNote[];
  updatedAt: number;
}

export interface AgentState {
  enabled: boolean;
}

export interface AppSettings {
  /** Active NVIDIA NIM model id. */
  model: string;
}
