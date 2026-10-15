// The cancel request against loopback socket servers standing in for Postgres (no
// database; nothing leaves the machine): in plain text, after an SSLRequest, and with
// direct TLS.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer, TLSSocket } from "node:tls";
import { afterEach, describe, expect, test } from "vitest";
import { TEST_CERT, TEST_KEY } from "../test/tls-fixture.js";
import { type CancelTarget, cancelRequestMessage, sendCancelRequest, sslRequestMessage } from "./cancel.js";

const servers: Server[] = [];
const sockets: Socket[] = [];

function listen(server: Server, path?: string): Promise<number> {
  servers.push(server);
  server.on("connection", (socket: Socket) => sockets.push(socket));
  return new Promise((resolve) => {
    const ready = (): void => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    };
    if (path === undefined) server.listen(0, "127.0.0.1", ready);
    else server.listen(path, ready);
  });
}

/** Reads 16 bytes into `received`, then closes the socket, as Postgres does. */
function readCancel(socket: Socket, received: Buffer[]): void {
  socket.on("data", (chunk: Buffer) => {
    received.push(chunk);
    if (Buffer.concat(received).length >= 16) socket.end();
  });
}

/** A plain-text server. */
function plainServer(received: Buffer[], path?: string): Promise<number> {
  return listen(
    createServer((socket) => readCancel(socket, received)),
    path,
  );
}

/**
 * A server that answers an SSLRequest with `answer` ("S" then TLS, or "N"), and records
 * every byte it gets afterwards, encrypted or not, in `received`.
 */
function sslRequestServer(answer: "S" | "N", received: Buffer[], requests: Buffer[]): Promise<number> {
  return listen(
    createServer((socket) => {
      socket.once("data", (request: Buffer) => {
        requests.push(request);
        if (answer === "N") {
          socket.write("N");
          socket.on("data", (chunk: Buffer) => received.push(chunk));
          return;
        }
        socket.write("S");
        const secure = new TLSSocket(socket, { isServer: true, key: TEST_KEY, cert: TEST_CERT });
        secure.on("error", () => undefined);
        readCancel(secure, received);
      });
    }),
  );
}

function target(port: number, overrides: Partial<CancelTarget> = {}): CancelTarget {
  return {
    host: "127.0.0.1",
    port,
    serverName: "localhost",
    processId: 4242,
    secretKey: 99,
    ssl: false,
    sslNegotiation: "postgres",
    ...overrides,
  };
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe("messages", () => {
  test("a cancel request is length 16, the cancel code, the process id and the secret key, big-endian", () => {
    expect([...cancelRequestMessage(4242, -5)]).toEqual([
      0, 0, 0, 16, 4, 210, 22, 46, 0, 0, 16, 146, 255, 255, 255, 251,
    ]);
  });

  test("an SSLRequest is length 8 and its code", () => {
    expect([...sslRequestMessage()]).toEqual([0, 0, 0, 8, 4, 210, 22, 47]);
  });
});

describe("without TLS", () => {
  test("sends the request in plain text and resolves when the server closes the socket", async () => {
    const received: Buffer[] = [];
    const port = await plainServer(received);
    await sendCancelRequest(target(port), 2_000);
    expect(Buffer.concat(received)).toEqual(cancelRequestMessage(4242, 99));
  });

  test("reaches a server on a Unix socket in a directory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "egon-cancel-"));
    try {
      const received: Buffer[] = [];
      await plainServer(received, join(directory, ".s.PGSQL.5432"));
      await sendCancelRequest(target(5432, { host: directory, processId: 1, secretKey: 2 }), 2_000);
      expect(Buffer.concat(received)).toEqual(cancelRequestMessage(1, 2));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects when nothing listens", async () => {
    const port = await plainServer([]);
    const server = servers.pop();
    await new Promise((resolve) => server?.close(resolve));
    await expect(sendCancelRequest(target(port), 2_000)).rejects.toThrow(/ECONNREFUSED/);
  });

  test("rejects when the server does not answer in time", async () => {
    const port = await listen(createServer(() => undefined));
    await expect(sendCancelRequest(target(port), 50)).rejects.toThrow(
      "The cancel request got no answer within 50 ms.",
    );
  });
});

describe("with TLS", () => {
  test("asks for TLS, then sends the request encrypted with the connection's TLS options", async () => {
    const received: Buffer[] = [];
    const requests: Buffer[] = [];
    const port = await sslRequestServer("S", received, requests);
    await sendCancelRequest(target(port, { ssl: { ca: TEST_CERT } }), 2_000);
    expect(requests).toEqual([sslRequestMessage()]);
    expect(Buffer.concat(received)).toEqual(cancelRequestMessage(4242, 99));
  });

  test("checks the certificate against the configured host name, not the address it connects to", async () => {
    const port = await sslRequestServer("S", [], []);
    await expect(
      sendCancelRequest(target(port, { serverName: "db.example.com", ssl: { ca: TEST_CERT } }), 2_000),
    ).rejects.toThrow(/db\.example\.com/);
  });

  test("a host given as an IP address is checked against the certificate's IP, without SNI", async () => {
    const received: Buffer[] = [];
    const port = await sslRequestServer("S", received, []);
    await sendCancelRequest(target(port, { serverName: "127.0.0.1", ssl: { ca: TEST_CERT } }), 2_000);
    expect(Buffer.concat(received)).toEqual(cancelRequestMessage(4242, 99));
  });

  test("ssl: true uses the system's certificate authorities, which do not trust a self-signed one", async () => {
    const received: Buffer[] = [];
    const port = await sslRequestServer("S", received, []);
    await expect(sendCancelRequest(target(port, { ssl: true }), 2_000)).rejects.toThrow(/self-signed/);
    expect(received).toEqual([]);
  });

  test("never falls back to plain text when the server refuses TLS", async () => {
    const received: Buffer[] = [];
    const requests: Buffer[] = [];
    const port = await sslRequestServer("N", received, requests);
    await expect(sendCancelRequest(target(port, { ssl: { ca: TEST_CERT } }), 2_000)).rejects.toThrow(
      "The server refused TLS for the cancel request, so it was not sent.",
    );
    expect(requests).toHaveLength(1);
    expect(received).toEqual([]);
  });

  test("a server that closes before the request was sent is a failure", async () => {
    const port = await listen(createServer((socket) => socket.once("data", () => socket.destroy())));
    await expect(sendCancelRequest(target(port, { ssl: { ca: TEST_CERT } }), 2_000)).rejects.toThrow(
      /closed the connection before the cancel request was sent/,
    );
  });

  test("direct TLS starts the handshake at once, with the postgresql ALPN protocol", async () => {
    const received: Buffer[] = [];
    const protocols: unknown[] = [];
    const server = createTlsServer(
      { key: TEST_KEY, cert: TEST_CERT, ALPNProtocols: ["postgresql"] },
      (socket) => {
        protocols.push(socket.alpnProtocol);
        readCancel(socket, received);
      },
    );
    const port = await listen(server);
    await sendCancelRequest(target(port, { ssl: { ca: TEST_CERT }, sslNegotiation: "direct" }), 2_000);
    expect(protocols).toEqual(["postgresql"]);
    expect(Buffer.concat(received)).toEqual(cancelRequestMessage(4242, 99));
  });

  test("TLS options that tls.connect refuses are a failure", async () => {
    const port = await sslRequestServer("S", [], []);
    await expect(
      sendCancelRequest(target(port, { ssl: { minVersion: "not-a-version" as "TLSv1.2" } }), 2_000),
    ).rejects.toThrow();
  });
});
