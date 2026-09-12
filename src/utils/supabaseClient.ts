import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { logger } from './logger';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

if (!supabaseUrl || !supabaseKey) {
  logger.warn('Supabase', 'Missing SUPABASE_URL or SUPABASE_ANON_KEY in environment variables.');
}

/**
 * Default Supabase client instance (server-side).
 */
export const supabaseAdmin: SupabaseClient = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

/**
 * Returns an authenticated Supabase client scoped to the caller's JWT token.
 * This guarantees that Supabase Row-Level Security (RLS) policies (e.g. auth.uid() = user_id)
 * are strictly enforced by PostgreSQL.
 */
export function getAuthenticatedSupabaseClient(token: string): SupabaseClient {
  return createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });
}
