import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const VOYAGE_API_KEY = "pa-DU_GwBAxUdpL2Zdcq3IPMSt4I58V92WI67B2rNWoeh9";
const QDRANT_URL = "https://e2feb2a4-32fa-4be0-a5cb-1e2c3e441c22.us-west-1-0.aws.cloud.qdrant.io";
const QDRANT_API_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2Nlc3MiOiJtIiwic3ViamVjdCI6ImFwaS1rZXk6ZjQ3MzU4YTktOWQzNC00YWNmLTg5MjktMGJiMGU0OGQ2NWNlIn0.4nBsvVkZwMp0mF5eCX7ZcUmP_S6le-omQulR8VcAfL4";
const REDIRECT_URI = "https://remote-mcp-server-authless.candice-9e9.workers.dev/google/callback";
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive",
].join(" ");

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

async function getGoogleAccessToken(env: any): Promise<string> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    throw new Error("Google authorization is not finished. The Worker needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN.");
  }
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: env.GOOGLE_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data: any = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(`Google token request failed (${response.status}): ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function googleFetch(env: any, url: string, init: RequestInit = {}): Promise<any> {
  const token = await getGoogleAccessToken(env);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...init, headers });
  const raw = await response.text();
  let data: any = raw;
  try { data = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok) throw new Error(`Google API request failed (${response.status}): ${raw}`);
  return data;
}

async function resolveGoogleDriveFolderPath(env: any, folderPath: string): Promise<string> {
  const parts = folderPath
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part, index) => !(index === 0 && part.toLowerCase() === "my drive"));
  if (!parts.length) return "root";
  let parentId = "root";
  for (const part of parts) {
    const escapedName = part.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const query = `'${parentId}' in parents and name = '${escapedName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const result = await googleFetch(
      env,
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,parents)&pageSize=10`,
    );
    const matches = result.files ?? [];
    if (matches.length === 0) throw new Error(`Google Drive folder not found while resolving path: ${part}`);
    if (matches.length > 1) throw new Error(`Multiple Google Drive folders named "${part}" exist under the same parent. No document was created.`);
    parentId = matches[0].id;
  }
  return parentId;
}

function chunkText(text: string, maxChunkSize = 1500): string[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";
  for (const para of paragraphs) {
    if (current.length + para.length + 2 > maxChunkSize && current.length > 0) {
      chunks.push(current.trim());
      current = para;
    } else {
      current += (current ? "\n\n" : "") + para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  const finalChunks: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxChunkSize * 1.5) {
      finalChunks.push(chunk);
    } else {
      let remaining = chunk;
      while (remaining.length > 0) {
        if (remaining.length <= maxChunkSize) {
          finalChunks.push(remaining);
          break;
        }
        let splitAt = remaining.lastIndexOf(". ", maxChunkSize);
        if (splitAt < maxChunkSize * 0.3) splitAt = maxChunkSize;
        finalChunks.push(remaining.slice(0, splitAt + 1).trim());
        remaining = remaining.slice(splitAt + 1).trim();
      }
    }
  }
  return finalChunks.length ? finalChunks : [text || "(empty document)"];
}

async function ingestIntoQdrant(
  text: string,
  metadata: { filename: string; folder_path: string; google_doc_id: string; source?: string },
): Promise<{ chunks: number; success: boolean; error?: string }> {
  if (!text.trim()) return { chunks: 0, success: true };
  const chunks = chunkText(text);
  const totalChunks = chunks.length;
  const embeddingResponse = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${VOYAGE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: chunks, model: "voyage-3.5-lite", input_type: "document" }),
  });
  if (!embeddingResponse.ok) {
    const errText = await embeddingResponse.text();
    return { chunks: 0, success: false, error: `Voyage embedding failed (${embeddingResponse.status}): ${errText}` };
  }
  const embeddingData: any = await embeddingResponse.json();
  const vectors = embeddingData.data?.map((d: any) => d.embedding);
  if (!vectors || vectors.length !== chunks.length) {
    return { chunks: 0, success: false, error: `Expected ${chunks.length} vectors, got ${vectors?.length ?? 0}` };
  }
  const points = chunks.map((chunkContent, i) => ({
    id: crypto.randomUUID(),
    vector: vectors[i],
    payload: {
      filename: metadata.filename,
      folder_path: metadata.folder_path,
      chunk_number: i + 1,
      total_chunks: totalChunks,
      text: chunkContent,
      source: metadata.source ?? "google_doc",
      google_doc_id: metadata.google_doc_id,
      file_size_kb: Math.round((text.length / 1024) * 10) / 10,
    },
  }));
  const upsertResponse = await fetch(
    `${QDRANT_URL}/collections/Voyage%20Archive/points?wait=true`,
    {
      method: "PUT",
      headers: { "api-key": QDRANT_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ points }),
    },
  );
  if (!upsertResponse.ok) {
    const errText = await upsertResponse.text();
    return { chunks: 0, success: false, error: `Qdrant upsert failed (${upsertResponse.status}): ${errText}` };
  }
  return { chunks: totalChunks, success: true };
}

async function deleteDocChunks(googleDocId: string): Promise<void> {
  await fetch(`${QDRANT_URL}/collections/Voyage%20Archive/points/delete?wait=true`, {
    method: "POST",
    headers: { "api-key": QDRANT_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      filter: { must: [{ key: "google_doc_id", match: { value: googleDocId } }] },
    }),
  });
}

async function readGoogleDocText(env: any, documentId: string): Promise<string> {
  const doc = await googleFetch(env, `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}`);
  let text = "";
  const extract = (content: any[]) => {
    for (const el of content) {
      if (el.paragraph) {
        for (const pe of el.paragraph.elements ?? []) {
          if (pe.textRun?.content) text += pe.textRun.content;
        }
      } else if (el.table) {
        for (const row of el.table.tableRows ?? []) {
          for (const cell of row.tableCells ?? []) {
            extract(cell.content ?? []);
          }
        }
      }
    }
  };
  extract(doc.body?.content ?? []);
  return text.trim();
}

async function getGoogleDocMetadata(env: any, docId: string): Promise<{ name: string; folderPath: string }> {
  const file = await googleFetch(
    env,
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(docId)}?fields=name,parents`,
  );
  const name = file.name ?? "Untitled";
  let folderPath = "My Drive";
  if (file.parents?.length) {
    const parts: string[] = [];
    let currentId = file.parents[0];
    for (let depth = 0; depth < 20; depth++) {
      if (currentId === "root") { parts.unshift("My Drive"); break; }
      const parent = await googleFetch(
        env,
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(currentId)}?fields=name,parents`,
      );
      parts.unshift(parent.name ?? "Unknown");
      if (!parent.parents?.length) { parts.unshift("My Drive"); break; }
      currentId = parent.parents[0];
    }
    folderPath = parts.join("/");
  }
  return { name, folderPath };
}

function createServer(env: any) {
  const server = new McpServer({ name: "SentinelBrain", version: "2.1.0" });

  server.tool(
    "search_archive",
    "Search Candice's entire indexed archive using natural language and return relevant passages with source details.",
    { query: z.string(), limit: z.number().int().min(1).max(20).optional() },
    async ({ query, limit }) => {
      try {
        const resultLimit = limit ?? 5;
        const embeddingResponse = await fetch("https://api.voyageai.com/v1/embeddings", {
          method: "POST",
          headers: { Authorization: `Bearer ${VOYAGE_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ input: [query], model: "voyage-3.5-lite", input_type: "query" }),
        });
        if (!embeddingResponse.ok) return textResult(`Voyage request failed (${embeddingResponse.status}): ${await embeddingResponse.text()}`, true);
        const embeddingData: any = await embeddingResponse.json();
        const vector = embeddingData.data?.[0]?.embedding;
        if (!vector) return textResult("Voyage returned no query embedding.", true);
        const qdrantResponse = await fetch(`${QDRANT_URL}/collections/Voyage%20Archive/points/search`, {
          method: "POST",
          headers: { "api-key": QDRANT_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ vector, limit: resultLimit, with_payload: true, with_vector: false }),
        });
        if (!qdrantResponse.ok) return textResult(`Qdrant search failed (${qdrantResponse.status}): ${await qdrantResponse.text()}`, true);
        const qdrantData: any = await qdrantResponse.json();
        const results = qdrantData.result ?? [];
        if (!results.length) return textResult(`No archive passages found for: ${query}`);
        const output = results.map((result: any, index: number) => {
          const p = result.payload ?? {};
          const score = typeof result.score === "number" ? `${(result.score * 100).toFixed(1)}%` : "Unknown";
          return [`RESULT ${index + 1}`, `File: ${p.filename ?? "Unknown file"}`, `Folder: ${p.folder_path ?? "Unknown folder"}`, `Chunk: ${p.chunk_number ?? "?"}/${p.total_chunks ?? "?"}`, `Relevance: ${score}`, "", p.text ?? ""].join("\n");
        }).join("\n\n---\n\n");
        return textResult(output);
      } catch (error: any) { return textResult(error?.message ?? String(error), true); }
    },
  );

  server.tool(
    "fetch_file_chunks",
    "Fetch specific chunks from an archived file by position. Requires an exact filename.",
    {
      filename: z.string().describe("Exact filename"),
      position: z.enum(["last", "first", "range"]),
      count: z.number().int().min(1).max(20).optional(),
      from_chunk: z.number().int().min(1).optional(),
      to_chunk: z.number().int().min(1).optional(),
    },
    async ({ filename, position, count, from_chunk, to_chunk }) => {
      try {
        const chunkCount = count ?? 5;
        const infoResponse = await fetch(`${QDRANT_URL}/collections/Voyage%20Archive/points/scroll`, {
          method: "POST",
          headers: { "api-key": QDRANT_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ filter: { must: [{ key: "filename", match: { value: filename } }] }, limit: 1, with_payload: true, with_vector: false }),
        });
        if (!infoResponse.ok) return textResult(`Qdrant error (${infoResponse.status}): ${await infoResponse.text()}`, true);
        const infoData: any = await infoResponse.json();
        const infoPoints = infoData.result?.points ?? [];
        if (!infoPoints.length) return textResult(`No file found in archive with name: ${filename}`);
        const totalChunks = infoPoints[0].payload?.total_chunks ?? 0;
        let minChunk = 1;
        let maxChunk = totalChunks;
        if (position === "last") minChunk = Math.max(1, totalChunks - chunkCount + 1);
        if (position === "first") maxChunk = Math.min(totalChunks, chunkCount);
        if (position === "range") {
          minChunk = from_chunk ?? 1;
          maxChunk = Math.min(totalChunks, to_chunk ?? (minChunk + chunkCount - 1));
        }
        const fetchResponse = await fetch(`${QDRANT_URL}/collections/Voyage%20Archive/points/scroll`, {
          method: "POST",
          headers: { "api-key": QDRANT_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            filter: { must: [{ key: "filename", match: { value: filename } }, { key: "chunk_number", range: { gte: minChunk, lte: maxChunk } }] },
            limit: 50,
            with_payload: true,
            with_vector: false,
          }),
        });
        if (!fetchResponse.ok) return textResult(`Qdrant fetch failed (${fetchResponse.status}): ${await fetchResponse.text()}`, true);
        const fetchData: any = await fetchResponse.json();
        const points = fetchData.result?.points ?? [];
        if (!points.length) return textResult(`No chunks found for ${filename} in range ${minChunk}-${maxChunk}`);
        points.sort((a: any, b: any) => (a.payload?.chunk_number ?? 0) - (b.payload?.chunk_number ?? 0));
        const body = points.map((point: any) => `[Chunk ${point.payload?.chunk_number}/${totalChunks}]\n${point.payload?.text ?? ""}`).join("\n\n---\n\n");
        return textResult(`File: ${filename} (${totalChunks} total chunks)\nShowing chunks ${minChunk}-${maxChunk}:\n\n${body}`);
      } catch (error: any) { return textResult(error?.message ?? String(error), true); }
    },
  );

  server.tool(
    "list_archive_files",
    "List files and folders in the archive for a project path, including chunk counts.",
    { folder_path: z.string().describe("Folder path or partial path") },
    async ({ folder_path }) => {
      try {
        const allFiles = new Map<string, { folder: string; chunks: number }>();
        let offset: string | null = null;
        for (let page = 0; page < 50; page++) {
          const scrollBody: any = {
            filter: { must: [{ key: "folder_path", match: { text: folder_path } }] },
            limit: 100,
            with_payload: { include: ["filename", "folder_path", "total_chunks"] },
            with_vector: false,
          };
          if (offset) scrollBody.offset = offset;
          const response = await fetch(`${QDRANT_URL}/collections/Voyage%20Archive/points/scroll`, {
            method: "POST",
            headers: { "api-key": QDRANT_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify(scrollBody),
          });
          if (!response.ok) return textResult(`Qdrant error (${response.status}): ${await response.text()}`, true);
          const data: any = await response.json();
          const points = data.result?.points ?? [];
          for (const point of points) {
            const p = point.payload ?? {};
            const key = `${p.filename ?? "Unknown"}|||${p.folder_path ?? "Unknown"}`;
            if (!allFiles.has(key)) allFiles.set(key, { folder: p.folder_path ?? "Unknown", chunks: p.total_chunks ?? 0 });
          }
          offset = data.result?.next_page_offset ?? null;
          if (!offset || !points.length) break;
        }
        if (!allFiles.size) return textResult(`No files found in archive matching folder path: ${folder_path}`);
        const folders = new Map<string, Array<{ name: string; chunks: number }>>();
        for (const [key, value] of allFiles) {
          const name = key.split("|||")[0];
          if (!folders.has(value.folder)) folders.set(value.folder, []);
          folders.get(value.folder)!.push({ name, chunks: value.chunks });
        }
        let output = `ARCHIVE FILES matching "${folder_path}"\nTotal unique files: ${allFiles.size}\nTotal folders: ${folders.size}\n\n`;
        for (const folder of [...folders.keys()].sort()) {
          output += `FOLDER: ${folder}\n`;
          for (const file of folders.get(folder)!.sort((a, b) => a.name.localeCompare(b.name))) output += `  ${file.name} (${file.chunks} chunks)\n`;
          output += "\n";
        }
        return textResult(output);
      } catch (error: any) { return textResult(error?.message ?? String(error), true); }
    },
  );

  server.tool(
    "create_google_doc",
    "Create a Google Doc with supplied text inside a Google Drive folder. Automatically indexes the new document into the search archive so it is instantly searchable.",
    {
      title: z.string().min(1).describe("Document title"),
      content: z.string().describe("Plain-text document content"),
      folder_id: z.string().optional().describe("Optional destination Google Drive folder ID"),
      folder_path: z.string().optional().describe("Optional full Google Drive folder path, for example My Drive/01-Projects/Project Name/Subfolder"),
    },
    async ({ title, content, folder_id, folder_path }) => {
      try {
        const suppliedFolder = folder_path ?? folder_id;
        const looksLikePath = suppliedFolder?.includes("/") || suppliedFolder?.toLowerCase().startsWith("my drive");
        const destinationFolderId = suppliedFolder
          ? (looksLikePath ? await resolveGoogleDriveFolderPath(env, suppliedFolder) : suppliedFolder)
          : undefined;
        const metadata: any = { name: title, mimeType: "application/vnd.google-apps.document" };
        if (destinationFolderId) metadata.parents = [destinationFolderId];
        const file = await googleFetch(env, "https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink,parents", {
          method: "POST",
          body: JSON.stringify(metadata),
        });
        if (content) {
          await googleFetch(env, `https://docs.googleapis.com/v1/documents/${encodeURIComponent(file.id)}:batchUpdate`, {
            method: "POST",
            body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: content } }] }),
          });
        }
        const docUrl = file.webViewLink ?? `https://docs.google.com/document/d/${file.id}/edit`;
        let ingestMsg = "";
        if (content) {
          try {
            const archivePath = (looksLikePath && suppliedFolder) ? suppliedFolder : "My Drive";
            const ingestResult = await ingestIntoQdrant(content, {
              filename: title,
              folder_path: archivePath,
              google_doc_id: file.id,
            });
            ingestMsg = ingestResult.success
              ? `\nArchive: indexed ${ingestResult.chunks} chunks.`
              : `\nArchive: indexing failed - ${ingestResult.error}`;
          } catch (ingestError: any) {
            ingestMsg = `\nArchive: indexing failed - ${ingestError?.message ?? String(ingestError)}`;
          }
        }
        return textResult(`Created Google Doc: ${file.name}\nDocument ID: ${file.id}\nURL: ${docUrl}${ingestMsg}`);
      } catch (error: any) { return textResult(error?.message ?? String(error), true); }
    },
  );

  server.tool(
    "edit_google_doc",
    "Edit an existing Google Doc without deleting the file. Append text or replace an exact passage. Automatically re-indexes the full document in the search archive after every edit.",
    {
      document_id: z.string().min(1).describe("Google Doc ID from its URL"),
      mode: z.enum(["append", "replace_text"]),
      text: z.string().describe("For append: text to add. For replace_text: replacement text."),
      find_text: z.string().optional().describe("Exact existing passage required for replace_text mode"),
    },
    async ({ document_id, mode, text, find_text }) => {
      try {
        let requests: any[];
        if (mode === "append") {
          const doc = await googleFetch(env, `https://docs.googleapis.com/v1/documents/${encodeURIComponent(document_id)}`);
          const docContent = doc.body?.content ?? [];
          const endIndex = docContent.length ? Math.max(1, (docContent[docContent.length - 1]?.endIndex ?? 2) - 1) : 1;
          requests = [{ insertText: { location: { index: endIndex }, text } }];
        } else {
          if (!find_text) return textResult("replace_text mode requires find_text. No changes were made.", true);
          requests = [{ replaceAllText: { containsText: { text: find_text, matchCase: true }, replaceText: text } }];
        }
        const result = await googleFetch(env, `https://docs.googleapis.com/v1/documents/${encodeURIComponent(document_id)}:batchUpdate`, {
          method: "POST",
          body: JSON.stringify({ requests }),
        });
        let editMsg: string;
        if (mode === "replace_text") {
          const changed = result.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
          if (changed === 0) return textResult("The exact passage was not found. No changes were made.", true);
          editMsg = `Updated Google Doc. Exact passage replacements: ${changed}`;
        } else {
          editMsg = "Appended text to Google Doc.";
        }
        let ingestMsg = "";
        try {
          const docMeta = await getGoogleDocMetadata(env, document_id);
          const fullText = await readGoogleDocText(env, document_id);
          await deleteDocChunks(document_id);
          const ingestResult = await ingestIntoQdrant(fullText, {
            filename: docMeta.name,
            folder_path: docMeta.folderPath,
            google_doc_id: document_id,
          });
          ingestMsg = ingestResult.success
            ? `\nArchive: re-indexed ${ingestResult.chunks} chunks.`
            : `\nArchive: re-indexing failed - ${ingestResult.error}`;
        } catch (ingestError: any) {
          ingestMsg = `\nArchive: re-indexing failed - ${ingestError?.message ?? String(ingestError)}`;
        }
        return textResult(`${editMsg}\nURL: https://docs.google.com/document/d/${document_id}/edit${ingestMsg}`);
      } catch (error: any) { return textResult(error?.message ?? String(error), true); }
    },
  );

  server.tool(
    "ingest_document",
    "Read an existing Google Doc and index it into the search archive. Use this for documents that already exist in Google Drive but are not yet searchable in the archive.",
    {
      document_id: z.string().min(1).describe("Google Doc ID from its URL"),
      folder_path: z.string().optional().describe("Optional override for the folder path stored in archive metadata. If omitted, the actual Google Drive folder path is resolved automatically."),
    },
    async ({ document_id, folder_path }) => {
      try {
        const docMeta = await getGoogleDocMetadata(env, document_id);
        const fullText = await readGoogleDocText(env, document_id);
        if (!fullText.trim()) return textResult(`Document "${docMeta.name}" is empty. Nothing to index.`);
        await deleteDocChunks(document_id);
        const archivePath = folder_path ?? docMeta.folderPath;
        const ingestResult = await ingestIntoQdrant(fullText, {
          filename: docMeta.name,
          folder_path: archivePath,
          google_doc_id: document_id,
        });
        if (!ingestResult.success) return textResult(`Indexing failed for "${docMeta.name}": ${ingestResult.error}`, true);
        return textResult(`Indexed "${docMeta.name}" into search archive.\nChunks: ${ingestResult.chunks}\nFolder path: ${archivePath}\nDocument ID: ${document_id}`);
      } catch (error: any) { return textResult(error?.message ?? String(error), true); }
    },
  );

  return server;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "\x26amp;").replace(/</g, "\x26lt;").replace(/>/g, "\x26gt;").replace(/"/g, "\x26quot;");
}

async function handleGoogleAuth(request: Request, env: any): Promise<Response> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return new Response("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET.", { status: 500 });
  const timestamp = Date.now().toString();
  const signature = await hmacHex(env.GOOGLE_CLIENT_SECRET, timestamp);
  const state = `${timestamp}.${signature}`;
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: GOOGLE_SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  }).toString();
  return Response.redirect(authUrl.toString(), 302);
}

async function handleGoogleCallback(request: Request, env: any): Promise<Response> {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  if (error) return new Response(`Google authorization failed: ${error}`, { status: 400 });
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";
  const [timestamp, signature] = state.split(".");
  if (!code || !timestamp || !signature) return new Response("Missing authorization code or security state.", { status: 400 });
  const expected = await hmacHex(env.GOOGLE_CLIENT_SECRET, timestamp);
  const age = Date.now() - Number(timestamp);
  if (!(await timingSafeEqual(signature, expected)) || !Number.isFinite(age) || age < 0 || age > 15 * 60 * 1000) {
    return new Response("Authorization state is invalid or expired. Start again at /google/auth.", { status: 400 });
  }
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  const tokenData: any = await tokenResponse.json();
  if (!tokenResponse.ok || !tokenData.refresh_token) {
    return new Response(`Google token exchange failed (${tokenResponse.status}): ${JSON.stringify(tokenData)}`, { status: 500 });
  }
  const safeToken = escapeHtml(String(tokenData.refresh_token));
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Google authorization complete</title><style>body{font-family:system-ui;background:#111;color:#eee;max-width:760px;margin:60px auto;padding:24px}button{font-size:18px;padding:12px 18px;cursor:pointer}#status{margin-top:16px;color:#8f8}</style></head><body><h1>Google authorization complete</h1><p>Click once to copy the final Cloudflare secret.</p><button id="copy">Copy GOOGLE_REFRESH_TOKEN</button><div id="status"></div><textarea id="token" style="position:absolute;left:-9999px">${safeToken}</textarea><script>document.getElementById('copy').onclick=async()=>{await navigator.clipboard.writeText(document.getElementById('token').value);document.getElementById('status').textContent='Copied. Add it to Cloudflare as GOOGLE_REFRESH_TOKEN.'}</script></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/google/auth") return handleGoogleAuth(request, env);
    if (url.pathname === "/google/callback") return handleGoogleCallback(request, env);
    const server = createServer(env);
    const handler = createMcpHandler(server, { route: "/mcp", enableJsonResponse: true });
    return handler(request, env, ctx);
  },
};
