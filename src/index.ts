import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const VOYAGE_API_KEY = "pa-DU_GwBAxUdpL2Zdcq3IPMSt4I58V92WI67B2rNWoeh9";
const QDRANT_URL =
  "https://e2feb2a4-32fa-4be0-a5cb-1e2c3e441c22.us-west-1-0.aws.cloud.qdrant.io";
const QDRANT_API_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2Nlc3MiOiJtIiwic3ViamVjdCI6ImFwaS1rZXk6ZjQ3MzU4YTktOWQzNC00YWNmLTg5MjktMGJiMGU0OGQ2NWNlIn0.4nBsvVkZwMp0mF5eCX7ZcUmP_S6le-omQulR8VcAfL4";

const REDIRECT_URI =
  "https://remote-mcp-server-authless.candice-9e9.workers.dev/google/callback";

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive",
].join(" ");

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );

  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  if (a.length !== b.length) return false;

  let result = 0;

  for (let index = 0; index < a.length; index++) {
    result |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }

  return result === 0;
}

async function getGoogleAccessToken(env: any): Promise<string> {
  if (
    !env.GOOGLE_CLIENT_ID ||
    !env.GOOGLE_CLIENT_SECRET ||
    !env.GOOGLE_REFRESH_TOKEN
  ) {
    throw new Error(
      "Google authorization is not finished. The Worker needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN.",
    );
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });

  const data: any = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error(
      `Google token request failed (${response.status}): ${JSON.stringify(data)}`,
    );
  }

  return data.access_token;
}

async function googleFetch(
  env: any,
  url: string,
  init: RequestInit = {},
): Promise<any> {
  const token = await getGoogleAccessToken(env);
  const headers = new Headers(init.headers);

  headers.set("Authorization", `Bearer ${token}`);

  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(url, {
    ...init,
    headers,
  });

  const raw = await response.text();

  let data: any = raw;

  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = raw;
  }

  if (!response.ok) {
    throw new Error(`Google API request failed (${response.status}): ${raw}`);
  }

  return data;
}

async function resolveGoogleDriveFolderPath(
  env: any,
  folderPath: string,
): Promise<string> {
  const parts = folderPath
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter(
      (part, index) =>
        !(index === 0 && part.toLowerCase() === "my drive"),
    );

  if (!parts.length) return "root";

  let parentId = "root";

  for (const part of parts) {
    const escapedName = part
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'");

    const query =
      `'${parentId}' in parents and name = '${escapedName}' and ` +
      "mimeType = 'application/vnd.google-apps.folder' and trashed = false";

    const result = await googleFetch(
      env,
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,parents)&pageSize=10`,
    );

    const matches = result.files ?? [];

    if (matches.length === 0) {
      throw new Error(
        `Google Drive folder not found while resolving path: ${part}`,
      );
    }

    if (matches.length > 1) {
      throw new Error(
        `Multiple Google Drive folders named "${part}" exist under the same parent. No document was created.`,
      );
    }

    parentId = matches[0].id;
  }

  return parentId;
}

function createServer(env: any) {
  const server = new McpServer({
    name: "SentinelBrain",
    version: "2.1.0",
  });

  server.tool(
    "search_archive",
    "Search the indexed archive using natural language. Optionally restrict results to a specific Google Drive folder path.",
    {
      query: z.string(),
      limit: z.number().int().min(1).max(20).optional(),
      folder_path: z
        .string()
        .optional()
        .describe(
          "Optional folder path or partial folder path. Only matching archive folders will be searched.",
        ),
    },
    async ({ query, limit, folder_path }) => {
      try {
        const resultLimit = limit ?? 5;

        const embeddingResponse = await fetch(
          "https://api.voyageai.com/v1/embeddings",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${VOYAGE_API_KEY}`,
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
          return textResult(
            `Voyage request failed (${embeddingResponse.status}): ${await embeddingResponse.text()}`,
            true,
          );
        }

        const embeddingData: any = await embeddingResponse.json();
        const vector = embeddingData.data?.[0]?.embedding;

        if (!vector) {
          return textResult(
            "Voyage returned no query embedding.",
            true,
          );
        }

        const searchBody: any = {
          vector,
          limit: resultLimit,
          with_payload: true,
          with_vector: false,
        };

        if (folder_path) {
          searchBody.filter = {
            must: [
              {
                key: "folder_path",
                match: {
                  text: folder_path,
                },
              },
            ],
          };
        }

        const qdrantResponse = await fetch(
          `${QDRANT_URL}/collections/Voyage%20Archive/points/search`,
          {
            method: "POST",
            headers: {
              "api-key": QDRANT_API_KEY,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(searchBody),
          },
        );

        if (!qdrantResponse.ok) {
          return textResult(
            `Qdrant search failed (${qdrantResponse.status}): ${await qdrantResponse.text()}`,
            true,
          );
        }

        const qdrantData: any = await qdrantResponse.json();
        const results = qdrantData.result ?? [];

        if (!results.length) {
          const scope = folder_path
            ? ` in folder "${folder_path}"`
            : "";

          return textResult(
            `No archive passages found for: ${query}${scope}`,
          );
        }

        const output = results
          .map((result: any, index: number) => {
            const payload = result.payload ?? {};
            const score =
              typeof result.score === "number"
                ? `${(result.score * 100).toFixed(1)}%`
                : "Unknown";

            return [
              `RESULT ${index + 1}`,
              `File: ${payload.filename ?? "Unknown file"}`,
              `Folder: ${payload.folder_path ?? "Unknown folder"}`,
              `Chunk: ${payload.chunk_number ?? "?"}/${payload.total_chunks ?? "?"}`,
              `Relevance: ${score}`,
              "",
              payload.text ?? "",
            ].join("\n");
          })
          .join("\n\n--- 
\n");

        return textResult(output);
      } catch (error: any) {
        return textResult(error?.message ?? String(error), true);
      }
    },
  );

  server.tool(
    "fetch_file_chunks",
    "Fetch specific chunks from an archived file by position.",
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

        const infoResponse = await fetch(
          `${QDRANT_URL}/collections/Voyage%20Archive/points/scroll`,
          {
            method: "POST",
            headers: {
              "api-key": QDRANT_API_KEY,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              filter: {
                must: [
                  {
                    key: "filename",
                    match: { value: filename },
                  },
                ],
              },
              limit: 1,
              with_payload: true,
              with_vector: false,
            }),
          },
        );

        if (!infoResponse.ok) {
          return textResult(
            `Qdrant error (${infoResponse.status}): ${await infoResponse.text()}`,
            true,
          );
        }

        const infoData: any = await infoResponse.json();
        const infoPoints = infoData.result?.points ?? [];

        if (!infoPoints.length) {
          return textResult(
            `No file found in archive with name: ${filename}`,
          );
        }

        const totalChunks =
          infoPoints[0].payload?.total_chunks ?? 0;

        let minChunk = 1;
        let maxChunk = totalChunks;

        if (position === "last") {
          minChunk = Math.max(1, totalChunks - chunkCount + 1);
        }

        if (position === "first") {
          maxChunk = Math.min(totalChunks, chunkCount);
        }

        if (position === "range") {
          minChunk = from_chunk ?? 1;
          maxChunk = Math.min(
            totalChunks,
            to_chunk ?? minChunk + chunkCount - 1,
          );
        }

        const fetchResponse = await fetch(
          `${QDRANT_URL}/collections/Voyage%20Archive/points/scroll`,
          {
            method: "POST",
            headers: {
              "api-key": QDRANT_API_KEY,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              filter: {
                must: [
                  {
                    key: "filename",
                    match: { value: filename },
                  },
                  {
                    key: "chunk_number",
                    range: {
                      gte: minChunk,
                      lte: maxChunk,
                    },
                  },
                ],
              },
              limit: 50,
              with_payload: true,
              with_vector: false,
            }),
          },
        );

        if (!fetchResponse.ok) {
          return textResult(
            `Qdrant fetch failed (${fetchResponse.status}): ${await fetchResponse.text()}`,
            true,
          );
        }

        const fetchData: any = await fetchResponse.json();
        const points = fetchData.result?.points ?? [];

        if (!points.length) {
          return textResult(
            `No chunks found for ${filename} in range ${minChunk}-${maxChunk}`,
          );
        }

        points.sort(
          (a: any, b: any) =>
            (a.payload?.chunk_number ?? 0) -
            (b.payload?.chunk_number ?? 0),
        );

        const body = points
          .map(
            (point: any) =>
              `[Chunk ${point.payload?.chunk_number}/${totalChunks}]\n${point.payload?.text ?? ""}`,
          )
          .join("\n\n--- 
\n");

        return textResult(
          `File: ${filename} (${totalChunks} total chunks)\nShowing chunks ${minChunk}-${maxChunk}:\n\n${body}`,
        );
      } catch (error: any) {
        return textResult(error?.message ?? String(error), true);
      }
    },
  );

  server.tool(
    "list_archive_files",
    "List archived files and folders matching a project path.",
    {
      folder_path: z.string().describe("Folder path or partial path"),
    },
    async ({ folder_path }) => {
      try {
        const allFiles = new Map<
          string,
          { folder: string; chunks: number }
        >();

        let offset: string | null = null;

        for (let page = 0; page < 50; page++) {
          const scrollBody: any = {
            filter: {
              must: [
                {
                  key: "folder_path",
                  match: { text: folder_path },
                },
              ],
            },
            limit: 100,
            with_payload: {
              include: [
                "filename",
                "folder_path",
                "total_chunks",
              ],
            },
            with_vector: false,
          };

          if (offset) {
            scrollBody.offset = offset;
          }

          const response = await fetch(
            `${QDRANT_URL}/collections/Voyage%20Archive/points/scroll`,
            {
              method: "POST",
              headers: {
                "api-key": QDRANT_API_KEY,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(scrollBody),
            },
          );

          if (!response.ok) {
            return textResult(
              `Qdrant error (${response.status}): ${await response.text()}`,
              true,
            );
          }

          const data: any = await response.json();
          const points = data.result?.points ?? [];

          for (const point of points) {
            const payload = point.payload ?? {};
            const filename = payload.filename ?? "Unknown";
            const folder = payload.folder_path ?? "Unknown";
            const key = `${filename}|||${folder}`;

            if (!allFiles.has(key)) {
              allFiles.set(key, {
                folder,
                chunks: payload.total_chunks ?? 0,
              });
            }
          }

          offset = data.result?.next_page_offset ?? null;

          if (!offset || !points.length) {
            break;
          }
        }

        if (!allFiles.size) {
          return textResult(
            `No files found in archive matching folder path: ${folder_path}`,
          );
        }

        const folders = new Map<
          string,
          Array<{ name: string; chunks: number }>
        >();

        for (const [key, value] of allFiles) {
          const name = key.split("|||")[0];

          if (!folders.has(value.folder)) {
            folders.set(value.folder, []);
          }

          folders.get(value.folder)!.push({
            name,
            chunks: value.chunks,
          });
        }

        let output =
          `ARCHIVE FILES matching "${folder_path}" 
` +
          `Total unique files: ${allFiles.size}\n` +
          `Total folders: ${folders.size}\n\n`;

        for (const folder of [...folders.keys()].sort()) {
          output += `FOLDER: ${folder}\n`;

          for (const file of folders
            .get(folder)!
            .sort((a, b) => a.name.localeCompare(b.name))) {
            output += ` ${file.name} (${file.chunks} chunks)\n`;
          }

          output += "\n";
        }

        return textResult(output);
      } catch (error: any) {
        return textResult(error?.message ?? String(error), true);
      }
    },
  );

  server.tool(
    "create_google_drive_folder",
    "Create a Google Drive folder or nested folder path. Reuses existing folders and creates only missing segments.",
    {
      folder_path: z
        .string()
        .min(1)
        .describe("Full Google Drive folder path"),
    },
    async ({ folder_path }) => {
      try {
        const parts = folder_path
          .split("/")
          .map((part) => part.trim())
          .filter(Boolean)
          .filter(
            (part, index) =>
              !(index === 0 && part.toLowerCase() === "my drive"),
          );

        if (!parts.length) {
          return textResult(
            "No folder name was provided. No changes were made.",
            true,
          );
        }

        let parentId = "root";
        const created: string[] = [];
        const reused: string[] = [];

        for (const part of parts) {
          const escapedName = part
            .replace(/\\/g, "\\\\")
            .replace(/'/g, "\\'");

          const query =
            `'${parentId}' in parents and name = '${escapedName}' and ` +
            "mimeType = 'application/vnd.google-apps.folder' and trashed = false";

          const result = await googleFetch(
            env,
            `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,parents)&pageSize=10`,
          );

          const matches = result.files ?? [];

          if (matches.length > 1) {
            return textResult(
              `Multiple folders named "${part}" exist under the same parent. No new folder was created at this level.`,
              true,
            );
          }

          if (matches.length === 1) {
            parentId = matches[0].id;
            reused.push(part);
            continue;
          }

          const folder = await googleFetch(
            env,
            "https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink,parents",
            {
              method: "POST",
              body: JSON.stringify({
                name: part,
                mimeType: "application/vnd.google-apps.folder",
                parents: [parentId],
              }),
            },
          );

          parentId = folder.id;
          created.push(part);
        }

        return textResult(
          [
            `Google Drive folder path ready: ${folder_path}`,
            `Folder ID: ${parentId}`,
            `URL: https://drive.google.com/drive/folders/${parentId}`,
            `Created: ${created.length ? created.join(" / ") : "none"}`,
            `Reused existing: ${reused.length ? reused.join(" / ") : "none"}`,
          ].join("\n"),
        );
      } catch (error: any) {
        return textResult(error?.message ?? String(error), true);
      }
    },
  );

  server.tool(
    "create_google_doc",
    "Create a Google Doc inside a Google Drive folder using a folder path or folder ID.",
    {
      title: z
        .string()
        .min(1)
        .describe("Document title"),
      content: z
        .string()
        .describe("Plain-text document content"),
      folder_id: z
        .string()
        .optional()
        .describe("Optional folder ID"),
      folder_path: z
        .string()
        .optional()
        .describe("Optional folder path"),
    },
    async ({ title, content, folder_id, folder_path }) => {
      try {
        const suppliedFolder = folder_path ?? folder_id;

        const looksLikePath =
          suppliedFolder?.includes("/") ||
          suppliedFolder?.toLowerCase().startsWith("my drive");

        const destinationFolderId = suppliedFolder
          ? looksLikePath
            ? await resolveGoogleDriveFolderPath(
                env,
                suppliedFolder,
              )
            : suppliedFolder
          : undefined;

        const metadata: any = {
          name: title,
          mimeType: "application/vnd.google-apps.document",
        };

        if (destinationFolderId) {
          metadata.parents = [destinationFolderId];
        }

        const file = await googleFetch(
          env,
          "https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink,parents",
          {
            method: "POST",
            body: JSON.stringify(metadata),
          },
        );

        if (content) {
          await googleFetch(
            env,
            `https://docs.googleapis.com/v1/documents/${encodeURIComponent(file.id)}:batchUpdate`,
            {
              method: "POST",
              body: JSON.stringify({
                requests: [
                  {
                    insertText: {
                      location: { index: 1 },
                      text: content,
                    },
                  },
                ],
              }),
            },
          );
        }

        return textResult(
          [
            `Created Google Doc: ${file.name}`,
            `Document ID: ${file.id}`,
            `URL: ${file.webViewLink ?? `https://docs.google.com/document/d/${file.id}/edit`}`,
          ].join("\n"),
        );
      } catch (error: any) {
        return textResult(error?.message ?? String(error), true);
      }
    },
  );

  server.tool(
    "edit_google_doc",
    "Edit an existing Google Doc by appending text or replacing an exact passage.",
    {
      document_id: z
        .string()
        .min(1)
        .describe("Google Doc ID"),
      mode: z.enum(["append", "replace_text"]),
      text: z.string(),
      find_text: z
        .string()
        .optional(),
    },
    async ({ document_id, mode, text, find_text }) => {
      try {
        let requests: any[];

        if (mode === "append") {
          const doc = await googleFetch(
            env,
            `https://docs.googleapis.com/v1/documents/${encodeURIComponent(document_id)}`,
          );

          const content = doc.body?.content ?? [];
          const endIndex = content.length
            ? Math.max(
                1,
                (content[content.length - 1]?.endIndex ?? 2) - 1,
              )
            : 1;

          requests = [
            {
              insertText: {
                location: { index: endIndex },
                text,
              },
            },
          ];
        } else {
          if (!find_text) {
            return textResult(
              "replace_text mode requires find_text. No changes were made.",
              true,
            );
          }

          requests = [
            {
              replaceAllText: {
                containsText: {
                  text: find_text,
                  matchCase: true,
                },
                replaceText: text,
              },
            },
          ];
        }

        const result = await googleFetch(
          env,
          `https://docs.googleapis.com/v1/documents/${encodeURIComponent(document_id)}:batchUpdate`,
          {
            method: "POST",
            body: JSON.stringify({ requests }),
          },
        );

        if (mode === "replace_text") {
          const changed =
            result.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;

          if (changed === 0) {
            return textResult(
              "The exact passage was not found. No changes were made.",
              true,
            );
          }

          return textResult(
            `Updated Google Doc. Exact passage replacements: ${changed}\nURL: https://docs.google.com/document/d/${document_id}/edit`,
          );
        }

        return textResult(
          `Appended text to Google Doc.\nURL: https://docs.google.com/document/d/${document_id}/edit`,
        );
      } catch (error: any) {
        return textResult(error?.message ?? String(error), true);
      }
    },
  );

  return server;
}

async function handleGoogleAuth(
  request: Request,
  env: any,
): Promise<Response> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return new Response(
      "Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET.",
      { status: 500 },
    );
  }

  const timestamp = Date.now().toString();
  const signature = await hmacHex(
    env.GOOGLE_CLIENT_SECRET,
    timestamp,
  );

  const authUrl = new URL(
    "https://accounts.google.com/o/oauth2/v2/auth",
  );

  authUrl.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: GOOGLE_SCOPES,
    access_type: "offline",
    prompt: "consent",
    state: `${timestamp}.${signature}`,
  }).toString();

  return Response.redirect(authUrl.toString(), 302);
}

async function handleGoogleCallback(
  request: Request,
  env: any,
): Promise<Response> {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");

  if (error) {
    return new Response(
      `Google authorization failed: ${error}`,
      { status: 400 },
    );
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";
  const [timestamp, signature] = state.split(".");

  if (!code || !timestamp || !signature) {
    return new Response(
      "Missing authorization code or security state.",
      { status: 400 },
    );
  }

  const expected = await hmacHex(
    env.GOOGLE_CLIENT_SECRET,
    timestamp,
  );

  const age = Date.now() - Number(timestamp);

  if (
    !(await timingSafeEqual(signature, expected)) ||
    !Number.isFinite(age) ||
    age < 0 ||
    age > 15 * 60 * 1000
  ) {
    return new Response(
      "Authorization state is invalid or expired. Start again at /google/auth.",
      { status: 400 },
    );
  }

  const tokenResponse = await fetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    },
  );

  const tokenData: any = await tokenResponse.json();

  if (!tokenResponse.ok || !tokenData.refresh_token) {
    return new Response(
      `Google token exchange failed (${tokenResponse.status}): ${JSON.stringify(tokenData)}`,
      { status: 500 },
    );
  }

  const safeToken = String(tokenData.refresh_token)
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, """);

  return new Response(
    `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Google authorization complete</title>
<style>
body{font-family:system-ui;background:#111;color:#eee;max-width:760px;margin:60px auto;padding:24px}
button{font-size:18px;padding:12px 18px;cursor:pointer}
#status{margin-top:16px;color:#8f8}
textarea{width:100%;height:120px;margin-top:16px}
</style>
</head>
<body>
<h1>Google authorization complete</h1>
<p>Copy this value into the Cloudflare secret named GOOGLE_REFRESH_TOKEN.</p>
<textarea id="token" readonly>${safeToken}</textarea>
<br>
<button id="copy">Copy token</button>
<div id="status"></div>
<script>
document.getElementById("copy").onclick = async () => {
  await navigator.clipboard.writeText(document.getElementById("token").value);
  document.getElementById("status").textContent = "Copied.";
};
</script>
</body>
</html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=UTF-8",
      },
    },
  );
}

export default {
  async fetch(
    request: Request,
    env: any,
    ctx: ExecutionContext,
  ) {
    const url = new URL(request.url);

    if (url.pathname === "/google/auth") {
      return handleGoogleAuth(request, env);
    }

    if (url.pathname === "/google/callback") {
      return handleGoogleCallback(request, env);
    }

    const server = createServer(env);

    const handler = createMcpHandler(server, {
      route: "/mcp",
      enableJsonResponse: true,
    });

    return handler(request, env, ctx);
  },
};
