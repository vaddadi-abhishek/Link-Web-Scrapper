import { Request, Response } from 'express';
import axios from 'axios';

export const imageProxyController = async (req: Request, res: Response): Promise<void> => {
  const imageUrl = req.query.url as string;

  if (!imageUrl || typeof imageUrl !== 'string') {
    res.status(400).json({ error: "Missing 'url' query parameter" });
    return;
  }

  try {
    const proxyRes = await axios.get(imageUrl, {
      responseType: 'stream',
      headers: {
        'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      },
      maxRedirects: 5,
    });

    // Forward the content type (e.g., image/jpeg)
    const contentType = proxyRes.headers['content-type'];
    if (contentType) {
      res.setHeader('Content-Type', contentType as string);
    }
    
    // Pipe the image stream directly to the client
    proxyRes.data.pipe(res);
  } catch (error: any) {
    console.error('Image proxy error:', error.message);
    res.status(500).json({ error: 'Failed to proxy image' });
  }
};
