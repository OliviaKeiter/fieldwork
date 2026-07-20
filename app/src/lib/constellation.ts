import type { FwGrade, FwStatus } from './types';

/* The constellation is Fieldwork's visual theme: the pipeline drawn as a small
 * universe. These constants are the vocabulary — one hue and one orbit per
 * stage — shared by the Constellation view, the dossier's orbit badge, the
 * star-burst celebration, and anything else that speaks it. Keep them here so
 * the sky never disagrees with itself between screens. */

/** The galaxy IS the funnel: each active stage is an orbit, and advancing a
 *  role pulls its star inward toward the glowing core. An offer is almost home. */
export const STATUS_RING: Partial<Record<FwStatus, number>> = {
  to_apply: 1.0,
  applied: 0.82,
  phone_screen: 0.64,
  interviewing: 0.47,
  final_round: 0.31,
  offer: 0.17,
  accepted: 0.07,
};

/** Closed-out roles drift in the outer dust — still part of the record, no
 *  longer part of the pull. */
export const DUST_STATUSES: FwStatus[] = ['rejected', 'withdrawn', 'ghosted', 'passed'];

/** One hue per stage, warm side of the wheel first, so the sky reads as the
 *  pipeline at a glance. Deliberately varied — a universe, not a monochrome. */
export const STATUS_COLOR: Record<FwStatus, string> = {
  to_apply: '#cdbba1',
  applied: '#e08a3c',
  phone_screen: '#e5b54e',
  interviewing: '#8fae6c',
  final_round: '#79c2a5',
  offer: '#f3d05f',
  accepted: '#ffe9b0',
  rejected: '#c65b4a',
  withdrawn: '#9b8f7c',
  ghosted: '#8494a8',
  passed: '#7a7062',
};

/** Better-graded roles burn brighter. */
export const GRADE_SIZE: Record<FwGrade, number> = {
  'A+': 3.4,
  A: 3.0,
  B: 2.5,
  C: 2.1,
  D: 1.9,
  F: 1.8,
};

/** The celebration palette — the active-stage hues, for star-bursts. */
export const CELEBRATION_COLORS = ['#f3d05f', '#e08a3c', '#e5b54e', '#8fae6c', '#79c2a5', '#ffe9b0'];
