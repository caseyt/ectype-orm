// The cancel request against a loopback socket server standing in for Postgres (no
// database; nothing leaves the machine).
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { cancelRequestMessage, sendCancelRequest } from "./cancel.js";

const servers: Server[] = [];
const sockets: Socket[] = [];

/** A server that hands each connection to `onSocket`; resolves to its port. */
function serve(onSocket: (socket: Socket) => void, path?: string): Promise<number> {
  const server = createServer((socket) => {
    sockets.push(socket);
    onSocket(socket);
  });
  servers.push(server);
  return new Promise((resolve) => {
    const ready = (): void => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    };
    if (path === undefined) server.listen(0, "127.0.0.1", ready);
    else server.listen(path, ready);
  });
}

/** Behaves like Postgres: reads the 16 bytes, then closes the socket. */
function postgresLike(received: Buffer[]): (socket: Socket) => void {
  return (socket) => {
    socket.on("data", (chunk: Buffer) => {
      received.push(chunk);
      if (Buffer.concat(received).length >= 16) socket.end();
    });
  };
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe("cancelRequestMessage", () => {
  test("is length 16, the cancel code, the process id and the secret key, big-endian", () => {
    expect([...cancelRequestMessage(4242, -5)]).toEqual([
      0, 0, 0, 16, 4, 210, 22, 46, 0, 0, 16, 146, 255, 255, 255, 251,
    ]);
  });
});

describe("sendCancelRequest", () => {
  test("sends the message and resolves when the server closes the socket", async () => {
    const received: Buffer[] = [];
    const port = await serve(postgresLike(received));
    await sendCancelRequest({ host: "127.0.0.1", port, processId: 4242, secretKey: 99 }, 2_000);
    expect(Buffer.concat(received)).toEqual(cancelRequestMessage(4242, 99));
  });

  test("reaches a server on a Unix socket in a directory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "egon-cancel-"));
    try {
      const received: Buffer[] = [];
      await serve(postgresLike(received), join(directory, ".s.PGSQL.5432"));
      await sendCancelRequest({ host: directory, port: 5432, processId: 1, secretKey: 2 }, 2_000);
      expect(Buffer.concat(received)).toEqual(cancelRequestMessage(1, 2));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects when nothing listens", async () => {
    const port = await serve(() => undefined);
    const server = servers.pop();
    await new Promise((resolve) => server?.close(resolve));
    await expect(
      sendCancelRequest({ host: "127.0.0.1", port, processId: 1, secretKey: 2 }, 2_000),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  test("rejects when the server does not answer in time", async () => {
    const port = await serve(() => undefined);
    await expect(
      sendCancelRequest({ host: "127.0.0.1", port, processId: 1, secretKey: 2 }, 50),
    ).rejects.toThrow("The cancel request got no answer within 50 ms.");
  });
});
