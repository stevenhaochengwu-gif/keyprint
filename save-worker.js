// Save Worker for your typing site.
// It keeps a copy of your progress in Workers KV, and only answers requests that carry
// your secret key. It also keeps the first copy of every day, so a mistake can be undone.
//
// Setup in the Cloudflare dashboard
// 1. Bind a Workers KV namespace to this Worker with the variable name DATA.
// 2. Add a secret named SAVE_KEY. Its value is the key you type into the typing site.

// The addresses your typing site runs on. Add any other address you use.
const SITES = ["https://type.stevenwu.org", "https://typing.stevenhaochengwu.workers.dev"];

const MAIN = "keyprint-state-v1";

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": SITES.includes(origin) ? origin : SITES[0],
      "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
    const reply = (body, status = 200) =>
      new Response(body, {
        status,
        headers: { ...cors, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (!env.DATA || !env.SAVE_KEY) return reply("Setup is not finished. Bind DATA and add the SAVE_KEY secret.", 500);
    if (request.headers.get("Authorization") !== `Bearer ${env.SAVE_KEY}`) return reply("Wrong key", 401);

    let name = "";
    try {
      name = decodeURIComponent(new URL(request.url).pathname.slice(1));
    } catch (err) {
      return reply("Bad name", 400);
    }

    // The list of daily copies, newest first.
    if (name === "backups" && request.method === "GET") {
      const days = [];
      let cursor;
      do {
        const page = await env.DATA.list({ prefix: "backup-", cursor });
        for (const key of page.keys) days.push(key.name.slice(7));
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      return reply(JSON.stringify(days.sort().reverse()));
    }

    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(name)) return reply("Bad name", 400);

    if (request.method === "GET") {
      const value = await env.DATA.get(name);
      return value === null ? reply("Not found", 404) : reply(value);
    }

    if (request.method === "PUT") {
      const body = await request.text();
      if (body.length > 20000000) return reply("Too large", 413);
      await env.DATA.put(name, body);
      if (name === MAIN) {
        // Keep the first copy of each day. Restoring one undoes anything done after it.
        const day = `backup-${new Date().toISOString().slice(0, 10)}`;
        if ((await env.DATA.get(day)) === null) await env.DATA.put(day, body);
      }
      return reply("Saved");
    }

    if (request.method === "DELETE") {
      if (name === MAIN || name.startsWith("backup-")) return reply("Not allowed", 403);
      await env.DATA.delete(name);
      return reply("Deleted");
    }

    return reply("Not allowed", 405);
  },
};
