import { supabase } from './supabase';
import { invokeFn } from './functions';
import { localDateString } from './dateUtils';
import type { FwDraft, FwDraftType, FwEventType } from './types';

export interface DraftContext {
  application_id?: string;
  contact_id?: string;
  extra_context?: string;
}

/** Calls the `draft` edge function for the body text only (SPEC.md principle #2: the app
 * never sends anything — this never touches fw_drafts, the caller does). */
export async function generateDraftBody(type: FwDraftType, context: DraftContext): Promise<string> {
  const res = await invokeFn<{ body: string }>('draft', { type, ...context });
  return res.body;
}

export async function insertDraft(input: {
  type: FwDraftType;
  body: string;
  application_id?: string | null;
  contact_id?: string | null;
}): Promise<FwDraft> {
  const { data, error } = await supabase
    .from('fw_drafts')
    .insert({
      type: input.type,
      body: input.body,
      application_id: input.application_id ?? null,
      contact_id: input.contact_id ?? null,
      status: 'draft',
    } as never)
    .select()
    .single();
  if (error) throw error;
  return data as FwDraft;
}

export async function updateDraftBody(draftId: string, body: string): Promise<void> {
  const { error } = await supabase.from('fw_drafts').update({ body } as never).eq('id', draftId);
  if (error) throw error;
}

const DRAFT_TYPE_TO_EVENT: Partial<Record<FwDraftType, FwEventType>> = {
  nudge: 'nudge',
  thank_you: 'thank_you',
};

const DRAFT_TYPE_LABEL: Record<FwDraftType, string> = {
  hello: 'Hello',
  nudge: 'Nudge',
  thank_you: 'Thank-you',
  stay_in_touch: 'Stay-in-touch',
  cover_letter: 'Cover letter',
  application_question: 'Application question answer',
};

/** Marks a draft sent — the one place in the app a "send" state change happens, always from
 * an explicit human click, never automatic (SPEC.md principle #2). Also updates the
 * timeline/contact so the Today queue and aging badges reflect the real-world action. */
export async function markDraftSent(draft: FwDraft): Promise<void> {
  const sentAt = new Date().toISOString();
  const { error } = await supabase
    .from('fw_drafts')
    .update({ status: 'sent', sent_at: sentAt } as never)
    .eq('id', draft.id);
  if (error) throw error;

  if (draft.application_id) {
    const eventType = DRAFT_TYPE_TO_EVENT[draft.type] ?? 'note';
    const { error: eventError } = await supabase.from('fw_events').insert({
      application_id: draft.application_id,
      type: eventType,
      body: `${DRAFT_TYPE_LABEL[draft.type]} marked sent`,
      occurred_at: sentAt,
    } as never);
    if (eventError) throw eventError;
  }

  if (draft.contact_id) {
    const { error: contactError } = await supabase
      .from('fw_contacts')
      // Local calendar date, not the UTC slice of the timestamp (off by one in the evening).
      .update({ last_touch: localDateString() } as never)
      .eq('id', draft.contact_id);
    if (contactError) throw contactError;
  }
}
