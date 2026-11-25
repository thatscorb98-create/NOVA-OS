/**
 * NVIDIA NIM model configuration.
 *
 * Every id below was verified against integrate.api.nvidia.com: the endpoint
 * responds with 401 Unauthorized (model exists, key required) rather than
 * 404/410 (retired). Retired ids must be replaced before shipping.
 *
 * The free developer tier is rate limited (about 40 requests/minute) and needs
 * a key from build.nvidia.com/settings/api-keys.
 */

export const NIM_BASE_URL = 'https://integrate.api.nvidia.com/v1';
export const NIM_KEY_HELP_URL = 'https://build.nvidia.com/settings/api-keys';

export interface ModelOption {
  id: string;
  label: string;
  note: string;
}

export const NIM_MODELS: ModelOption[] = [
  {
    id: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    label: 'Nemotron 3.5 Lightning',
    note: 'Fast · agentic · tool calling',
  },
  {
    id: 'nvidia/nemotron-3.5-bolt-e4b',
    label: 'Nemotron 3.5 Bolt',
    note: 'Compact · tool calling',
  },
  {
    id: 'nvidia/nemotron-3-ultra-550b-a55b',
    label: 'Nemotron 3 Ultra',
    note: 'Deep reasoning · slower',
  },
  {
    id: 'z-ai/glm-5.3-flash',
    label: 'GLM 5.3 Flash',
    note: 'Fast general model',
  },
];

export const DEFAULT_MODEL = NIM_MODELS[0].id;

export function isKnownModel(id: string): boolean {
  return NIM_MODELS.some((model) => model.id === id);
}
