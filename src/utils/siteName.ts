/**
 * Universal Site Name Derivation Utility
 *
 * Priorities:
 * 1. Explicit og:site_name (if valid & clean)
 * 2. Contextual pattern matching based on domain & URL path
 * 3. Capitalization of the primary domain name
 */
export function deriveSiteName(urlStr: string, ogSiteName?: string | null): string {
  if (ogSiteName && ogSiteName.trim().length > 0) {
    return ogSiteName.trim();
  }

  try {
    const urlObj = new URL(urlStr);
    const host = urlObj.hostname.toLowerCase().replace(/^www\./, '');
    const pathname = urlObj.pathname.toLowerCase();

    // Known Platform Contextual Derivations
    if (host.includes('github.com')) {
      if (pathname.includes('/issues/')) return 'GitHub Issue';
      if (pathname.includes('/pull/')) return 'GitHub Pull Request';
      return 'GitHub';
    }

    if (host.includes('linkedin.com')) {
      if (pathname.includes('/jobs/')) return 'LinkedIn Job';
      if (pathname.includes('/in/')) return 'LinkedIn Profile';
      if (pathname.includes('/posts/') || pathname.includes('/feed/')) return 'LinkedIn Post';
      return 'LinkedIn';
    }

    if (host.includes('reddit.com')) {
      if (pathname.includes('/comments/')) return 'Reddit Post';
      if (pathname.startsWith('/r/')) return 'Reddit';
      return 'Reddit';
    }

    if (host.includes('x.com') || host.includes('twitter.com')) {
      if (pathname.includes('/status/')) return 'X Post';
      return 'X';
    }

    if (host.includes('youtube.com') || host.includes('youtu.be')) {
      if (pathname.includes('/watch') || host.includes('youtu.be')) return 'YouTube Video';
      return 'YouTube';
    }

    if (host === 'news.ycombinator.com') {
      return 'Hacker News';
    }

    if (host.includes('medium.com')) {
      return 'Medium';
    }

    if (host === 'dev.to') {
      return 'DEV Community';
    }

    if (host.includes('stackoverflow.com')) {
      if (pathname.includes('/questions/')) return 'Stack Overflow Question';
      return 'Stack Overflow';
    }

    // Default: Extract main domain part and capitalize
    // e.g. "sub.example.co.uk" -> "example" -> "Example"
    const parts = host.split('.');
    let mainDomain = parts[0];

    if (parts.length > 2 && ['co', 'com', 'org', 'net', 'gov', 'edu'].includes(parts[parts.length - 2])) {
      mainDomain = parts[parts.length - 3] || parts[0];
    } else if (parts.length >= 2) {
      mainDomain = parts[parts.length - 2];
    }

    return capitalizeFirstLetter(mainDomain);
  } catch (err) {
    return 'Unknown Site';
  }
}

function capitalizeFirstLetter(str: string): string {
  if (!str) return 'Unknown Site';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}
