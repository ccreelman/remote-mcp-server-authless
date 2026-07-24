import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

function createServer(env: any) {
  const server = new McpServer({
    name: "SentinelBrain",
    version: "1.1.0",
  });

  server.tool(
    "search_archive",
    "Search Candice's entire indexed archive using natural language and return relevant passages with source details.",
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
          content: [{
            type: "text" as const,
            text: `Voyage request failed (${embeddingResponse.status}): ${details}`,
          }],
          isError: true,
        };
      }

      const embeddingData: any = await embeddingResponse.json();
      const vector = embeddingData.data?.[0]?.embedding;

      if (!vector) {
        return {
          content: [{ type: "text" as const, text: "Voyage returned no query embedding." }],
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
          content: [{
            type: "text" as const,
            text: `Qdrant search failed (${qdrantResponse.status}): ${details}`,
          }],
          isError: true,
        };
      }

      const qdrantData: any = await qdrantResponse.json();
      const results = qdrantData.result ?? [];

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No archive passages found for: ${query}` }],
        };
      }

      const lineBreak = String.fromCharCode(10);
      const divider = lineBreak + lineBreak + "---" + lineBreak + lineBreak;

      const output = results
        .map((result: any, index: number) => {
          const payload = result.payload ?? {};
          const filename = payload.filename ?? "Unknown file";
          const folderPath = payload.folder_path ?? "Unknown folder";
          const chunkNumber = payload.chunk_number ?? "?";
          const totalChunks = payload.total_chunks ?? "?";
          const score = typeof result.score === "number"
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
          ].join(lineBreak);
        })
        .join(divider);

      return {
        content: [{ type: "text" as const, text: output }],
      };
    },
  );

  server.tool(
    "fetch_file_chunks",
    "Fetch specific chunks from a file by position. Use to get the last N chunks (where we left off), the first N chunks, or a specific range. Requires an exact filename from the archive.",
    {
      filename: z.string().describe("Exact filename to fetch chunks from"),
      position: z.enum(["last", "first", "range"]).describe("Which chunks to fetch: last (end of file), first (start of file), or range (specific chunk numbers)"),
      count: z.number().int().min(1).max(20).optional().describe("How many chunks to return (default 5)"),
      from_chunk: z.number().int().min(1).optional().describe("For range mode: starting chunk number"),
      to_chunk: z.number().int().min(1).optional().describe("For range mode: ending chunk number"),
    },
    async ({ filename, position, count, from_chunk, to_chunk }) => {
      const chunkCount = count ?? 5;
      const lineBreak = String.fromCharCode(10);

      // Step 1: Get total chunks for this file (fetch 1 point to read total_chunks)
      const infoResponse = await fetch(
        `${env.QDRANT_URL}/collections/Voyage%20Archive/points/scroll`,
        {
          method: "POST",
          headers: {
            "api-key": env.QDRANT_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            filter: {
              must: [{ key: "filename", match: { value: filename } }],
            },
            limit: 1,
            with_payload: true,
            with_vector: false,
          }),
        },
      );

      if (!infoResponse.ok) {
        const details = await infoResponse.text();
        return {
          content: [{ type: "text" as const, text: `Qdrant error (${infoResponse.status}): ${details}` }],
          isError: true,
        };
      }

      const infoData: any = await infoResponse.json();
      const infoPoints = infoData.result?.points ?? [];

      if (infoPoints.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No file found in archive with name: ${filename}` }],
        };
      }

      const totalChunks = infoPoints[0].payload?.total_chunks ?? 0;

      // Step 2: Determine chunk range to fetch
      let minChunk = 1;
      let maxChunk = totalChunks;

      if (position === "last") {
        minChunk = Math.max(1, totalChunks - chunkCount + 1);
        maxChunk = totalChunks;
      } else if (position === "first") {
        minChunk = 1;
        maxChunk = chunkCount;
      } else if (position === "range") {
        minChunk = from_chunk ?? 1;
        maxChunk = to_chunk ?? (minChunk + chunkCount - 1);
      }

      // Step 3: Fetch the chunks in that range
      const fetchResponse = await fetch(
        `${env.QDRANT_URL}/collections/Voyage%20Archive/points/scroll`,
        {
          method: "POST",
          headers: {
            "api-key": env.QDRANT_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            filter: {
              must: [
                { key: "filename", match: { value: filename } },
                { key: "chunk_number", range: { gte: minChunk, lte: maxChunk } },
              ],
            },
            limit: 50,
            with_payload: true,
            with_vector: false,
          }),
        },
      );

      if (!fetchResponse.ok) {
        const details = await fetchResponse.text();
        return {
          content: [{ type: "text" as const, text: `Qdrant fetch failed (${fetchResponse.status}): ${details}` }],
          isError: true,
        };
      }

      const fetchData: any = await fetchResponse.json();
      const points = fetchData.result?.points ?? [];

      if (points.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No chunks found for ${filename} in range ${minChunk}-${maxChunk}` }],
        };
      }

      // Sort by chunk_number ascending
      points.sort((a: any, b: any) => (a.payload?.chunk_number ?? 0) - (b.payload?.chunk_number ?? 0));

      const header = `File: ${filename} (${totalChunks} total chunks)${lineBreak}Showing chunks ${minChunk}-${maxChunk}:${lineBreak}${lineBreak}`;

      const body = points
        .map((point: any) => {
          const p = point.payload ?? {};
          return `[Chunk ${p.chunk_number}/${totalChunks}]${lineBreak}${p.text ?? ""}`;
        })
        .join(lineBreak + lineBreak + "---" + lineBreak + lineBreak);

      return {
        content: [{ type: "text" as const, text: header + body }],
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
