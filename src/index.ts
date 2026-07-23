import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

function createServer(env: any) {
  const server = new McpServer({
    name: "SentinelBrain",
    version: "1.0.0",
  });

  server.tool(
    "search_archive",
    "Search Candice's entire indexed archive using natural language and return relevant passages with filenames, folder paths, chunk positions, and relevance scores.",
    {
      query: z.string(),
      limit: z.number().int().min(1).max(20).optional(),
    },
    async ({ query, limit }) => {
      const resultLimit = limit ?? 5;

      const embeddingResponse = await fetch(
        "https://api.voyageai.com/v1/embeddings",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.VOYAGE_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            input: [query],
            model: "voyage-3.5-lite",
            input_type: "query",
          }),
        },
      );

      if (!embeddingResponse.ok) {
        const details = await embeddingResponse.text();
        return {
          content: [
            {
              type: "text" as const,
              text: `Voyage embedding request failed (${embeddingResponse.status}): ${details}`,
            },
          ],
          isError: true,
        };
      }

      const embeddingData: any = await embeddingResponse.json();
      const vector = embeddingData.data?.[0]?.embedding;

      if (!vector) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Voyage returned no query embedding.",
            },
          ],
          isError: true,
        };
      }

      const qdrantResponse = await fetch(
        `${env.QDRANT_URL}/collections/Voyage%20Archive/points/search`,
        {
          method: "POST",
          headers: {
            "api-key": env.QDRANT_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            vector,
            limit: resultLimit,
            with_payload: true,
            with_vector: false,
          }),
        },
      );

      if (!qdrantResponse.ok) {
        const details = await qdrantResponse.text();
        return {
          content: [
            {
              type: "text" as const,
              text: `Qdrant search failed (${qdrantResponse.status}): ${details}`,
            },
          ],
          isError: true,
        };
      }

      const qdrantData: any = await qdrantResponse.json();
      const results = qdrantData.result ?? [];

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No archive passages found for: ${query}`,
            },
          ],
        };
      }

      const output = results
        .map((result: any, index: number) => {
          const payload = result.payload ?? {};
          const filename = payload.filename ?? "Unknown file";
          const folderPath = payload.folder_path ?? "Unknown folder";
          const chunkNumber = payload.chunk_number ?? "?";
          const totalChunks = payload.total_chunks ?? "?";
          const score =
            typeof result.score === "number"
              ? `${(result.score * 100).toFixed(1)}%`
              : "Unknown";
          const text = payload.text ?? "";

          return [
            `RESULT ${index + 1}`,
            `File: ${filename}`,
            `Folder: ${folderPath}`,
            `Chunk: ${chunkNumber}/${totalChunks}`,
            `Relevance: ${score}`,
            "",
            text,
          ].join("
");
        })
        .join("

---

");

      return {
        content: [{ type: "text" as const, text: output }],
      };
    },
  );

  return server;
}

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext) {
    const server = createServer(env);
    const handler = createMcpHandler(server, {
      route: "/mcp",
      enableJsonResponse: true,
    });
    return handler(request, env, ctx);
  },
};
