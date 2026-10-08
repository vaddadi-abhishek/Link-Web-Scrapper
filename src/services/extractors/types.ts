export interface MediaItem {
  type: 'image' | 'video' | string;
  url: string;
}

export interface XCardData {
  author: {
    name: string;
    handle: string;
    avatar_url: string | null;
    verified: boolean;
  };
  metrics: {
    replies?: number;
    reposts?: number;
    likes?: number;
    views?: number;
    bookmarks?: number;
  } | null;
  media: MediaItem[] | null;
  posted_at: string;
  video_thumbnail?: string | null;
  type?: string | null;
  page_intent?: string | null;
  article_content?: string | null;
  word_count?: number | null;
  reading_time_minutes?: number | null;
  snapshot?: string | null;
}

export interface InstagramCardData {
  author: {
    username: string;
    name: string;
    avatar_url: string | null;
    verified: boolean;
  };
  metrics: {
    likes?: number;
    comments?: number;
    reposts?: number;
  } | null;
  media: MediaItem[];
  posted_at: string;
  video_thumbnail?: string | null;
  is_profile?: boolean;
}

export interface FacebookCardData {
  author: {
    name: string;
    avatar_url: string | null;
  };
  metrics: {
    likes?: number;
    comments?: number;
    shares?: number;
  } | null;
  media: MediaItem[];
  posted_at: string | null;
  video_thumbnail?: string | null;
}

export interface LinkedInCardData {
  author: {
    name: string;
    avatar_url: string | null;
  };
  metrics: {
    reactions?: number;
    comments?: number;
    reposts?: number;
  } | null;
  media: MediaItem[];
  posted_at: string | null;
  type?: string | null;
  page_intent?: string | null;
  article_content?: string | null;
  word_count?: number | null;
  reading_time_minutes?: number | null;
  video_thumbnail?: string | null;
  document?: {
    title?: string | null;
    page_count?: number | null;
    pdf_url?: string | null;
  } | null;
}

export interface RedditCardData {
  subreddit: {
    name: string;
    icon_url: string | null;
  };
  author: string;
  metrics: {
    upvotes?: number;
    comments?: number;
  } | null;
  posted_at: string | null;
  media: MediaItem[] | null;
  video_thumbnail?: string | null;
}

export interface YouTubeCardData {
  channel: {
    name: string;
    avatar_url: string | null;
  };
  metrics: {
    views?: number;
    likes?: number;
  } | null;
  video_id: string | null;
  posted_at: string | null;
  video_thumbnail?: string | null;
}

export interface PinterestCardData {
  author?: {
    name?: string;
    username?: string;
    avatar_url?: string | null;
  };
  metrics?: {
    saves?: number;
    comments?: number;
    repins?: number;
  } | null;
  media?: MediaItem[];
  posted_at?: string | null;
  video_thumbnail?: string | null;
}

export interface GlobalWebCardData {
  author: string | null;
  published_at: string | null;
  site_name: string | null;
  type: string | null;
  snapshot: string | null;
  page_intent?: string | null;
  article_content?: string | null;
  word_count?: number | null;
  reading_time_minutes?: number | null;
  metrics?: Record<string, unknown> | null;
}

/**
 * Normalizes metrics object: returns null if metrics is empty or contains no non-zero values.
 */
export function sanitizeMetrics<T extends Record<string, unknown>>(metrics: T | null | undefined): T | null {
  if (!metrics || typeof metrics !== 'object') return null;
  const entries = Object.entries(metrics).filter(([_, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return null;
  const hasMeaningfulValue = entries.some(([_, v]) => {
    if (typeof v === 'number') return v !== 0 && !isNaN(v);
    if (typeof v === 'string') return v.trim() !== '' && v !== '0';
    return Boolean(v);
  });
  if (!hasMeaningfulValue) return null;
  return Object.fromEntries(entries) as T;
}

export interface ArticleData {
  content_html: string;
  content_text: string;
  content_markdown?: string | null;
  byline?: string | null;
  excerpt?: string | null;
  word_count: number;
  reading_time_minutes: number;
}

export interface ExtractionResult<T = any> {
  title: string | null;
  description: string | null;
  logo: string | null;
  ogSiteName: string | null;
  type?: string | null;
  card_data: T;
  article?: ArticleData | null;
}

export interface PlatformExtractor<T = any> {
  platformKey: string;
  extract(url: string, html?: string): Promise<ExtractionResult<T>>;
}
