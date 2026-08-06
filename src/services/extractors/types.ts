export interface ExtractionResult {
  title: string | null;
  description: string | null;
  snapshot: string | null;
  logo: string | null;
  ogSiteName: string | null;
}

export interface PlatformExtractor {
  extract(url: string): Promise<ExtractionResult>;
}
