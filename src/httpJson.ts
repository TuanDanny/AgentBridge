import http from "node:http";

export interface JsonResponse<T = unknown> {
  status: number;
  body: T;
}

export function requestJson<T = unknown>(input: {
  host: string;
  port: number;
  path: string;
  method?: string;
  token?: string;
  body?: unknown;
  timeoutMs?: number;
}): Promise<JsonResponse<T>> {
  const payload = input.body === undefined ? undefined : JSON.stringify(input.body);

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: input.host,
        port: input.port,
        path: input.path,
        method: input.method ?? "GET",
        timeout: input.timeoutMs ?? 2000,
        headers: {
          ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {})
        }
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              body: raw ? (JSON.parse(raw) as T) : ({} as T)
            });
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("Request timed out."));
    });
    request.on("error", reject);
    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}
