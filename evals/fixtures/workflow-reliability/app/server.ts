import { search } from "./search.js";
import { heading } from "./display.js";

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/search") {
      const category = url.searchParams.get("category");
      if (category !== "people" && category !== "jobs")
        return Response.json({ error: "Invalid category" }, { status: 400 });
      try {
        return Response.json(
          await search(
            category,
            url.searchParams.get("q") ?? "",
            url.searchParams.get("nonce") ?? "",
          ),
        );
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 503 });
      }
    }
    return new Response(
      `<!doctype html><title>Directory</title><h1>${heading}</h1><form><select name="category" aria-label="Category"><option value="people">People</option><option value="jobs">Jobs</option></select><input name="q" aria-label="Search"><button>Search</button></form><pre id="results"></pre><script>document.querySelector('form').onsubmit=async event=>{event.preventDefault();const query=new URLSearchParams(new FormData(event.target));query.set('nonce',crypto.randomUUID());const response=await fetch('/api/search?'+query);document.querySelector('#results').textContent=JSON.stringify(await response.json());};</script>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});
console.log(`Directory listening on ${server.url}`);
