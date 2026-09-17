-- ============================================================================
-- MIGRATION: ADD ARTICLES TABLE & READER MODE SUPPORT
-- ============================================================================

-- 1. Add reader metadata column to bookmarks table
ALTER TABLE public.bookmarks 
ADD COLUMN IF NOT EXISTS is_article BOOLEAN DEFAULT false;

-- If reading_time_minutes was previously added to bookmarks, drop it
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'bookmarks' 
          AND column_name = 'reading_time_minutes'
    ) THEN
        ALTER TABLE public.bookmarks DROP COLUMN reading_time_minutes;
    END IF;
END $$;

-- 2. Create articles table for full reader content (1-to-1 extension with bookmarks)
CREATE TABLE IF NOT EXISTS public.articles (
    bookmark_id UUID PRIMARY KEY REFERENCES public.bookmarks(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    content_html TEXT NOT NULL,
    word_count INTEGER DEFAULT 0,
    reading_time_minutes INTEGER DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Ensure reading_time_minutes exists on articles if table was already created
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'articles' 
          AND column_name = 'reading_time_minutes'
    ) THEN
        ALTER TABLE public.articles ADD COLUMN reading_time_minutes INTEGER DEFAULT 1;
    END IF;
END $$;

-- 3. Row Level Security (RLS) & Policies
ALTER TABLE public.articles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own articles" ON public.articles;
CREATE POLICY "Users can manage own articles"
    ON public.articles
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- 4. Indexes for fast user queries
CREATE INDEX IF NOT EXISTS idx_articles_user_id ON public.articles(user_id);
