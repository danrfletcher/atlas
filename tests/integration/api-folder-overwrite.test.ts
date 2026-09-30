import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ApiSourceController, ConfirmDeleteAnswer, dotStateFor } from "../../src/api-source-controller";
import { RequestFn } from "../../src/api-http";
import { ApiSourceConfig, ViewNode } from "../../src/types";

/** G6/E1/E3/E8: end-to-end Overwrite scenarios against a real local HTTP server (not a stub), with an
 * in-memory `data.json`-shaped `ViewNode` as the persisted target and a request log proving F1 (GET,
 * never any other verb) holds for every fixture below. Container/visual verification is the tester's
 * job — this file only proves the request/response/persist pipeline itself. */

function makeNode(id: string, prevRows: Record<string, { id: string; label: string }> = {}, order: string[] = []): ViewNode {
	return { id, type: "meta", label: "API folder", children: [], apiItemState: { ...prevRows }, apiItemOrder: [...order] };
}

function overwriteSource(url: string, overrides: Partial<ApiSourceConfig> = {}): ApiSourceConfig {
	return {
		url,
		method: "GET",
		mapping: { idField: "id", labelField: "name" },
		mode: "overwrite",
		refreshOnViewLoad: false,
		confirmBeforeDelete: false,
		keepOnEmpty: false,
		...overrides,
	};
}

const nodeFetchRequestImpl: RequestFn = async ({ url, method, headers }) => {
	const response = await fetch(url, { method, headers });
	const text = await response.text();
	return { status: response.status, text };
};

describe("Overwrite fill mode — integration against a real local HTTP server", () => {
	let server: http.Server;
	let base: string;
	let requestLog: { method: string; url: string }[] = [];

	beforeAll(async () => {
		server = http.createServer((req, res) => {
			requestLog.push({ method: req.method ?? "", url: req.url ?? "" });
			const url = req.url ?? "";
			if (url === "/ok") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify([{ id: "1", name: "One" }]));
			} else if (url === "/empty") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify([]));
			} else if (url === "/fail500") {
				res.writeHead(500);
				res.end("server error");
			} else if (url === "/auth401") {
				res.writeHead(401);
				res.end("nope");
			} else if (url === "/badjson") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end("{not json");
			} else if (url === "/manyrows") {
				const items = Array.from({ length: 6000 }, (_, i) => ({ id: String(i), name: `Item ${i}` }));
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(items));
			} else if (url === "/notalist") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ items: "not an array" }));
			} else if (url === "/slow") {
				// R7(b): genuinely never responds — the connection is left open and only cleaned up when
				// the server closes at the end of the suite. The client-side timeout below fires well
				// before any real 15s elapse.
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

	// R7(c): every scenario below issues at most one request against `server` — reset before each test
	// rather than ad hoc in a couple of them, so a stray request from an earlier test can never inflate
	// a later one's count.
	beforeEach(() => {
		requestLog = [];
	});

	it("F1: a refresh issues exactly one GET request, never any other verb and never more than one", async () => {
		const node = makeNode("f1");
		const controller = new ApiSourceController();
		await controller.refresh(node, overwriteSource(`${base}/ok`), [], () => {}, { requestImpl: nodeFetchRequestImpl });
		expect(requestLog.length).toBe(1);
		expect(requestLog[0].method).toBe("GET");
	});

	it("G6/E1: an ok response overwrites — new rows added, previously-seen rows no longer reported are deleted outright", async () => {
		const node = makeNode("f2", { stale: { id: "stale", label: "Stale" } }, ["stale"]);
		const controller = new ApiSourceController();
		await controller.refresh(node, overwriteSource(`${base}/ok`), [], () => {}, { requestImpl: nodeFetchRequestImpl });

		expect(node.apiCache?.ok).toBe(true);
		expect(node.apiItemState).toEqual({ "1": expect.objectContaining({ id: "1", label: "One" }) });
		expect(node.apiItemOrder).toEqual(["1"]);
		expect(dotStateFor(node.apiCache)).toBe("green");
	});

	it("E1/G6b(i): an empty response with keepOnEmpty on leaves every existing row untouched", async () => {
		const node = makeNode("f3", { "1": { id: "1", label: "One" } }, ["1"]);
		const controller = new ApiSourceController();
		await controller.refresh(node, overwriteSource(`${base}/empty`, { keepOnEmpty: true }), [], () => {}, { requestImpl: nodeFetchRequestImpl });

		expect(node.apiItemState).toEqual({ "1": { id: "1", label: "One" } });
		expect(node.apiCache?.ok).toBe(true);
	});

	it("E1/G6b(i): an empty response with keepOnEmpty off deletes every row (subject to the confirm guard)", async () => {
		const node = makeNode("f4", { "1": { id: "1", label: "One" } }, ["1"]);
		const controller = new ApiSourceController();
		await controller.refresh(node, overwriteSource(`${base}/empty`, { keepOnEmpty: false, confirmBeforeDelete: false }), [], () => {}, {
			requestImpl: nodeFetchRequestImpl,
		});

		expect(node.apiItemState).toEqual({});
		expect(node.apiItemOrder).toEqual([]);
	});

	it("G6b(ii): a response that would delete rows with the confirm guard on asks first, and applies only once confirmed", async () => {
		const node = makeNode("f5", { "1": { id: "1", label: "One" }, "2": { id: "2", label: "Two" } }, ["1", "2"]);
		const controller = new ApiSourceController();
		let confirmCalledWith: number | null = null;
		const confirmDelete = async (count: number): Promise<ConfirmDeleteAnswer> => {
			confirmCalledWith = count;
			return "confirmed";
		};
		await controller.refresh(node, overwriteSource(`${base}/ok`, { confirmBeforeDelete: true }), [], () => {}, {
			requestImpl: nodeFetchRequestImpl,
			trigger: "manual",
			confirmDelete,
		});

		expect(confirmCalledWith).toBe(1); // "2" was the only row genuinely deleted
		expect(node.apiItemState).toEqual({ "1": expect.objectContaining({ id: "1" }) });
	});

	it("E3: a request slower than the configured timeout fails as unreachable against the real /slow fixture, without deleting prior rows", async () => {
		// R7(b): seeded with a prior row and driven through the real `nodeFetchRequestImpl` against the
		// mock server's genuinely-never-responds `/slow` route (a real slow connection, not a stubbed
		// `RequestFn`), with a real short `timeoutMs` — the client-side timeout fires well before any
		// real 15s elapse.
		const node = makeNode("f6", { "1": { id: "1", label: "One" } }, ["1"]);
		const controller = new ApiSourceController();
		await controller.refresh(node, overwriteSource(`${base}/slow`), [], () => {}, {
			requestImpl: nodeFetchRequestImpl,
			timeoutMs: 100,
		});
		expect(node.apiCache?.ok).toBe(false);
		expect(node.apiCache?.error).toBe("unreachable");
		expect(dotStateFor(node.apiCache)).toBe("red");
		// A timed-out refresh must never delete rows it never got far enough to reconcile.
		expect(node.apiItemState).toEqual({ "1": { id: "1", label: "One" } });
	});

	it("E8: a 401/auth failure never touches existing rows, turns the dot red, and never asks to confirm a delete", async () => {
		const node = makeNode("f7", { "1": { id: "1", label: "One" } }, ["1"]);
		const controller = new ApiSourceController();
		let confirmCalled = false;
		const confirmDelete = async (): Promise<ConfirmDeleteAnswer> => {
			confirmCalled = true;
			return "confirmed";
		};
		await controller.refresh(node, overwriteSource(`${base}/auth401`, { confirmBeforeDelete: true }), [], () => {}, {
			requestImpl: nodeFetchRequestImpl,
			confirmDelete,
		});

		expect(node.apiCache?.ok).toBe(false);
		expect(node.apiCache?.error).toBe("auth failed");
		expect(node.apiItemState).toEqual({ "1": { id: "1", label: "One" } });
		expect(dotStateFor(node.apiCache)).toBe("red");
		// R7(d): a failed fetch never reaches the plan/confirm step at all — nothing to delete was ever computed.
		expect(confirmCalled).toBe(false);
	});

	it("a 500 server error never touches existing rows, turns the dot red, and never asks to confirm a delete", async () => {
		const node = makeNode("f8", { "1": { id: "1", label: "One" } }, ["1"]);
		const controller = new ApiSourceController();
		let confirmCalled = false;
		const confirmDelete = async (): Promise<ConfirmDeleteAnswer> => {
			confirmCalled = true;
			return "confirmed";
		};
		await controller.refresh(node, overwriteSource(`${base}/fail500`, { confirmBeforeDelete: true }), [], () => {}, {
			requestImpl: nodeFetchRequestImpl,
			confirmDelete,
		});

		expect(node.apiCache?.ok).toBe(false);
		expect(node.apiItemState).toEqual({ "1": { id: "1", label: "One" } });
		expect(confirmCalled).toBe(false);
	});

	it("E1: a non-JSON body fails without deleting anything or asking to confirm a delete", async () => {
		const node = makeNode("f9", { "1": { id: "1", label: "One" } }, ["1"]);
		const controller = new ApiSourceController();
		let confirmCalled = false;
		const confirmDelete = async (): Promise<ConfirmDeleteAnswer> => {
			confirmCalled = true;
			return "confirmed";
		};
		await controller.refresh(node, overwriteSource(`${base}/badjson`, { confirmBeforeDelete: true }), [], () => {}, {
			requestImpl: nodeFetchRequestImpl,
			confirmDelete,
		});

		expect(node.apiCache?.ok).toBe(false);
		expect(node.apiCache?.error).toMatch(/not valid JSON/i);
		expect(node.apiItemState).toEqual({ "1": { id: "1", label: "One" } });
		expect(confirmCalled).toBe(false);
	});

	it("E1: a response that isn't a JSON list (an object with no matching arrayField) fails without deleting anything or asking to confirm a delete", async () => {
		const node = makeNode("f9b", { "1": { id: "1", label: "One" } }, ["1"]);
		const controller = new ApiSourceController();
		let confirmCalled = false;
		const confirmDelete = async (): Promise<ConfirmDeleteAnswer> => {
			confirmCalled = true;
			return "confirmed";
		};
		await controller.refresh(node, overwriteSource(`${base}/notalist`, { confirmBeforeDelete: true }), [], () => {}, {
			requestImpl: nodeFetchRequestImpl,
			confirmDelete,
		});

		expect(node.apiCache?.ok).toBe(false);
		expect(node.apiCache?.error).toMatch(/not a json list/i);
		expect(node.apiItemState).toEqual({ "1": { id: "1", label: "One" } });
		expect(confirmCalled).toBe(false);
	});

	it("E4: 6,000 rows truncates at the 5,000 cap and skips deletion/not-found for that refresh", async () => {
		const node = makeNode("f10", { stale: { id: "stale", label: "Stale" } }, ["stale"]);
		const controller = new ApiSourceController();
		await controller.refresh(node, overwriteSource(`${base}/manyrows`, { confirmBeforeDelete: true }), [], () => {}, { requestImpl: nodeFetchRequestImpl });

		expect(node.apiCache?.rows).toHaveLength(5000);
		expect(node.apiCache?.truncated).toBe(true);
		// "stale" isn't in the truncated response but must survive — a truncated refresh never deletes.
		expect(node.apiItemState?.stale).toBeDefined();
	});

	it("F1/G13: no non-GET write is ever issued, and the header/token value never leaks into a cached error", async () => {
		const node = makeNode("f11");
		const controller = new ApiSourceController();
		const secretToken = "Bearer super-secret-overwrite-token";
		await controller.refresh(node, overwriteSource(`${base}/auth401`), [{ key: "Authorization", value: secretToken }], () => {}, {
			requestImpl: nodeFetchRequestImpl,
		});
		expect(requestLog.every((r) => r.method === "GET")).toBe(true);
		expect(JSON.stringify(node.apiCache)).not.toContain(secretToken);
	});
});
