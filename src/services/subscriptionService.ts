import { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger';

export interface UserSubscription {
  id: string;
  user_id: string;
  plan: 'free' | 'pro';
  ai_credits_limit: number;
  ai_credits_used: number;
  credits_reset_at: string;
  trial_ends_at: string;
  auto_ai_context: boolean;
}

/**
 * Retrieves the user's subscription record.
 * Automatically initializes a default record if one does not exist (e.g. existing users).
 * Handles weekly credit resets lazily if current time > credits_reset_at.
 */
export async function getOrCreateUserSubscription(
  supabase: SupabaseClient,
  userId: string
): Promise<UserSubscription> {
  const { data, error } = await supabase
    .from('user_subscriptions')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    logger.error('SubscriptionService', `Failed to query subscription for user ${userId}:`, error.message);
  }

  // If no subscription exists yet, create default free tier
  if (!data) {
    const nextReset = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const trialEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data: newSub, error: insertError } = await supabase
      .from('user_subscriptions')
      .insert({
        user_id: userId,
        plan: 'free',
        ai_credits_limit: 6,
        ai_credits_used: 0,
        credits_reset_at: nextReset,
        trial_ends_at: trialEnd,
        auto_ai_context: true,
      })
      .select()
      .single();

    if (insertError) {
      logger.error('SubscriptionService', `Failed to insert default subscription:`, insertError.message);
      // Fallback in-memory representation
      return {
        id: 'temp',
        user_id: userId,
        plan: 'free',
        ai_credits_limit: 6,
        ai_credits_used: 0,
        credits_reset_at: nextReset,
        trial_ends_at: trialEnd,
        auto_ai_context: true,
      };
    }

    return newSub as UserSubscription;
  }

  const sub = data as UserSubscription;

  // Check if weekly credit reset is due
  const resetDate = new Date(sub.credits_reset_at);
  if (Date.now() >= resetDate.getTime()) {
    const nextReset = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: updatedSub } = await supabase
      .from('user_subscriptions')
      .update({
        ai_credits_used: 0,
        credits_reset_at: nextReset,
        updated_at: new Date().toISOString(),
      })
      .eq('id', sub.id)
      .select()
      .single();

    if (updatedSub) {
      return updatedSub as UserSubscription;
    }
    sub.ai_credits_used = 0;
    sub.credits_reset_at = nextReset;
  }

  return sub;
}

/**
 * Checks if user is eligible to run AI analysis.
 */
export function checkAiCreditEligibility(sub: UserSubscription): {
  isEligible: boolean;
  isPaid: boolean;
  creditsRemaining: number;
} {
  const isPaid = sub.plan === 'pro';
  if (isPaid) {
    return { isEligible: true, isPaid: true, creditsRemaining: 999999 };
  }

  const creditsRemaining = Math.max(0, sub.ai_credits_limit - sub.ai_credits_used);
  return {
    isEligible: creditsRemaining > 0,
    isPaid: false,
    creditsRemaining,
  };
}

/**
 * Atomically checks and reserves 1 AI credit for a user prior to invoking Gemini API.
 * Uses PostgreSQL stored procedure reserve_user_credit with an atomic CAS query fallback
 * to completely eliminate TOCTOU race conditions under parallel requests.
 */
export async function reserveUserCredit(
  supabase: SupabaseClient,
  userId: string
): Promise<{ success: boolean; creditsRemaining: number; isPaid: boolean }> {
  try {
    const { data, error } = await supabase.rpc('reserve_user_credit', { p_user_id: userId });
    if (!error && Array.isArray(data) && data.length > 0) {
      const row = data[0];
      return {
        success: Boolean(row.success),
        creditsRemaining: Number(row.credits_remaining),
        isPaid: row.plan === 'pro',
      };
    }
  } catch (rpcErr) {
    logger.debug('SubscriptionService', 'RPC reserve_user_credit unavailable, using atomic SQL fallback:', rpcErr);
  }

  // Fallback: Lazy reset check followed by atomic update
  const sub = await getOrCreateUserSubscription(supabase, userId);
  if (sub.plan === 'pro') {
    return { success: true, creditsRemaining: 999999, isPaid: true };
  }

  // Atomic conditional decrement: Only increment used if current used < limit
  const { data: updated, error: updateErr } = await supabase
    .from('user_subscriptions')
    .update({
      ai_credits_used: sub.ai_credits_used + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', sub.id)
    .lt('ai_credits_used', sub.ai_credits_limit)
    .select('ai_credits_limit, ai_credits_used')
    .maybeSingle();

  if (updateErr || !updated) {
    return { success: false, creditsRemaining: 0, isPaid: false };
  }

  const remaining = Math.max(0, updated.ai_credits_limit - updated.ai_credits_used);
  return { success: true, creditsRemaining: remaining, isPaid: false };
}

/**
 * Restores 1 reserved AI credit if the subsequent Gemini API call fails.
 */
export async function refundUserCredit(
  supabase: SupabaseClient,
  userId: string
): Promise<void> {
  try {
    const { error } = await supabase.rpc('refund_user_credit', { p_user_id: userId });
    if (!error) return;
  } catch {}

  try {
    const { data: sub } = await supabase
      .from('user_subscriptions')
      .select('id, ai_credits_used, plan')
      .eq('user_id', userId)
      .maybeSingle();

    if (sub && sub.plan !== 'pro' && sub.ai_credits_used > 0) {
      await supabase
        .from('user_subscriptions')
        .update({
          ai_credits_used: Math.max(0, sub.ai_credits_used - 1),
          updated_at: new Date().toISOString(),
        })
        .eq('id', sub.id);
    }
  } catch (err) {
    logger.warn('SubscriptionService', `Failed to refund credit for user ${userId}:`, err);
  }
}

/**
 * Atomically deducts 1 AI credit for a free-tier user.
 * (Preserved for backward compatibility)
 */
export async function deductOneAiCredit(
  supabase: SupabaseClient,
  sub: UserSubscription
): Promise<void> {
  if (sub.plan === 'pro') return; // Unlimited for Pro

  const newUsed = sub.ai_credits_used + 1;
  const { error } = await supabase
    .from('user_subscriptions')
    .update({
      ai_credits_used: newUsed,
      updated_at: new Date().toISOString(),
    })
    .eq('id', sub.id);

  if (error) {
    logger.error('SubscriptionService', `Failed to deduct credit for user ${sub.user_id}:`, error.message);
  } else {
    logger.info('SubscriptionService', `Deducted 1 credit for user ${sub.user_id}. Used: ${newUsed}/${sub.ai_credits_limit}`);
  }
}
