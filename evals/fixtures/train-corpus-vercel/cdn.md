_Source: https://vercel.com/docs/edge-network/overview (scraped 2026-06-04)._

Overview

Overview

# Vercel CDN overview

Vercel's CDN is a globally distributed network that caches content near your visitors, routes requests, and runs compute close to your data. Every deployment includes it automatically.

Unlike traditional CDNs that only cache static assets, Vercel's CDN is framework-aware. It reads your routing, caching, and rendering configuration at build time, with the following benefits:

- Git-driven and previewable: Every CDN change is scoped to a branch and deployed to a unique [preview URL](https://vercel.com/docs/deployments/preview-deployments), so you can test routing, caching, and security rules before they reach production.
- Global network: [126+ PoPs across 51 countries and 20+ Vercel regions](https://vercel.com/docs/regions), with built-in request acceleration and high-availability architecture.
- Framework-aware, zero config: CDN configuration and [caching policies](https://vercel.com/docs/caching) are an output of the build and deployment process if you are using a supported framework, eliminating the need to define manual cache-control headers.
- Standard CDN directives: When needed, you can override [routing and caching rules](https://vercel.com/docs/routing). You can also proxy and cache responses from external backends with [external rewrites](https://vercel.com/docs/routing/rewrites#external-rewrites), and [invalidate content by tag](https://vercel.com/docs/caching/cdn-cache/purge) across all frameworks and backends.
- Default protections: Unmetered, always-on [DDoS mitigation and network-level security](https://vercel.com/docs/vercel-firewall) on every deployment at no extra cost.

## [What you can build](https://vercel.com/docs/cdn#what-you-can-build)

You can use Vercel's CDN across a range of architectures:

- Static sites and marketing pages: Pre-render pages at build time and serve them from the CDN without invoking your origin.
- E-commerce storefronts: Cache product catalogs with [ISR](https://vercel.com/docs/incremental-static-regeneration) and revalidate in the background when inventory or pricing changes.
- Content-driven platforms: Let editors publish CMS changes that propagate globally within seconds, without a redeployment.
- SaaS dashboards: Serve authenticated pages with [Vercel Functions](https://vercel.com/docs/functions) while the CDN caches shared assets and API responses.
- AI-powered applications: Stream responses from AI models through [streaming functions](https://vercel.com/docs/functions/streaming-functions) and cache deterministic results with [runtime cache](https://vercel.com/docs/caching/runtime-cache).
- Multi-region APIs: Set [Cache-Control headers](https://vercel.com/docs/caching/cache-control-headers) for per-region caching and use [rewrites](https://vercel.com/docs/routing/rewrites) to proxy requests to external backends.
- Hybrid architectures: Mix static, ISR, and dynamic routes in the same project. The CDN applies the right strategy per route from your framework configuration.

### [Get started with templates](https://vercel.com/docs/cdn#get-started-with-templates)

Deploy a CDN-ready template to see routing, caching, and revalidation in action:

[\\
\\
On-Demand ISR\\
\\
Instantly update content without redeploying.](https://vercel.com/templates/next.js/on-demand-incremental-static-regeneration)

Open in v0

[\\
\\
Bulk Redirects via a CMS\\
\\
Learn how to create redirects via Contentful, synced at build time to Vercel’s CDN using vercel.ts](https://vercel.com/templates/next.js/bulk-redirects-via-a-cms)

Open in v0

[\\
\\
Proxy requests to external origins\\
\\
Rewrite API traffic to an external backend using vercel.ts.](https://vercel.com/templates/next.js/proxy-requests-to-external-origins)

Open in v0

[View all CDN templates](https://vercel.com/templates/cdn)

## [How Vercel CDN works](https://vercel.com/docs/cdn#how-vercel-cdn-works)

Every request flows through the CDN's routing, caching, and compute layers before reaching your application code. Each layer can resolve the request or pass it to the next.

- [How a request flows through the CDN](https://vercel.com/docs/how-vercel-cdn-works)
- [Compression](https://vercel.com/docs/how-vercel-cdn-works/compression)

### [Global network and regions](https://vercel.com/docs/cdn#global-network-and-regions)

Vercel operates 126 Points of Presence (PoPs) across 51 countries. Behind them, compute-capable regions run your code close to your data. Traffic flows between PoPs and regions over a private, low-latency network.

- [Region list and infrastructure details](https://vercel.com/docs/regions)

## [Routing](https://vercel.com/docs/cdn#routing)

The CDN evaluates routing rules before checking any cache. Redirects return a new URL to the client. Rewrites map a public URL to a different backend path. Header rules modify request and response metadata.

- [Redirects](https://vercel.com/docs/routing/redirects)
- [Rewrites](https://vercel.com/docs/routing/rewrites)
- [Reverse proxy with external rewrites](https://vercel.com/docs/routing/rewrites#external-rewrites)

## [Security](https://vercel.com/docs/cdn#security)

The CDN enforces security before requests reach your application. Every deployment uses HTTPS with automatically provisioned SSL certificates and TLS 1.2/1.3 support. A platform-wide firewall with DDoS mitigation inspects every request at the CDN level. You can also configure a Web Application Firewall (WAF) with custom rules at the project level.

- [CDN security overview](https://vercel.com/docs/cdn-security)
- [Encryption & TLS](https://vercel.com/docs/cdn-security/encryption)
- [Security headers](https://vercel.com/docs/cdn-security/security-headers)
- [Vercel WAF](https://vercel.com/docs/vercel-firewall/vercel-waf)

## [Caching](https://vercel.com/docs/cdn#caching)

Vercel maintains multiple caching tiers to reduce how often your functions run.

### [Incremental Static Regeneration](https://vercel.com/docs/cdn#incremental-static-regeneration)

Incremental Static Regeneration (ISR) serves cached pages to visitors while regenerating content in the background. When the cache expires, Vercel re-renders the page and updates all regions so visitors always get a fast response. Vercel manages caching, request collapsing, and purging automatically when you use ISR with Next.js, SvelteKit, Nuxt, or Astro.

- [How ISR works](https://vercel.com/docs/incremental-static-regeneration)
- [Getting started with ISR](https://vercel.com/docs/incremental-static-regeneration/quickstart)
- [ISR usage and pricing](https://vercel.com/docs/incremental-static-regeneration/limits-and-pricing)
- [Request collapsing](https://vercel.com/docs/incremental-static-regeneration/request-collapsing)

### [CDN cache and runtime cache](https://vercel.com/docs/cdn#cdn-cache-and-runtime-cache)

The CDN cache stores responses across Vercel regions, closest to your visitors. The runtime cache stores fetch results, database queries, and computed values inside your functions.

- [CDN cache](https://vercel.com/docs/caching/cdn-cache)
- [Cache-Control headers](https://vercel.com/docs/caching/cache-control-headers)
- [Runtime cache](https://vercel.com/docs/caching/runtime-cache)

## [System headers](https://vercel.com/docs/cdn#system-headers)

Every deployment includes system-level headers on requests and responses. You can use these headers to inspect routing decisions, caching status, and request identity for debugging and observability.

- [Response headers](https://vercel.com/docs/headers/response-headers)
- [Request headers](https://vercel.com/docs/headers/request-headers)

## [Image optimization](https://vercel.com/docs/cdn#image-optimization)

You can resize, crop, and convert images to modern formats like WebP and AVIF. Vercel transforms and caches the results on the CDN, so you don't need a separate image pipeline.
