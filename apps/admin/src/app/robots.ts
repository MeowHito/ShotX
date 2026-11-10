import type { MetadataRoute } from 'next';

/** The admin app is private: disallow every crawler everywhere. */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: '*', disallow: '/' } };
}
