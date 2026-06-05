_Source: https://htmx.org/ (scraped 2026-06-04)._

</\> htmx*high power tools for HTML*

[](https://swag.htmx.org/products/shut-up-warren-tee)

[](https://swag.htmx.org/products/htmx-katakana-shirt)

**NEWS:** htmx v4 is under active development and is now in beta, with a target release date of Summer '26! More details
at [https://four.htmx.org](https://four.htmx.org/)

## introduction

htmx gives you access to [AJAX](https://htmx.org/docs/#ajax), [CSS Transitions](https://htmx.org/docs/#css_transitions), [WebSockets](https://htmx.org/docs/#websockets-and-sse) and [Server Sent Events](https://htmx.org/docs/#websockets-and-sse)
directly in HTML, using [attributes](https://htmx.org/reference/#attributes), so you can build
[modern user interfaces](https://htmx.org/examples/) with the [simplicity](https://en.wikipedia.org/wiki/HATEOAS) and
[power](https://www.ics.uci.edu/~fielding/pubs/dissertation/rest_arch_style.htm) of hypertext

htmx is small ( [~16k min.gz’d](https://cdn.jsdelivr.net/npm/htmx.org/dist/)),
[dependency-free](https://github.com/bigskysoftware/htmx/blob/master/package.json),
[extendable](https://htmx.org/extensions) & has **reduced** code base sizes by [67% when compared with react](https://htmx.org/essays/a-real-world-react-to-htmx-port/)

## motivation

- Why should only [`<a>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/a) & [`<form>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/form) be able to make HTTP requests?
- Why should only [`click`](https://developer.mozilla.org/en-US/docs/Web/API/Element/click_event) & [`submit`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLFormElement/submit_event) events trigger them?
- Why should only [`GET`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Methods/GET) & [`POST`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Methods/POST) methods be [available](https://developer.mozilla.org/en-US/docs/Web/HTTP/Methods)?
- Why should you only be able to replace the **entire** screen?

By removing these constraints, htmx completes HTML as a [hypertext](https://en.wikipedia.org/wiki/Hypertext)

## quick start

```html
<script
  src="https://cdn.jsdelivr.net/npm/htmx.org@2.0.10/dist/htmx.min.js"
  integrity="sha384-H5SrcfygHmAuTDZphMHqBJLc3FhssKjG7w/CeCpFReSfwBWDTKpkzPP8c+cLsK+V"
  crossorigin="anonymous"
></script>
<!-- have a button POST a click via AJAX -->
<button hx-post="/clicked" hx-swap="outerHTML">Click Me</button>
```

The [`hx-post`](https://htmx.org/attributes/hx-post/) and [`hx-swap`](https://htmx.org/attributes/hx-swap/) attributes on
this button tell htmx:

> “When a user clicks on this button, issue an AJAX request to /clicked, and replace the entire button with the HTML response”

htmx is the successor to [intercooler.js](http://intercoolerjs.org/)

Read the [docs introduction](https://htmx.org/docs/#introduction) for a more in-depth… introduction.

Note that htmx 2.x has dropped IE support. If you require IE support you can use the [1.x](https://v1.htmx.org/)
code-line, which will be supported in perpetuity.

## book

We are happy to announce the release of [Hypermedia Systems](https://hypermedia.systems/), a book on how to build
[Hypermedia-Driven Applications](https://htmx.org/essays/hypermedia-driven-applications/) using htmx & more:

[](https://www.amazon.com/dp/B0C9S88QV6/ref=sr_1_1?crid=1P0I3GXQK32TN)

## sponsors [Sponsor](https://github.com/sponsors/bigskysoftware?o=esb)

htmx development can be supported via [GitHub Sponsors](https://github.com/sponsors/bigskysoftware?o=esb)

Thank you to all our generous [supporters](https://github.com/sponsors/bigskysoftware?o=esb), including:

# Platinum Sponsor

[](https://www.commspace.co.za/)

## [Silver Sponsors](https://htmx.org/#silver-sponsors)

[](https://www.jetbrains.com/)

[](https://github.blog/2023-04-12-github-accelerator-our-first-cohort-and-whats-next)

[](https://craftcms.com/)

[](https://buttercms.com/?utm_campaign=sponsorship&utm_medium=banner&utm_source=htmxhome)

[](https://black.host/)

[](https://www.v7n.com/)

[](https://tacohiro.systems/)

[](https://dasfilter.shop/pages/affiliates)

[](https://www.pullapprove.com/?utm_campaign=sponsorship&utm_medium=banner&utm_source=htmx)

[](https://uibakery.io/)

[](https://tracebit.com/?utm_source=htmx)

[](https://rxdb.info/?utm_source=sponsor&utm_medium=githubsponsor&utm_campaign=githubsponsor-htmx)

[](https://www.ohne-makler.net/)

[](https://cased.com///)

[](https://www.llc.org/)

[](https://www.vpsserver.com/)

[](https://www.a-blogcms.jp/)

[](https://broadbandmap.com/)

[](https://www.follower24.de/)

[](https://www.exchangerate-api.com/)

[](https://instant-famous.com/)

[](https://hellostake.com/au/referral-code)

ʕ •ᴥ•ʔ made in montana
