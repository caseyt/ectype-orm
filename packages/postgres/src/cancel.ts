/**
 * The protocol's cancel request: what libpq's `PQcancel` and `pg` send to stop a running
 * statement. A new socket to the server carries 16 bytes (length, the cancel code, the
 * backend's process id and secret key) and is closed by the server once it has acted on
 * them. It needs no authentication and no free connection slot, and a pooler that
 * forwards cancel requests (PgBouncer does) passes it on to the right backend. It is sent
 * without TLS, as libpq has long sent it; it carries no credentials.
 *
 * @module
 */
import { connect, type Socket } from "node:net";

/** Where to send a cancel request, and the key of the backend whose statement it stops. */
export interface CancelTarget {
  /** A host name or address, or a Unix-socket directory (starting with `/`). */
  readonly host: string;
  readonly port: number;
  readonly processId: number;
  readonly secretKey: number;
}

/** The protocol's code for a cancel request (1234 in the high 16 bits, 5678 in the low). */
const CANCEL_REQUEST_CODE = 80_877_102;

/** The 16 bytes of a cancel request. */
export function cancelRequestMessage(processId: number, secretKey: number): Buffer {
  const message = Buffer.alloc(16);
  message.writeInt32BE(16, 0);
  message.writeInt32BE(CANCEL_REQUEST_CODE, 4);
  message.writeInt32BE(processId | 0, 8);
  message.writeInt32BE(secretKey | 0, 12);
  return message;
}

/**
 * Sends a cancel request. Resolves when the server has closed the socket, which it does
 * after handling the request; rejects when the server cannot be reached or does not
 * answer within `timeoutMs`. The server never says whether a statement was cancelled: a
 * backend that is idle by then ignores the request.
 */
export function sendCancelRequest(target: CancelTarget, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket: Socket = target.host.startsWith("/")
      ? connect(`${target.host}/.s.PGSQL.${target.port}`)
      : connect(target.port, target.host);
    let settled = false;
    const finish = (error: Error | undefined): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error === undefined) resolve();
      else reject(error);
    };
    socket.setTimeout(timeoutMs, () =>
      finish(new Error(`The cancel request got no answer within ${timeoutMs} ms.`)),
    );
    socket.once("error", finish);
    socket.once("connect", () => {
      socket.end(cancelRequestMessage(target.processId, target.secretKey));
    });
    socket.once("close", () => finish(undefined));
    // The server sends nothing back; reading keeps the socket flowing until it closes.
    socket.resume();
  });
}
