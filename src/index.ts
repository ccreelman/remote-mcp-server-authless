
Here's the entire file. Copy this whole block:

```typescript
import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const VOYAGE_API_KEY = "pa-DU_GwBAxUdpL2Zdcq3IPMSt4I58V92WI67B2rNWoeh9";
const QDRANT_URL = "https://e2feb2a4-32fa-4be0-a5cb-1e2c3e441c22.us-west-1-0.aws.cloud.qdrant.io";
const QDRANT_API_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2Nlc3MiOiJtIiwic3ViamVjdCI6ImFwaS1rZXk6ZjQ3MzU4YTktOWQzNC00YWNmLTg5MjktMGJiMGU0OGQ2NWNlIn0.4nBsvVkZwMp0mF5eCX7ZcUmP_S6le-omQulR8VcAfL4";

function createServer() {
  const server = new McpServer({
    name: "SentinelBrain",
    version: "1.3.0",
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
      const embeddingResponse = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: { Authorization: `Bearer ${VOYAGE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ input: [query], model: "voyage-3.5-lite", input_type: "query" }),
      });
      if (!embeddingResponse.ok) {
        const details = await embeddingResponse.text();
        return { content: [{ type: "text" as const, text: `Voyage request failed (${embeddingResponse.status}): ${details}` }], isError: true };
      }
      const embeddingData: any = await embeddingResponse.json();
      const vector = embeddingData.data?.[0]?.embedding;
      if (!vector) {
        return { content: [{ type: "text" as const, text: "Voyage returned no query embedding." }], isError: true };
      }
      const qdrantResponse = await fetch(`${QDRANT_URL}/collections/Voyage%20Archive/points/search`, {
        method: "POST",
        headers: { "api-key": QDRANT_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ vector, limit: resultLimit, with_payload: true, with_vector: false }),
      });
      if (!qdrantResponse.ok) {
        const details = await qdrantResponse.text();
        return { content: [{ type: "text" as const, text: `Qdrant search failed (${qdrantResponse.status}): ${details}` }], isError: true };
      }
      const qdrantData: any = await qdrantResponse.json();
      const results = qdrantData.result ?? [];
      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: `No archive passages found for: ${query}` }] };
      }
      const lineBreak = String.fromCharCode(10);
      const divider = lineBreak + lineBreak + "---" + lineBreak + lineBreak;
      const output = results.map((result: any, index: number) => {
        const payload = result.payload ?? {};
        return [
          `RESULT ${index + 1}`,
          `File: ${payload.filename ?? "Unknown file"}`,
          `Folder: ${payload.folder_path ?? "Unknown folder"}`,
          `Chunk: ${payload.chunk_number ?? "?"}/${payload.total_chunks ?? "?"}`,
          `Relevance: ${typeof result.score === "number" ? `${(result.score * 100).toFixed(1)}%` : "Unknown"}`,
          "",
          payload.text ?? "",
        ].join(lineBreak);
      }).join(divider);
      return { content: [{ type: "text" as const, text: output }] };
    },
  );

  server.tool(
    "fetch_file_chunks",
    "Fetch specific chunks from a file by position. Use to get the last N chunks (where we left off), the first N chunks, or a specific range. Requires an exact filename from the archive.",
    {
      filename: z.string().describe("Exact filename to fetch chunks from"),
      position: z.enum(["last", "first", "range"]).describe("Which chunks to fetch"),
      count: z.number().int().min(1).max(20).optional().describe("How many chunks to return (default 5)"),
      from_chunk: z.number().int().min(1).optional().describe("For range mode: starting chunk number"),
      to_chunk: z.number().int().min(1).optional().describe("For range mode: ending chunk number"),
    },
    async ({ filename, position, count, from_chunk, to_chunk }) => {
      const chunkCount = count ?? 5;
      const lineBreak = String.fromCharCode(10);
      const infoResponse = await fetch(`${QDRANT_URL}/collections/Voyage%20Archive/points/scroll`, {
        method: "POST",
        headers: { "api-key": QDRANT_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ filter: { must: [{ key: "filename", match: { value: filename } }] }, limit: 1, with_payload: true, with_vector: false }),
      });
      if (!infoResponse.ok) {
        const details = await infoResponse.text();
        return { content: [{ type: "text" as const, text: `Qdrant error (${infoResponse.status}): ${details}` }], isError: true };
      }
      const infoData: any = await infoResponse.json();
      const infoPoints = infoData.result?.points ?? [];
      if (infoPoints.length === 0) {
        return { content: [{ type: "text" as const, text: `No file found in archive with name: ${filename}` }] };
      }
      const totalChunks = infoPoints[0].payload?.total_chunks ?? 0;
      let minChunk = 1;
      let maxChunk = totalChunks;
      if (position === "last") { minChunk = Math.max(1, totalChunks - chunkCount + 1); maxChunk = totalChunks; }
      else if (position === "first") { minChunk = 1; maxChunk = chunkCount; }
      else if (position === "range") { minChunk = from_chunk ?? 1; maxChunk = to_chunk ?? (minChunk + chunkCount - 1); }
      const fetchResponse = await fetch(`${QDRANT_URL}/collections/Voyage%20Archive/points/scroll`, {
        method: "POST",
        headers: { "api-key": QDRANT_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ filter: { must: [{ key: "filename", match: { value: filename } }, { key: "chunk_number", range: { gte: minChunk, lte: maxChunk } }] }, limit: 50, with_payload: true, with_vector: false }),
      });
      if (!fetchResponse.ok) {
        const details = await fetchResponse.text();
        return { content: [{ type: "text" as const, text: `Qdrant fetch failed (${fetchResponse.status}): ${details}` }], isError: true };
      }
      const fetchData: any = await fetchResponse.json();
      const points = fetchData.result?.points ?? [];
      if (points.length === 0) {
        return { content: [{ type: "text" as const, text: `No chunks found for ${filename} in range ${minChunk}-${maxChunk}` }] };
      }
      points.sort((a: any, b: any) => (a.payload?.chunk_number ?? 0) - (b.payload?.chunk_number ?? 0));
      const header = `File: ${filename} (${totalChunks} total chunks)${lineBreak}Showing chunks ${minChunk}-${maxChunk}:${lineBreak}${lineBreak}`;
      const body = points.map((point: any) => {
        const p = point.payload ?? {};
        return `[Chunk ${p.chunk_number}/${totalChunks}]${lineBreak}${p.text ?? ""}`;
      }).join(lineBreak + lineBreak + "---" + lineBreak + lineBreak);
      return { content: [{ type: "text" as const, text: header + body }] };
    },
  );

  server.tool(
    "list_archive_files",
    "List all files and folders in the archive for a given project path. Shows folder structure, filenames, and chunk counts to verify what has been properly ingested. Use this to confirm what a project can access before starting work.",
    {
      folder_path: z.string().describe("Folder path or partial path to search for (e.g. 'Beneath the Same Stars' or '04-Beneath'). Will match any folder_path containing this string."),
    },
    async ({ folder_path }) => {
      const lineBreak = String.fromCharCode(10);
      const allFiles: Map<string, { folder: string; chunks: number }> = new Map();
      let offset: string | null = null;
      let pages = 0;
      const maxPages = 50;

      while (pages < maxPages) {
        const scrollBody: any = {
          filter: { must: [{ key: "folder_path", match: { text: folder_path } }] },
          limit: 100,
          with_payload: { include: ["filename", "folder_path", "total_chunks"] },
          with_vector: false,
        };
        if (offset) { scrollBody.offset = offset; }

        const response = await fetch(`${QDRANT_URL}/collections/Voyage%20Archive/points/scroll`, {
          method: "POST",
          headers: { "api-key": QDRANT_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify(scrollBody),
        });

        if (!response.ok) {
          const details = await response.text();
          return { content: [{ type: "text" as const, text: `Qdrant error (${response.status}): ${details}` }], isError: true };
        }

        const data: any = await response.json();
        const points = data.result?.points ?? [];

        for (const point of points) {
          const p = point.payload ?? {};
          const filename = p.filename ?? "Unknown";
          const folder = p.folder_path ?? "Unknown";
          const totalChunks = p.total_chunks ?? 0;
          if (!allFiles.has(filename + "|||" + folder)) {
            allFiles.set(filename + "|||" + folder, { folder, chunks: totalChunks });
          }
        }

        offset = data.result?.next_page_offset ?? null;
        if (!offset || points.length === 0) break;
        pages++;
      }

      if (allFiles.size === 0) {
        return { content: [{ type: "text" as const, text: `No files found in archive matching folder path: ${folder_path}` }] };
      }

      const folders: Map<string, Array<{ name: string; chunks: number }>> = new Map();
      for (const [key, value] of allFiles) {
        const filename = key.split("|||")[0];
        if (!folders.has(value.folder)) { folders.set(value.folder, []); }
        folders.get(value.folder)!.push({ name: filename, chunks: value.chunks });
      }

      const sortedFolders = [...folders.keys()].sort();
      let output = `ARCHIVE FILES matching "${folder_path}"${lineBreak}`;
      output += `Total unique files: ${allFiles.size}${lineBreak}`;
      output += `Total folders: ${sortedFolders.length}${lineBreak}${lineBreak}`;

      for (const folder of sortedFolders) {
        const files = folders.get(folder)!;
        files.sort((a, b) => a.name.localeCompare(b.name));
        output += `FOLDER: ${folder}${lineBreak}`;
        for (const file of files) {
          output += `  ${file.name} (${file.chunks} chunks)${lineBreak}`;
        }
        output += lineBreak;
      }

      return { content: [{ type: "text" as const, text: output }] };
    },
  );

  return server;
}

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext) {
    const server = createServer();
    const handler = createMcpHandler(server, {
      route: "/mcp",
      enableJsonResponse: true,
    });
    return handler(request, env, ctx);
  },
};
```

Copy that whole block. On GitHub, click `src/index.ts`, click the pencil icon to edit, select all, delete, paste this in, commit.
