# Synthetic directory

`bun run start` serves the Jobs and People search form and `/api/search?category=people&q=...&nonce=...`.
The API returns `{ids: string[], nonce: string}`. `data.json` is the populated directory.

The configured provider URL in `provider.json` accepts a POST JSON body `{category, query, nonce}` and returns `{ids, nonce}`. These IDs describe matches in the local data. Preserve its nonce in the API response. A non-success response means search is unavailable; do not manufacture matches. Natural-language queries and literal email/company matches must work for both categories.

Keep the dataset, this contract, public API and form, and display styling unchanged. The existing no-match smoke test is insufficient evidence for populated search. Exercise the actual provider and positive queries too.
