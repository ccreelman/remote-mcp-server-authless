import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

function result(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

async function googleFetch(env: any, url: string, init: RequestInit = {}) {
  if (!env.GOOGLE_REFRESH_TOKEN) {
    throw new Error("GOOGLE_REFRESH_TOKEN is not configured.");
  }

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });

  const tokenData: any = await tokenResponse.json();
  if (!tokenResponse.ok || !tokenData.access_token) {
    throw new Error(`Google token request failed (${tokenResponse.status}).`);
  }

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${tokenData.access_token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(url, { ...init, headers });
  const raw = await response.text();
  let data: any = raw;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {}

  if (!response.ok) {
    throw new Error(`Google API request failed (${response.status}): ${raw}`);
  }
  return data;
}

async function resolveFolder(env: any, folderPath: string): Promise<string> {
  const parts = folderPath
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part, index) => !(index === 0 && part.toLowerCase() === "my drive"));

  let parentId = "root";
  for (const part of parts) {
    const escaped = part.split("\\").join("\\\\").split("'").join("\\'");
    const query =
      `'${parentId}' in parents and name = '${escaped}' and ` +
      "mimeType = 'application/vnd.google-apps.folder' and trashed = false";
    const data = await googleFetch(
      env,
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,parents)&pageSize=10`,
    );
    const matches = data.files ?? [];
    if (matches.length === 0) {
      throw new Error(`Google Drive folder not found: ${part}`);
    }
    if (matches.length > 1) {
      throw new Error(`Multiple Google Drive folders named "${part}" were found.`);
    }
    parentId = matches[0].id;
  }
  return parentId;
}

function createServer(env: any) {
  const server = new McpServer({ name: "SentinelBrain", version: "3.1.0" });

  server.tool(
    "search_archive",
    "Search the indexed archive using natural language, optionally limited to a Google Drive folder path.",
    {
      query: z.string(),
      limit: z.number().int().min(1).max(20).optional(),
      folder_path: z.string().optional().describe("Optional Google Drive folder path filter"),
    },
    async ({ query, limit, folder_path }) => {
      try {
        const embedding = await fetch("https://api.voyageai.com/v1/embeddings", {
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
        });
        if (!embedding.ok) return result(`Voyage request failed (${embedding.status}).`, true);
        const embeddingData: any = await embedding.json();
        const vector = embeddingData.data?.[0]?.embedding;
        if (!vector) return result("Voyage returned no query embedding.", true);

        const body: any = {
          vector,
          limit: limit ?? 5,
          with_payload: true,
          with_vector: false,
        };
        if (folder_path?.trim()) {
          body.filter = {
            must: [{ key: "folder_path", match: { text: folder_path.trim() } }],
          };
        }

        const response = await fetch(
          `${env.QDRANT_URL}/collections/Voyage%20Archive/points/search`,
          {
            method: "POST",
            headers: { "api-key": env.QDRANT_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        if (!response.ok) return result(`Qdrant search failed (${response.status}).`, true);
        const data: any = await response.json();
        const rows = data.result ?? [];
        if (!rows.length) return result(`No archive passages found for: ${query}`);

        const nl = String.fromCharCode(10);
        const divider = nl + nl + "---" + nl + nl;
        return result(rows.map((row: any, index: number) => {
          const p = row.payload ?? {};
          const score = typeof row.score === "number" ? `${(row.score * 100).toFixed(1)}%` : "Unknown";
          return [
            `RESULT ${index + 1}`,
            `File: ${p.filename ?? "Unknown file"}`,
            `Folder: ${p.folder_path ?? "Unknown folder"}`,
            `Chunk: ${p.chunk_number ?? "?"}/${p.total_chunks ?? "?"}`,
            `Relevance: ${score}`,
            "",
            p.text ?? "",
          ].join(nl);
        }).join(divider));
      } catch (error: any) {
        return result(error?.message ?? String(error), true);
      }
    },
  );

  server.tool(
    "fetch_file_chunks",
    "Fetch the first, last, or a range of chunks from an archived file.",
    {
      filename: z.string(),
      position: z.enum(["last", "first", "range"]),
      count: z.number().int().min(1).max(20).optional(),
      from_chunk: z.number().int().min(1).optional(),
      to_chunk: z.number().int().min(1).optional(),
    },
    async ({ filename, position, count, from_chunk, to_chunk }) => {
      try {
        const base = `${env.QDRANT_URL}/collections/Voyage%20Archive/points/scroll`;
        const headers = { "api-key": env.QDRANT_API_KEY, "Content-Type": "application/json" };
        const infoResponse = await fetch(base, {
          method: "POST",
          headers,
          body: JSON.stringify({
            filter: { must: [{ key: "filename", match: { value: filename } }] },
            limit: 1,
            with_payload: true,
            with_vector: false,
          }),
        });
        if (!infoResponse.ok) return result(`Qdrant error (${infoResponse.status}).`, true);
        const info: any = await infoResponse.json();
        const first = info.result?.points?.[0];
        if (!first) return result(`No file found in archive with name: ${filename}`);
        const total = first.payload?.total_chunks ?? 0;
        const amount = count ?? 5;
        let from = 1;
        let to = total;
        if (position === "last") from = Math.max(1, total - amount + 1);
        if (position === "first") to = Math.min(total, amount);
        if (position === "range") {
          from = from_chunk ?? 1;
          to = Math.min(total, to_chunk ?? from + amount - 1);
        }
        const response = await fetch(base, {
          method: "POST",
          headers,
          body: JSON.stringify({
            filter: { must: [
              { key: "filename", match: { value: filename } },
              { key: "chunk_number", range: { gte: from, lte: to } },
            ] },
            limit: 50,
            with_payload: true,
            with_vector: false,
          }),
        });
        if (!response.ok) return result(`Qdrant fetch failed (${response.status}).`, true);
        const data: any = await response.json();
        const points = data.result?.points ?? [];
        points.sort((a: any, b: any) => (a.payload?.chunk_number ?? 0) - (b.payload?.chunk_number ?? 0));
        const nl = String.fromCharCode(10);
        const body = points.map((point: any) => `[Chunk ${point.payload?.chunk_number ?? "?"}/${total}]${nl}${point.payload?.text ?? ""}`).join(nl + nl + "---" + nl + nl);
        return result(`File: ${filename} (${total} total chunks)${nl}Showing chunks ${from}-${to}:${nl}${nl}${body}`);
      } catch (error: any) {
        return result(error?.message ?? String(error), true);
      }
    },
  );

  server.tool(
    "list_archive_files",
    "List archived files and folders matching a project path.",
    { folder_path: z.string() },
    async ({ folder_path }) => {
      try {
        const base = `${env.QDRANT_URL}/collections/Voyage%20Archive/points/scroll`;
        const response = await fetch(base, {
          method: "POST",
          headers: { "api-key": env.QDRANT_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            filter: { must: [{ key: "folder_path", match: { text: folder_path } }] },
            limit: 100,
            with_payload: { include: ["filename", "folder_path", "total_chunks"] },
            with_vector: false,
          }),
        });
        if (!response.ok) return result(`Qdrant error (${response.status}).`, true);
        const data: any = await response.json();
        const seen = new Map<string, { folder: string; chunks: number }>();
        for (const point of data.result?.points ?? []) {
          const p = point.payload ?? {};
          const key = `${p.filename ?? "Unknown"}|||${p.folder_path ?? "Unknown"}`;
          if (!seen.has(key)) seen.set(key, { folder: p.folder_path ?? "Unknown", chunks: p.total_chunks ?? 0 });
        }
        if (!seen.size) return result(`No files found in archive matching folder path: ${folder_path}`);
        const nl = String.fromCharCode(10);
        let output = `ARCHIVE FILES matching "${folder_path}"${nl}Total unique files: ${seen.size}${nl}${nl}`;
        for (const folder of [...new Set([...seen.values()].map((v) => v.folder))].sort()) {
          output += `FOLDER: ${folder}${nl}`;
          for (const [key, value] of [...seen.entries()].filter(([, v]) => v.folder === folder).sort()) {
            output += `  ${key.split("|||")[0]} (${value.chunks} chunks)${nl}`;
          }
          output += nl;
        }
        return result(output);
      } catch (error: any) {
        return result(error?.message ?? String(error), true);
      }
    },
  );

  server.tool(
    "create_google_doc",
    "Create a Google Doc, optionally inside a Google Drive folder path or ID.",
    {
      title: z.string().min(1),
      content: z.string(),
      folder_path: z.string().optional(),
      folder_id: z.string().optional(),
    },
    async ({ title, content, folder_path, folder_id }) => {
      try {
        const parent = folder_path ? await resolveFolder(env, folder_path) : folder_id;
        const metadata: any = { name: title, mimeType: "application/vnd.google-apps.document" };
        if (parent) metadata.parents = [parent];
        const file = await googleFetch(env, "https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink", {
          method: "POST",
          body: JSON.stringify(metadata),
        });
        if (content) {
          await googleFetch(env, `https://docs.googleapis.com/v1/documents/${encodeURIComponent(file.id)}:batchUpdate`, {
            method: "POST",
            body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: content } }] }),
          });
        }
        return result(`Created Google Doc: ${file.name}${String.fromCharCode(10)}URL: ${file.webViewLink ?? `https://docs.google.com/document/d/${file.id}/edit`}`);
      } catch (error: any) {
        return result(error?.message ?? String(error), true);
      }
    },
  );

  server.tool(
    "edit_google_doc",
    "Edit an existing Google Doc by appending text or replacing an exact passage.",
    {
      document_id: z.string().min(1),
      mode: z.enum(["append", "replace_text"]),
      text: z.string(),
      find_text: z.string().optional(),
    },
    async ({ document_id, mode, text, find_text }) => {
      try {
        let requests: any[];
        if (mode === "append") {
          const doc = await googleFetch(env, `https://docs.googleapis.com/v1/documents/${encodeURIComponent(document_id)}`);
          const content = doc.body?.content ?? [];
          const endIndex = content.length ? Math.max(1, (content[content.length - 1]?.endIndex ?? 2) - 1) : 1;
          requests = [{ insertText: { location: { index: endIndex }, text } }];
        } else {
          if (!find_text) return result("replace_text mode requires find_text.", true);
          requests = [{ replaceAllText: { containsText: { text: find_text, matchCase: true }, replaceText: text } }];
        }
        const response = await googleFetch(env, `https://docs.googleapis.com/v1/documents/${encodeURIComponent(document_id)}:batchUpdate`, {
          method: "POST",
          body: JSON.stringify({ requests }),
        });
        const nl = String.fromCharCode(10);
        if (mode === "replace_text") {
          const changed = response.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
          return result(`Updated Google Doc. Exact passage replacements: ${changed}${nl}URL: https://docs.google.com/document/d/${document_id}/edit`);
        }
        return result(`Appended text to Google Doc.${nl}URL: https://docs.google.com/document/d/${document_id}/edit`);
      } catch (error: any) {
        return result(error?.message ?? String(error), true);
      }
    },
  );

  return server;
}

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext) {
    const server = createServer(env);
    return createMcpHandler(server, { route: "/mcp", enableJsonResponse: true })(request, env, ctx);
  },
};
