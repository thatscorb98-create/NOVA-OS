import type { ModelToolDefinition } from '@/lib/model/client';
import { DELEGATABLE_AGENT_IDS } from '@/data/agents';
import type { AgentToolId } from '@/types/nova';

/**
 * Tool schemas exposed to the model. Every tool is executed locally against the
 * real workspace; results are persisted. Nothing is simulated.
 */

const DEFINITIONS: Record<AgentToolId, ModelToolDefinition> = {
  delegate_task: {
    type: 'function',
    function: {
      name: 'delegate_task',
      description:
        'Hand a task to a specialist agent. The agent runs immediately with its own instructions and returns its finished work. A mission record is created and the result is stored.',
      parameters: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            enum: DELEGATABLE_AGENT_IDS,
            description: 'Specialist to run the task.',
          },
          task: {
            type: 'string',
            description: 'A complete, self-contained brief of what to produce.',
          },
          context: {
            type: 'string',
            description: 'Optional context the specialist needs (constraints, audience, deadlines).',
          },
        },
        required: ['agent', 'task'],
      },
    },
  },
  create_mission: {
    type: 'function',
    function: {
      name: 'create_mission',
      description:
        'Create a mission in the workspace for the owner to run later. Does not execute work.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short mission title.' },
          objective: { type: 'string', description: 'What success looks like.' },
          agent: {
            type: 'string',
            enum: DELEGATABLE_AGENT_IDS,
            description: 'Specialist the mission is assigned to.',
          },
        },
        required: ['title', 'agent'],
      },
    },
  },
  list_workspace: {
    type: 'function',
    function: {
      name: 'list_workspace',
      description:
        'Read the current workspace: open missions, completed work, projects and your most relevant saved memories. Use before assuming what exists.',
      parameters: { type: 'object', properties: {} },
    },
  },
  complete_mission: {
    type: 'function',
    function: {
      name: 'complete_mission',
      description: 'Mark an existing mission complete and store the summary as its result.',
      parameters: {
        type: 'object',
        properties: {
          mission_id: { type: 'string', description: 'Id from list_workspace.' },
          summary: { type: 'string', description: 'What was actually produced.' },
        },
        required: ['mission_id', 'summary'],
      },
    },
  },
  save_memory: {
    type: 'function',
    function: {
      name: 'save_memory',
      description:
        'Save a durable fact, preference or decision so it can be recalled in future conversations. Keep it under 300 characters and self-contained.',
      parameters: {
        type: 'object',
        properties: {
          note: { type: 'string', description: 'The fact to remember.' },
          scope: {
            type: 'string',
            enum: ['agent', 'global', 'project'],
            description:
              'agent = private to you, global = shared by every agent, project = tied to one project.',
          },
          project_id: {
            type: 'string',
            description: 'Required when scope is project. Use an id from list_workspace.',
          },
          kind: {
            type: 'string',
            enum: ['fact', 'preference', 'decision', 'note'],
            description: 'What kind of memory this is.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional keywords that make this easier to recall.',
          },
        },
        required: ['note'],
      },
    },
  },
  recall_memory: {
    type: 'function',
    function: {
      name: 'recall_memory',
      description:
        'Search your persistent memory and past conversations for anything relevant to a topic. Use when the owner refers to earlier work, preferences or projects.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What to look for, e.g. "pricing decision" or "launch audience".',
          },
          scope: {
            type: 'string',
            enum: ['all', 'global', 'project', 'agent', 'conversation'],
            description: 'Optional scope filter. Defaults to all memories you can access.',
          },
        },
        required: ['query'],
      },
    },
  },
};

export function toolDefinitionsFor(ids: AgentToolId[]): ModelToolDefinition[] {
  return ids.map((id) => DEFINITIONS[id]).filter(Boolean);
}
