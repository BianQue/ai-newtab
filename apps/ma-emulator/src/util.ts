/** Prefixed, sortable-enough IDs in the same shape as the real API's (`sesn_…`, `sevt_…`). */
export function newId(prefix: string): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `${prefix}_01${out}`;
}

export const nowIso = () => new Date().toISOString();

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** An HTTP error in the API's `{type:"error", error:{type,message}}` envelope. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly errorType: string,
    message: string,
  ) {
    super(message);
  }

  toResponse(): Response {
    return Response.json(
      { type: "error", error: { type: this.errorType, message: this.message } },
      { status: this.status },
    );
  }
}

export const notFound = (what: string, id: string) =>
  new ApiError(404, "not_found_error", `${what} ${id} not found`);
export const badRequest = (message: string) => new ApiError(400, "invalid_request_error", message);
export const conflict = (message: string) => new ApiError(409, "conflict_error", message);
