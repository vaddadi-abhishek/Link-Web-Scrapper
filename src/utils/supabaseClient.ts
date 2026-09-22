import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { logger } from './logger';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!supabaseUrl || !supabaseAnonKey) {
  logger.warn('Supabase', 'Missing SUPABASE_URL or SUPABASE_ANON_KEY in environment variables.');
}

if (!supabaseServiceRoleKey) {
  logger.warn(
    'Supabase',
    'SUPABASE_SERVICE_ROLE_KEY is not defined. Elevated cross-user cache lookups and administrative operations will be restricted by RLS.'
  );
}

/**
 * Administrative Supabase client instance (server-side only).
 * Uses SUPABASE_SERVICE_ROLE_KEY to perform privileged operations (e.g. cross-user cache lookups).
 * Falls back to ANON_KEY if service role key is not yet configured.
 */
export const supabaseAdmin: SupabaseClient = createClient(
  supabaseUrl,
  supabaseServiceRoleKey || supabaseAnonKey,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);

/**
 * Returns an authenticated Supabase client strictly scoped to the caller's JWT token.
 * CRITICAL SECURITY GUARANTEE:
 * Uses SUPABASE_ANON_KEY (never the service role key). This ensures that PostgREST operates
 * strictly with role = 'authenticated' and PostgreSQL Row-Level Security (RLS) policies
 * (e.g., auth.uid() = user_id) cannot be bypassed.
 */
export function getAuthenticatedSupabaseClient(token: string): SupabaseClient {
  return createClient(supabaseUrl, supabaseAnonKey, {
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
