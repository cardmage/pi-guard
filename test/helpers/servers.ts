/** Local HTTP target server and forward/CONNECT proxy for tests. */

import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";

export interface TargetServer {
	url: string;
	port: number;
	hits: { method: string; path: string }[];
	close(): Promise<void>;
}

export async function startTargetServer(): Promise<TargetServer> {
	const hits: { method: string; path: string }[] = [];
	const sockets = new Set<net.Socket>();
	const server = http.createServer((req, res) => {
		const method = req.method ?? "GET";
		const path = req.url ?? "/";
		hits.push({ method, path });
		const send = (status: number, headers: Record<string, string> = {}) => {
			res.writeHead(status, { "content-type": "text/plain", ...headers });
			res.end(method === "HEAD" ? undefined : `status ${status}`);
		};
		switch (path) {
			case "/ok":
				return send(200);
			case "/redirect":
				return send(301, { location: "/ok" });
			case "/redirect-missing":
				return send(302, { location: "/missing" });
			case "/missing":
				return send(404);
			case "/gone":
				return send(410);
			case "/forbidden":
				return send(403);
			case "/unauthorized":
				return send(401);
			case "/ratelimit":
				return send(429);
			case "/error":
				return send(500);
			case "/unavailable":
				return send(503);
			case "/head405":
				return method === "HEAD" ? send(405) : send(200);
			case "/head501":
				return method === "HEAD" ? send(501) : send(200);
			case "/head404-get200":
				return method === "HEAD" ? send(404) : send(200);
			case "/slow":
				// Never answers; the client must time out.
				return;
			case "/big": {
				if (method === "HEAD") return send(405);
				res.writeHead(200, { "content-type": "application/octet-stream" });
				const chunk = Buffer.alloc(64 * 1024, 1);
				let sent = 0;
				const pump = () => {
					while (sent < 2000 && res.write(chunk)) sent++;
					if (sent >= 2000) res.end();
					else res.once("drain", pump);
				};
				res.on("error", () => {});
				pump();
				return;
			}
			default:
				return send(404);
		}
	});
	server.on("connection", (s) => {
		sockets.add(s);
		s.on("close", () => sockets.delete(s));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as AddressInfo).port;
	return {
		url: `http://127.0.0.1:${port}`,
		port,
		hits,
		close: () =>
			new Promise<void>((r) => {
				for (const s of sockets) s.destroy();
				server.close(() => r());
			}),
	};
}

export interface ProxyServer {
	url: string;
	port: number;
	/** Forward requests (absolute URI) and CONNECT targets seen by the proxy. */
	hits: { type: "forward" | "connect"; target: string; auth?: string }[];
	close(): Promise<void>;
}

export interface ProxyOptions {
	/** Required `Proxy-Authorization` header value; requests without it get 407. */
	requireAuth?: string;
	/** Respond to CONNECT with this status instead of tunnelling. */
	connectStatus?: number;
	/** Send every forward request to this local port instead of the requested host (fake DNS). */
	upstreamPort?: number;
}

export async function startProxy(options: ProxyOptions = {}): Promise<ProxyServer> {
	const hits: ProxyServer["hits"] = [];
	const sockets = new Set<net.Socket>();
	const authorized = (h: http.IncomingHttpHeaders) =>
		!options.requireAuth || h["proxy-authorization"] === options.requireAuth;

	const server = http.createServer((req, res) => {
		const target = req.url ?? "";
		hits.push({ type: "forward", target, auth: req.headers["proxy-authorization"] });
		if (!authorized(req.headers)) {
			res.writeHead(407, { "proxy-authenticate": 'Basic realm="test"' });
			res.end();
			return;
		}
		let u: URL;
		try {
			u = new URL(target);
		} catch {
			res.writeHead(400);
			res.end();
			return;
		}
		const headers = { ...req.headers };
		delete headers["proxy-authorization"];
		delete headers["proxy-connection"];
		const upstream = http.request(
			{
				host: options.upstreamPort ? "127.0.0.1" : u.hostname,
				port: options.upstreamPort ?? (u.port || 80),
				path: u.pathname + u.search, method: req.method,
				headers,
			},
			(up) => {
				res.writeHead(up.statusCode ?? 502, up.headers);
				up.pipe(res);
			},
		);
		upstream.on("error", () => {
			if (!res.headersSent) res.writeHead(502);
			res.end();
		});
		req.pipe(upstream);
	});

	server.on("connect", (req, clientSocket: net.Socket, head) => {
		const target = req.url ?? "";
		hits.push({ type: "connect", target, auth: req.headers["proxy-authorization"] });
		if (!authorized(req.headers)) {
			clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\n\r\n');
			return;
		}
		if (options.connectStatus) {
			clientSocket.end(`HTTP/1.1 ${options.connectStatus} Blocked\r\n\r\n`);
			return;
		}
		const [host, port] = target.split(":");
		const upstream = net.connect(Number(port) || 443, host, () => {
			clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length) upstream.write(head);
			upstream.pipe(clientSocket);
			clientSocket.pipe(upstream);
		});
		upstream.on("error", () => clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
		clientSocket.on("error", () => upstream.destroy());
	});
	server.on("connection", (s) => {
		sockets.add(s);
		s.on("close", () => sockets.delete(s));
	});

	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as AddressInfo).port;
	return {
		url: `http://127.0.0.1:${port}`,
		port,
		hits,
		close: () =>
			new Promise<void>((r) => {
				for (const s of sockets) s.destroy();
				server.close(() => r());
			}),
	};
}

/** Saves and clears proxy-related env vars; returns a restore function. */
export function isolateProxyEnv(): () => void {
	const keys = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];
	const saved = new Map<string, string | undefined>();
	for (const k of keys) saved.set(k, process.env[k]);
	for (const k of keys) delete process.env[k];
	return () => {
		for (const k of keys) delete process.env[k];
		for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
	};
}
