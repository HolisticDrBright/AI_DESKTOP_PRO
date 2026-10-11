import type { MetadataRoute } from "next";

import { allFunnels } from "@/funnels";
import { funnelPageUrl, indexingAllowed } from "@/lib/publicSite";

/**
 * The sitemap lists published, indexable funnel pages, and only on the production origin. With
 * no public address configured, or on a staging or synthetic deployment, it is empty. The
 * consult page is never listed.
 */
export function funnelSitemap(env: Parameters<typeof indexingAllowed>[0] = process.env): MetadataRoute.Sitemap {
  if (!indexingAllowed(env)) return [];
  return allFunnels()
    .filter(funnel => funnel.status === "published" && funnel.indexable)
    .map(funnel => ({ url: funnelPageUrl(funnel.slug, env)!, changeFrequency: "monthly" as const }));
}

export default function sitemap(): MetadataRoute.Sitemap {
  return funnelSitemap();
}
