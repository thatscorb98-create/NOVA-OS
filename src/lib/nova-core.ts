import { colors } from '@/theme';

/**
 * Connection state of the NOVA reasoning core.
 *
 * Phase One ships the interface only: no provider is connected, so the app
 * never renders a generated reply. When the model layer lands in Phase Two it
 * will report `connected` here and the chat screen will enable live replies.
 */
export interface CoreConfig {
  status: 'not_connected' | 'connected';
  provider: string;
  model: string | null;
  label: string;
  detail: string;
}

export const NOVA_CORE: CoreConfig = {
  status: 'not_connected',
  provider: 'NVIDIA NIM',
  model: null,
  label: 'CORE OFFLINE',
  detail:
    'The reasoning core is not connected yet. Live replies arrive in Phase Two — nothing in the chat is simulated.',
};

export const CORE_STATUS_COLOR =
  NOVA_CORE.status === 'connected' ? colors.success : colors.amber;
