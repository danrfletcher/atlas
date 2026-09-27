import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiSourceController, ViewLoadTrigger, dotStateFor } from "../../src/api-source-controller";
import { ApiSourceConfig, ViewNode } from "../../src/types";

function makeNode(id: string): ViewNode {
	return { id, type: "meta", label: "API folder", children: [] };
}

function baseSource(url: string, overrides: Partial<ApiSourceConfig> = {}): ApiSourceConfig {
	return {
		url,
		method: "GET",
		mapping: { idField: "id", labelField: "name" },
		mode: "merge",
		refreshOnViewLoad: false,
		...overrides,
	};
}

describe("ApiSourceController — integration against a real HTTP server", () => {
	let server: http.Server;
	let base: string;
	let slowRequestCount = 0;

	beforeAll(async () => {
		server = http.createServer((req, res) => {
			const url = req.url ?? "";
			if (url === "/ok") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify([{ id: "1", name: "One" }, { id: "2", name: "Two" }]));
			} else if (url === "/auth401") {
				res.writeHead(401);
				res.end("nope");
			} else if (url === "/auth403") {
				res.writeHead(403);
				res.end("nope");
			} else if (url === "/badjson") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end("{not json");
			} else if (url === "/slow") {
				slowRequestCount++;
				setTimeout(() => {
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify([{ id: "1", name: "One" }]));
				}, 500);
			} else if (url === "/manyrows") {
				const items = Array.from({ length: 5001 }, (_, i) => ({ id: String(i), name: `Item ${i}` }));
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(items));
			} else {
				res.writeHead(404);
				res.end();
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address() as AddressInfo;
		base = `http://127.0.0.1:${address.port}`;
	});

	afterAll(() => {
		server.close();
	});

	it("G11/E2: a successful refresh maps rows, is green, and caches only mapped rows (never the raw response)", async () => {
		const node = makeNode("n1");
		expect(dotStateFor(node.apiCache)).toBe("grey");
		const controller = new ApiSourceController();
		let persisted = 0;
		await controller.refresh(node, baseSource(`${base}/ok`), [], () => persisted++, { now: () => 1000 });

		expect(persisted).toBe(1);
		expect(node.apiCache?.ok).toBe(true);
		expect(node.apiCache?.rows).toEqual([{ id: "1", label: "One" }, { id: "2", label: "Two" }]);
		expect(node.apiCache).not.toHaveProperty("raw");
		expect(dotStateFor(node.apiCache)).toBe("green");
		expect(node.apiItemState).toEqual({
			"1": { id: "1", label: "One", secondary: undefined },
			"2": { id: "2", label: "Two", secondary: undefined },
		});
	});

	it("E8: 401 surfaces as auth failed and turns the dot red", async () => {
		const node = makeNode("n2");
		const controller = new ApiSourceController();
		await controller.refresh(node, baseSource(`${base}/auth401`), [], () => {}, {});
		expect(node.apiCache?.ok).toBe(false);
		expect(node.apiCache?.error).toBe("auth failed");
		expect(dotStateFor(node.apiCache)).toBe("red");
	});

	it("E8: 403 also surfaces as auth failed", async () => {
		const node = makeNode("n3");
		const controller = new ApiSourceController();
		await controller.refresh(node, baseSource(`${base}/auth403`), [], () => {}, {});
		expect(node.apiCache?.error).toBe("auth failed");
	});

	it("E1: a non-JSON body fails without touching itemState", async () => {
		const node = makeNode("n4");
		const controller = new ApiSourceController();
		await controller.refresh(node, baseSource(`${base}/badjson`), [], () => {}, {});
		expect(node.apiCache?.ok).toBe(false);
		expect(node.apiCache?.error).toMatch(/not valid JSON/i);
		expect(node.apiItemState).toBeUndefined();
	});

	it("E3: a slow response times out and is reported unreachable, without a real 15s wait", async () => {
		const node = makeNode("n5");
		const controller = new ApiSourceController();
		const start = Date.now();
		await controller.refresh(node, baseSource(`${base}/slow`), [], () => {}, { timeoutMs: 50 });
		expect(Date.now() - start).toBeLessThan(2000);
		expect(node.apiCache?.ok).toBe(false);
		expect(node.apiCache?.error).toBe("unreachable");
	});

	it("unreachable host/port fails as unreachable, not a crash", async () => {
		const node = makeNode("n6");
		const controller = new ApiSourceController();
		const unreachableServer = http.createServer(() => {});
		await new Promise<void>((resolve) => unreachableServer.listen(0, "127.0.0.1", resolve));
		const deadPort = (unreachableServer.address() as AddressInfo).port;
		await new Promise<void>((resolve) => unreachableServer.close(() => resolve()));

		await controller.refresh(node, baseSource(`http://127.0.0.1:${deadPort}/ok`), [], () => {}, { timeoutMs: 500 });
		expect(node.apiCache?.ok).toBe(false);
		expect(node.apiCache?.error).toBe("unreachable");
	});

	it("E4: >5,000 rows truncates at the cap and skips not-found marking that refresh", async () => {
		const node = makeNode("n7");
		node.apiItemState = { stale: { id: "stale", label: "Stale" } };
		node.apiItemOrder = ["stale"];
		const controller = new ApiSourceController();
		await controller.refresh(node, baseSource(`${base}/manyrows`, { mode: "merge" }), [], () => {}, {});
		expect(node.apiCache?.rows).toHaveLength(5000);
		expect(node.apiCache?.truncated).toBe(true);
		// truncated refresh must not falsely mark "stale" not found (E4)
		expect(node.apiItemState?.stale.notFound).toBeUndefined();
	});

	it("G8: an item's explicit status and note survive a refresh where it's still reported", async () => {
		const node = makeNode("n8");
		node.apiItemState = { "1": { id: "1", label: "One", explicitStatusId: "in-progress", noteRef: { kind: "block", path: "pool/x.md", subpath: "x" } } };
		node.apiItemOrder = ["1"];
		const controller = new ApiSourceController();
		await controller.refresh(node, baseSource(`${base}/ok`), [], () => {}, {});
		expect(node.apiItemState?.["1"].explicitStatusId).toBe("in-progress");
		expect(node.apiItemState?.["1"].noteRef).toEqual({ kind: "block", path: "pool/x.md", subpath: "x" });
	});

	it("rapid double refresh-now collapses to a single in-flight request", async () => {
		slowRequestCount = 0;
		const node = makeNode("n9");
		const controller = new ApiSourceController();
		const source = baseSource(`${base}/slow`, { mapping: { idField: "id", labelField: "name" } });
		const [a, b] = [controller.refresh(node, source, [], () => {}, {}), controller.refresh(node, source, [], () => {}, {})];
		await Promise.all([a, b]);
		expect(slowRequestCount).toBe(1);
	});
});

describe("ViewLoadTrigger — G5a: fires once per open, not on every re-render", () => {
	it("activate() returns true only on the transition into active", () => {
		const trigger = new ViewLoadTrigger();
		expect(trigger.activate()).toBe(true);
		expect(trigger.activate()).toBe(false);
		expect(trigger.activate()).toBe(false);
	});

	it("deactivating and reactivating fires again exactly once", () => {
		const trigger = new ViewLoadTrigger();
		expect(trigger.activate()).toBe(true);
		trigger.deactivate();
		expect(trigger.activate()).toBe(true);
		expect(trigger.activate()).toBe(false);
	});
});
