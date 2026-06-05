_Source: https://htmx.org/reference/ (scraped 2026-06-04)._

# Reference

## [Contents](https://htmx.org/reference/#contents)

- [htmx Core Attributes](https://htmx.org/reference/#attributes)
- [htmx Additional Attributes](https://htmx.org/reference/#attributes-additional)
- [htmx CSS Classes](https://htmx.org/reference/#classes)
- [htmx Request Headers](https://htmx.org/reference/#request_headers)
- [htmx Response Headers](https://htmx.org/reference/#response_headers)
- [htmx Events](https://htmx.org/reference/#events)
- [htmx Extensions](https://htmx.org/extensions)
- [JavaScript API](https://htmx.org/reference/#api)
- [Configuration Options](https://htmx.org/reference/#config)

## [Core Attribute Reference](https://htmx.org/reference/#attributes)

The most common attributes when using htmx.

| Attribute                                                     | Description                                                                              |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [`hx-get`](https://htmx.org/attributes/hx-get/)               | issues a `GET` to the specified URL                                                      |
| [`hx-post`](https://htmx.org/attributes/hx-post/)             | issues a `POST` to the specified URL                                                     |
| [`hx-on*`](https://htmx.org/attributes/hx-on/)                | handle events with inline scripts on elements                                            |
| [`hx-push-url`](https://htmx.org/attributes/hx-push-url/)     | push a URL into the browser location bar to create history                               |
| [`hx-select`](https://htmx.org/attributes/hx-select/)         | select content to swap in from a response                                                |
| [`hx-select-oob`](https://htmx.org/attributes/hx-select-oob/) | select content to swap in from a response, somewhere other than the target (out of band) |
| [`hx-swap`](https://htmx.org/attributes/hx-swap/)             | controls how content will swap in (`outerHTML`, `beforeend`, `afterend`, …)              |
| [`hx-swap-oob`](https://htmx.org/attributes/hx-swap-oob/)     | mark element to swap in from a response (out of band)                                    |
| [`hx-target`](https://htmx.org/attributes/hx-target/)         | specifies the target element to be swapped                                               |
| [`hx-trigger`](https://htmx.org/attributes/hx-trigger/)       | specifies the event that triggers the request                                            |
| [`hx-vals`](https://htmx.org/attributes/hx-vals/)             | add values to submit with the request (JSON format)                                      |

## [Additional Attribute Reference](https://htmx.org/reference/#attributes-additional)

All other attributes available in htmx.

| Attribute                                                         | Description                                                                                                                                     |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [`hx-boost`](https://htmx.org/attributes/hx-boost/)               | add [progressive enhancement](https://en.wikipedia.org/wiki/Progressive_enhancement) for links and forms                                        |
| [`hx-confirm`](https://htmx.org/attributes/hx-confirm/)           | shows a `confirm()` dialog before issuing a request                                                                                             |
| [`hx-delete`](https://htmx.org/attributes/hx-delete/)             | issues a `DELETE` to the specified URL                                                                                                          |
| [`hx-disable`](https://htmx.org/attributes/hx-disable/)           | disables htmx processing for the given node and any children nodes                                                                              |
| [`hx-disabled-elt`](https://htmx.org/attributes/hx-disabled-elt/) | adds the `disabled` attribute to the specified elements while a request is in flight                                                            |
| [`hx-disinherit`](https://htmx.org/attributes/hx-disinherit/)     | control and disable automatic attribute inheritance for child nodes                                                                             |
| [`hx-encoding`](https://htmx.org/attributes/hx-encoding/)         | changes the request encoding type                                                                                                               |
| [`hx-ext`](https://htmx.org/attributes/hx-ext/)                   | extensions to use for this element                                                                                                              |
| [`hx-headers`](https://htmx.org/attributes/hx-headers/)           | adds to the headers that will be submitted with the request                                                                                     |
| [`hx-history`](https://htmx.org/attributes/hx-history/)           | prevent sensitive data being saved to the history cache                                                                                         |
| [`hx-history-elt`](https://htmx.org/attributes/hx-history-elt/)   | the element to snapshot and restore during history navigation                                                                                   |
| [`hx-include`](https://htmx.org/attributes/hx-include/)           | include additional data in requests                                                                                                             |
| [`hx-indicator`](https://htmx.org/attributes/hx-indicator/)       | the element to put the `htmx-request` class on during the request                                                                               |
| [`hx-inherit`](https://htmx.org/attributes/hx-inherit/)           | control and enable automatic attribute inheritance for child nodes if it has been disabled by default                                           |
| [`hx-params`](https://htmx.org/attributes/hx-params/)             | filters the parameters that will be submitted with a request                                                                                    |
| [`hx-patch`](https://htmx.org/attributes/hx-patch/)               | issues a `PATCH` to the specified URL                                                                                                           |
| [`hx-preserve`](https://htmx.org/attributes/hx-preserve/)         | specifies elements to keep unchanged between requests                                                                                           |
| [`hx-prompt`](https://htmx.org/attributes/hx-prompt/)             | shows a `prompt()` before submitting a request                                                                                                  |
| [`hx-put`](https://htmx.org/attributes/hx-put/)                   | issues a `PUT` to the specified URL                                                                                                             |
| [`hx-replace-url`](https://htmx.org/attributes/hx-replace-url/)   | replace the URL in the browser location bar                                                                                                     |
| [`hx-request`](https://htmx.org/attributes/hx-request/)           | configures various aspects of the request                                                                                                       |
| [`hx-sync`](https://htmx.org/attributes/hx-sync/)                 | control how requests made by different elements are synchronized                                                                                |
| [`hx-validate`](https://htmx.org/attributes/hx-validate/)         | force elements to validate themselves before a request                                                                                          |
| [`hx-vars`](https://htmx.org/attributes/hx-vars/)                 | adds values dynamically to the parameters to submit with the request (deprecated, please use [`hx-vals`](https://htmx.org/attributes/hx-vals/)) |

## [CSS Class Reference](https://htmx.org/reference/#classes)

| Class            | Description                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `htmx-added`     | Applied to a new piece of content before it is swapped, removed after it is settled.                                                                                |
| `htmx-indicator` | A dynamically generated class that will toggle visible (opacity:1) when a `htmx-request` class is present                                                           |
| `htmx-request`   | Applied to either the element or the element specified with [`hx-indicator`](https://htmx.org/attributes/hx-indicator/) while a request is ongoing                  |
| `htmx-settling`  | Applied to a target after content is swapped, removed after it is settled. The duration can be modified via [`hx-swap`](https://htmx.org/attributes/hx-swap/).      |
| `htmx-swapping`  | Applied to a target before any content is swapped, removed after it is swapped. The duration can be modified via [`hx-swap`](https://htmx.org/attributes/hx-swap/). |

## [HTTP Header Reference](https://htmx.org/reference/#headers)

### [Request Headers Reference](https://htmx.org/reference/#request_headers)

| Header                       | Description                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `HX-Boosted`                 | indicates that the request is via an element using [hx-boost](https://htmx.org/attributes/hx-boost/) |
| `HX-Current-URL`             | the current URL of the browser                                                                       |
| `HX-History-Restore-Request` | “true” if the request is for history restoration after a miss in the local history cache             |
| `HX-Prompt`                  | the user response to an [hx-prompt](https://htmx.org/attributes/hx-prompt/)                          |
| `HX-Request`                 | always “true”                                                                                        |
| `HX-Target`                  | the `id` of the target element if it exists                                                          |
| `HX-Trigger-Name`            | the `name` of the triggered element if it exists                                                     |
| `HX-Trigger`                 | the `id` of the triggered element if it exists                                                       |

### [Response Headers Reference](https://htmx.org/reference/#response_headers)

| Header                                                            | Description                                                                                                                                                                                         |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`HX-Location`](https://htmx.org/headers/hx-location/)            | allows you to do a client-side redirect that does not do a full page reload                                                                                                                         |
| [`HX-Push-Url`](https://htmx.org/headers/hx-push-url/)            | pushes a new url into the history stack                                                                                                                                                             |
| [`HX-Redirect`](https://htmx.org/headers/hx-redirect/)            | can be used to do a client-side redirect to a new location                                                                                                                                          |
| `HX-Refresh`                                                      | if set to “true” the client-side will do a full refresh of the page                                                                                                                                 |
| [`HX-Replace-Url`](https://htmx.org/headers/hx-replace-url/)      | replaces the current URL in the location bar                                                                                                                                                        |
| `HX-Reswap`                                                       | allows you to specify how the response will be swapped. See [hx-swap](https://htmx.org/attributes/hx-swap/) for possible values                                                                     |
| `HX-Retarget`                                                     | a CSS selector that updates the target of the content update to a different element on the page                                                                                                     |
| `HX-Reselect`                                                     | a CSS selector that allows you to choose which part of the response is used to be swapped in. Overrides an existing [`hx-select`](https://htmx.org/attributes/hx-select/) on the triggering element |
| [`HX-Trigger`](https://htmx.org/headers/hx-trigger/)              | allows you to trigger client-side events                                                                                                                                                            |
| [`HX-Trigger-After-Settle`](https://htmx.org/headers/hx-trigger/) | allows you to trigger client-side events after the settle step                                                                                                                                      |
| [`HX-Trigger-After-Swap`](https://htmx.org/headers/hx-trigger/)   | allows you to trigger client-side events after the swap step                                                                                                                                        |

## [Event Reference](https://htmx.org/reference/#events)

| Event                                                                             | Description                                                                                                                       |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| [`htmx:abort`](https://htmx.org/events/#htmx:abort)                               | send this event to an element to abort a request                                                                                  |
| [`htmx:afterOnLoad`](https://htmx.org/events/#htmx:afterOnLoad)                   | triggered after an AJAX request has completed processing a successful response                                                    |
| [`htmx:afterProcessNode`](https://htmx.org/events/#htmx:afterProcessNode)         | triggered after htmx has initialized a node                                                                                       |
| [`htmx:afterRequest`](https://htmx.org/events/#htmx:afterRequest)                 | triggered after an AJAX request has completed                                                                                     |
| [`htmx:afterSettle`](https://htmx.org/events/#htmx:afterSettle)                   | triggered after the DOM has settled                                                                                               |
| [`htmx:afterSwap`](https://htmx.org/events/#htmx:afterSwap)                       | triggered after new content has been swapped in                                                                                   |
| [`htmx:beforeCleanupElement`](https://htmx.org/events/#htmx:beforeCleanupElement) | triggered before htmx [disables](https://htmx.org/attributes/hx-disable/) an element or removes it from the DOM                   |
| [`htmx:beforeOnLoad`](https://htmx.org/events/#htmx:beforeOnLoad)                 | triggered before any response processing occurs                                                                                   |
| [`htmx:beforeProcessNode`](https://htmx.org/events/#htmx:beforeProcessNode)       | triggered before htmx initializes a node                                                                                          |
| [`htmx:beforeRequest`](https://htmx.org/events/#htmx:beforeRequest)               | triggered before an AJAX request is made                                                                                          |
| [`htmx:beforeSwap`](https://htmx.org/events/#htmx:beforeSwap)                     | triggered before a swap is done, allows you to configure the swap                                                                 |
| [`htmx:beforeSend`](https://htmx.org/events/#htmx:beforeSend)                     | triggered just before an ajax request is sent                                                                                     |
| [`htmx:beforeTransition`](https://htmx.org/events/#htmx:beforeTransition)         | triggered before the [View Transition](https://developer.mozilla.org/en-US/docs/Web/API/View_Transitions_API) wrapped swap occurs |
| [`htmx:configRequest`](https://htmx.org/events/#htmx:configRequest)               | triggered before the request, allows you to customize parameters, headers                                                         |
| [`htmx:confirm`](https://htmx.org/events/#htmx:confirm)                           | triggered after a trigger occurs on an element, allows you to cancel (or delay) issuing the AJAX request                          |
| [`htmx:historyCacheError`](https://htmx.org/events/#htmx:historyCacheError)       | triggered on an error during cache writing                                                                                        |
| [`htmx:historyCacheHit`](https://htmx.org/events/#htmx:historyCacheHit)           | triggered on a cache hit in the history subsystem                                                                                 |
