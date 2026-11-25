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
}

export type MissionStatus = 'queued' | 'active' | 'complete';

export interface Mission {
  id: string;
  title: string;
  objective: string;
  agentId: AgentId;
  projectId?: string;
  status: MissionStatus;
  createdAt: number;
  updatedAt: number;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  accent: string;
  createdAt: number;
}

export type MessageRole = 'user' | 'nova' | 'system';

export interface Message {
  id: string;
  role: MessageRole;
  text: string;
  createdAt: number;
  agentId?: AgentId;
}

export type ActivityKind = 'mission' | 'project' | 'system' | 'chat';

export interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  label: string;
  detail?: string;
  createdAt: number;
}
