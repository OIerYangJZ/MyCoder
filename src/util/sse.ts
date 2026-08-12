/**
 * Server-sent events decoding.
 *
 * Every streaming provider we target speaks SSE, so the framing is handled once
 * here and the adapters only deal with decoded `{event, data}` records.
 */

export interface SseMessage {
  event?: string;
  data: string;
  id?: string;
}

/** Decode a byte stream into SSE messages. */
export async function* decodeSse(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<SseMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf8');
  let buffer = '';

  const onAbort = (): void => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Records are separated by a blank line; \r\n is legal per the spec.
      let sep: number;
      while ((sep = findRecordEnd(buffer)) >= 0) {
        const record = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^(\r?\n){1,2}/, '');
        const message = parseRecord(record);
        if (message) yield message;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== '') {
      const message = parseRecord(buffer);
      if (message) yield message;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

function findRecordEnd(buffer: string): number {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0) return crlf;
  if (crlf < 0) return lf;
  return Math.min(lf, crlf);
}

function parseRecord(record: string): SseMessage | undefined {
  let event: string | undefined;
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const rawLine of record.split(/\r?\n/)) {
    if (rawLine === '' || rawLine.startsWith(':')) continue;
    const colon = rawLine.indexOf(':');
    const field = colon < 0 ? rawLine : rawLine.slice(0, colon);
    const value = colon < 0 ? '' : rawLine.slice(colon + 1).replace(/^ /, '');

    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
    else if (field === 'id') id = value;
  }

  if (dataLines.length === 0 && event === undefined) return undefined;
  const message: SseMessage = { data: dataLines.join('\n') };
  if (event !== undefined) message.event = event;
  if (id !== undefined) message.id = id;
  return message;
}

/** Build a readable stream from strings. Used by the fake transport in tests. */
export function stringStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i]!));
      i += 1;
    },
  });
}
