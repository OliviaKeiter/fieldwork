import type { FwStatus } from './types';

/** Canonical column order — the fw_status enum order from the schema. Used as the fallback
 * when `fw_settings.board_columns` isn't set; if that key exists it wins instead. */
export const STATUS_ORDER: FwStatus[] = [
  'to_apply',
  'applied',
  'phone_screen',
  'interviewing',
  'final_round',
  'offer',
  'accepted',
  'rejected',
  'withdrawn',
  'ghosted',
  'passed',
];

export const STATUS_LABEL: Record<FwStatus, string> = {
  to_apply: 'To Apply',
  applied: 'Applied',
  phone_screen: 'Phone Screen',
  interviewing: 'Interviewing',
  final_round: 'Final Round',
  offer: 'Offer',
  accepted: 'Accepted',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  ghosted: 'Ghosted',
  passed: 'Passed',
};
