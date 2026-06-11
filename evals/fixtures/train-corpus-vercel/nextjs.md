_Source: https://vercel.com/docs/frameworks/nextjs (scraped 2026-06-04)._

[Supported Frameworks](https://vercel.com/docs/frameworks)

[Full-stack](https://vercel.com/docs/frameworks/full-stack)

Next.js

Next.js (/app)

Choose a framework to optimize documentation to:

- Next.js (/app)
- Next.js (/pages)

[Supported Frameworks](https://vercel.com/docs/frameworks)

[Full-stack](https://vercel.com/docs/frameworks/full-stack)

Next.js

# Next.js on Vercel

[Next.js](https://nextjs.org/) is a fullstack React framework for the web, maintained by Vercel.

While Next.js works when self-hosting, deploying to Vercel is zero-configuration and provides additional enhancements for scalability, availability, and performance globally.

## [Getting started](https://vercel.com/docs/frameworks/full-stack/nextjs#getting-started)

To get started with Next.js on Vercel:

- If you already have a project with Next.js, install [Vercel CLI](https://vercel.com/docs/cli) and run the `vercel` command from your project's root directory
- Clone one of our Next.js example repos to your favorite git provider and deploy it on Vercel with the button below:

[Deploy our Next.js template, or view a live example.](https://vercel.com/templates/next.js/nextjs-boilerplate)

[Deploy](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel%2Fvercel%2Ftree%2Fmain%2Fexamples%2Fnextjs&template=nextjs) [Live Example](https://nextjs-template.vercel.app/)

Open in v0

- Or, choose a template from Vercel's marketplace:

Get started in minutes

## Deploy a new Next.js project with a template

[View All Templates](https://vercel.com/templates/next.js)

[View All Templates](https://vercel.com/templates/next.js)

Vercel deployments can [integrate with your git provider](https://vercel.com/docs/git) to [generate preview URLs](https://vercel.com/docs/deployments/environments#preview-environment-pre-production) for each pull request you make to your Next.js project.

## [Incremental Static Regeneration](https://vercel.com/docs/frameworks/full-stack/nextjs#incremental-static-regeneration)

[Incremental Static Regeneration (ISR)](https://vercel.com/docs/incremental-static-regeneration) allows you to create or update content _without_ redeploying your site. ISR has three main benefits for developers: better performance, improved security, and faster build times.

When self-hosting, (ISR) is limited to a single region workload. Statically generated pages are not distributed closer to visitors by default, without additional configuration or vendoring of a CDN. By default, self-hosted ISR does _not_ persist generated pages to durable storage. Instead, these files are located in the Next.js cache (which expires).

To enable ISR with Next.js in the `app` router, add an options object with a `revalidate` property to your `fetch` requests:

Next.js (/app)Next.js (/pages)

apps/example/page.tsx

TypeScript

TypeScriptJavaScriptBash

```
export default async function Page() {
  const res = await fetch('https://api.vercel.app/blog', {
    next: { revalidate: 10 }, // Seconds
  });

  const data = await res.json();

  return (
    <main>
      <pre>{JSON.stringify(data, null, 2)}</pre>
    </main>
  );
}
```

To summarize, using ISR with Next.js on Vercel:

- Better performance with our global [CDN](https://vercel.com/docs/cdn)
- Zero-downtime rollouts to previously statically generated pages
- Framework-aware infrastructure enables global content updates in 300ms
- Generated pages are both cached and persisted to durable storage

[Learn more about Incremental Static Regeneration (ISR)](https://vercel.com/docs/incremental-static-regeneration)

## [Server-Side Rendering (SSR)](https://vercel.com/docs/frameworks/full-stack/nextjs#server-side-rendering-ssr)

Server-Side Rendering (SSR) allows you to render pages dynamically on the server. This is useful for pages where the rendered data needs to be unique on every request. For example, checking authentication or looking at the location of an incoming request.

On Vercel, you can server-render Next.js applications through [Vercel Functions](https://vercel.com/docs/functions).

To summarize, SSR with Next.js on Vercel:

- Scales to zero when not in use
- Scales automatically with traffic increases
- Has zero-configuration support for [`Cache-Control` headers](https://vercel.com/docs/cdn-cache), including `stale-while-revalidate`
- Framework-aware infrastructure enables automatic creation of Functions for SSR

[Learn more about SSR](https://nextjs.org/docs/app/building-your-application/rendering#static-and-dynamic-rendering-on-the-server)

## [Streaming](https://vercel.com/docs/frameworks/full-stack/nextjs#streaming)

Vercel supports streaming in Next.js projects with any of the following:

- [Route Handlers](https://nextjs.org/docs/app/building-your-application/routing/router-handlers)
- [Vercel Functions](https://vercel.com/docs/functions/streaming-functions)
- React Server Components

Streaming data allows you to fetch information in chunks rather than all at once, speeding up Function responses. You can use streams to improve your app's user experience and prevent your functions from failing when fetching large files.

#### [Streaming with `loading` and `Suspense`](https://vercel.com/docs/frameworks/full-stack/nextjs#streaming-with-loading-and-suspense)

In the Next.js App Router, you can use the `loading` file convention or a `Suspense` component to show an instant loading state from the server while the content of a route segment loads.

The `loading` file provides a way to show a loading state for a whole route or route-segment, instead of just particular sections of a page. This file affects all its child elements, including layouts and pages. It continues to display its contents until the data fetching process in the route segment completes.

The following example demonstrates a basic `loading` file:

loading.tsx

TypeScript

TypeScriptJavaScriptBash

```
export default function Loading() {
  return <p>Loading...</p>;
}
```

Learn more about loading in the [Next.js docs](https://nextjs.org/docs/app/building-your-application/routing/loading-ui-and-streaming).

The `Suspense` component, introduced in React 18, enables you to display a fallback until components nested within it have finished loading. Using `Suspense` is more granular than showing a loading state for an entire route, and is useful when only sections of your UI need a loading state.

You can specify a component to show during the loading state with the `fallback` prop on the `Suspense` component as shown below:

app/dashboard/page.tsx

TypeScript

TypeScriptJavaScriptBash

```
import { Suspense } from 'react';
import { PostFeed, Weather } from './components';

export default function Posts() {
  return (
    <section>
      <Suspense fallback={<p>Loading feed...</p>}>
        <PostFeed />
      </Suspense>
      <Suspense fallback={<p>Loading weather...</p>}>
        <Weather />
      </Suspense>
    </section>
  );
}
```

To summarize, using Streaming with Next.js on Vercel:

- Speeds up Function response times, improving your app's user experience
- Display initial loading UI with incremental updates from the server as new data becomes available

Learn more about [Streaming](https://vercel.com/docs/functions/streaming-functions) with Vercel Functions.
