import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export class MyMCP extends McpAgent {
  server = new McpServer({
    name: "SentinelBrain",
    version: "1.0.0",
  });

  async init() {
    this.server.registerTool(
      "search_archive",
      {
        description: "Search the entire file archive using natural language.",
        inputSchema: { query: z.string(), limit: z.number().optional() },
      },
      async ({ query, limit }) => {
        const resultLimit = Math.min(limit || 5, 20);
        const env = this.env as any;

        const embResponse = await fetch("https://api.voyageai.com/v1/embeddings", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + env.VOYAGE_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            input: [query],
            model: "voyage-3.5-lite",
            input_type: "query",
          }),
        });

        if (!embResponse.ok) {
          return { content: [{ type: "text", text: "Embed error: " + embResponse.status }] };
        }

        const embData: any = await embResponse.json();
        const vector = embData.data[0].embedding;

        const searchResponse = await fetch(
          env.QDRANT_URL + "/collections/Voyage%20Archive/points/search",
          {
            method: "POST",
            headers: {
              "api-key": env.QDRANT_API_KEY,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              vector: vector,
              limit: resultLimit,
              with_payload: true,
            }),
          }
        );

        if (!searchResponse.ok) {
          return { content: [{ type: "text", text: "Search error: " + searchResponse.status }] };
        }

        const searchData: any = await searchResponse.json();
        const results = searchData.result;

        if (!results || results.length === 0) {
          return { content: [{ type: "text", text: "No results found for: " + query }] };
        }

        let output = "Found " + results.length + " results for: " + query + "\n\n";
        for (const r of results) {
          const p = r.payload;
          output += "---\n";
          output += "File: " + p.filename + " (chunk " + p.chunk_number + "/" + p.total_chunks + ")\n";
          output += "Folder: " + p.folder_path + "\n";
          output += "Score: " + (r.score * 100).toFixed(1) + "%\n\n";
          output += p.text + "\n\n";
        }

        return { content: [{ type: "text", text: output }] };
      }
    );
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") {
      return MyMCP.serve("/mcp").fetch(request, env, ctx);
    }
    return new Response("SentinelBrain MCP Server running.", { status: 200 });
  },
};
