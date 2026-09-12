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
 * Atomically deducts 1 AI credit for a free-tier user.
 * Must ONLY be called AFTER Gemini has returned a successful response.
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
