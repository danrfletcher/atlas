import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiSourceController, ViewLoadTrigger, dotStateFor, dotTooltip } from "../../src/api-source-controller";
import { RequestFn, ScheduleTimeout } from "../../src/api-http";
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

/** R1: a `RequestFn` backed by Node's own `fetch` — a stand-in for production's `obsidianRequestImpl`
 * (which can't be used under plain Node/vitest, since `obsidian` is types-only). Exercises the real
 * `httpGetJson` request/response handling end-to-end against `server` below, same as before this PR's
 * fix, just via the now-required injected `requestImpl` instead of a global default. */
const nodeFetchRequestImpl: RequestFn = async ({ url, method, headers }) => {
	const response = await fetch(url, { method, headers });
	const text = await response.text();
	return { status: response.status, text };
};

describe("ApiSourceController — integration against a real HTTP server", () => {
	let server: http.Server;
	let base: string;

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
			} else if (url === "/withstale") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify([{ id: "stale", name: "Stale" }, { id: "1", name: "One" }]));
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
		await controller.refresh(node, baseSource(`${base}/ok`), [], () => persisted++, { requestImpl: nodeFetchRequestImpl, now: () => 1000 });

		expect(persisted).toBe(1);
		expect(node.apiCache?.ok).toBe(true);
		expect(node.apiCache?.rows).toEqual([{ id: "1", label: "One" }, { id: "2", label: "Two" }]);
		expect(node.apiCache).not.toHaveProperty("raw");
		expect(node.apiCache?.lastSuccessAt).toBe(1000);
		expect(dotStateFor(node.apiCache)).toBe("green");
		expect(node.apiItemState).toEqual({
			"1": { id: "1", label: "One", secondary: undefined, lastSeenAt: new Date(1000).toISOString() },
			"2": { id: "2", label: "Two", secondary: undefined, lastSeenAt: new Date(1000).toISOString() },
		});
	});

	it("E8: 401 surfaces as auth failed and turns the dot red", async () => {
		const node = makeNode("n2");
		const controller = new ApiSourceController();
		await controller.refresh(node, baseSource(`${base}/auth401`), [], () => {}, { requestImpl: nodeFetchRequestImpl });
		expect(node.apiCache?.ok).toBe(false);
		expect(node.apiCache?.error).toBe("auth failed");
		expect(dotStateFor(node.apiCache)).toBe("red");
	});

	it("E8: 403 also surfaces as auth failed", async () => {
		const node = makeNode("n3");
		const controller = new ApiSourceController();
		await controller.refresh(node, baseSource(`${base}/auth403`), [], () => {}, { requestImpl: nodeFetchRequestImpl });
		expect(node.apiCache?.error).toBe("auth failed");
	});

	it("E1: a non-JSON body fails without touching itemState", async () => {
		const node = makeNode("n4");
		const controller = new ApiSourceController();
		await controller.refresh(node, baseSource(`${base}/badjson`), [], () => {}, { requestImpl: nodeFetchRequestImpl });
		expect(node.apiCache?.ok).toBe(false);
		expect(node.apiCache?.error).toMatch(/not valid JSON/i);
		expect(node.apiItemState).toBeUndefined();
	});

	it("E3: a request that never resolves times out and is reported unreachable, with no real wait", async () => {
		const node = makeNode("n5");
		const controller = new ApiSourceController();
		// R1/R10: the timeout races `requestImpl` via `Promise.race` against an injectable
		// `scheduleTimeout` — firing that callback synchronously here proves the timeout path with zero
		// real elapsed time, rather than a real (even short) `setTimeout` wait.
		const neverResolves: RequestFn = () => new Promise(() => {});
		let firedTimeout: (() => void) | null = null;
		const fakeScheduleTimeout: ScheduleTimeout = (ms, onTimeout) => {
			expect(ms).toBe(50);
			firedTimeout = onTimeout;
			return () => {
				firedTimeout = null;
			};
		};
		const run = controller.refresh(node, baseSource("http://example.invalid/never"), [], () => {}, {
			requestImpl: neverResolves,
			timeoutMs: 50,
			scheduleTimeout: fakeScheduleTimeout,
		});
		expect(firedTimeout).not.toBeNull();
		firedTimeout?.();
		await run;
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

		await controller.refresh(node, baseSource(`http://127.0.0.1:${deadPort}/ok`), [], () => {}, {
			requestImpl: nodeFetchRequestImpl,
			timeoutMs: 500,
		});
		expect(node.apiCache?.ok).toBe(false);
		expect(node.apiCache?.error).toBe("unreachable");
	});

	it("E4: >5,000 rows truncates at the cap and skips not-found marking that refresh", async () => {
		const node = makeNode("n7");
		node.apiItemState = { stale: { id: "stale", label: "Stale" } };
		node.apiItemOrder = ["stale"];
		const controller = new ApiSourceController();
		await controller.refresh(node, baseSource(`${base}/manyrows`, { mode: "merge" }), [], () => {}, { requestImpl: nodeFetchRequestImpl });
		expect(node.apiCache?.rows).toHaveLength(5000);
		expect(node.apiCache?.truncated).toBe(true);
		// truncated refresh must not falsely mark "stale" not found (E4)
		expect(node.apiItemState?.stale.notFound).toBeUndefined();
	});

	it("E4: a later, untruncated refresh marks a genuinely vanished row \"not found\" normally", async () => {
		const node = makeNode("n7b");
		const controller = new ApiSourceController();
		// Seed "stale" as genuinely present first, so it gets a real lastSeenAt (R13) — not one
		// fabricated later from the refresh that merely notices it's gone.
		await controller.refresh(node, baseSource(`${base}/withstale`, { mode: "merge" }), [], () => {}, { requestImpl: nodeFetchRequestImpl, now: () => 5000 });
		const seenAt = node.apiItemState?.stale?.lastSeenAt;
		expect(seenAt).toBe(new Date(5000).toISOString());
		// Next refresh is truncated (5,001 rows, no "stale") — must not mark "stale" not-found (already covered above).
		await controller.refresh(node, baseSource(`${base}/manyrows`, { mode: "merge" }), [], () => {}, { requestImpl: nodeFetchRequestImpl });
		expect(node.apiItemState?.stale.notFound).toBeUndefined();
		// A later, ordinary (untruncated) refresh where "stale" is still genuinely absent must mark it
		// normally — truncation only ever suppresses the marking for the refresh that was itself truncated.
		await controller.refresh(node, baseSource(`${base}/ok`, { mode: "merge" }), [], () => {}, { requestImpl: nodeFetchRequestImpl, now: () => 99999 });
		expect(node.apiItemState?.stale?.notFound).toBe(true);
		// Keeps the time it was last actually seen present (from /withstale), not the time it was
		// noticed missing (the /ok refresh's own "now").
		expect(node.apiItemState?.stale?.lastSeenAt).toBe(seenAt);
	});

	it("G8: an item's explicit status and note survive a refresh where it's still reported", async () => {
		const node = makeNode("n8");
		node.apiItemState = { "1": { id: "1", label: "One", explicitStatusId: "in-progress", noteRef: { kind: "block", path: "pool/x.md", subpath: "x" } } };
		node.apiItemOrder = ["1"];
		const controller = new ApiSourceController();
		await controller.refresh(node, baseSource(`${base}/ok`), [], () => {}, { requestImpl: nodeFetchRequestImpl });
		expect(node.apiItemState?.["1"].explicitStatusId).toBe("in-progress");
		expect(node.apiItemState?.["1"].noteRef).toEqual({ kind: "block", path: "pool/x.md", subpath: "x" });
	});

	it("rapid double refresh-now collapses to a single in-flight request, with no real wait", async () => {
		const node = makeNode("n9");
		const controller = new ApiSourceController();
		let callCount = 0;
		let resolveRequest: ((result: { status: number; text: string }) => void) | null = null;
		// R10: a deferred promise the test resolves itself, instead of a real slow HTTP response —
		// proves the in-flight dedupe with zero real elapsed time.
		const deferredRequest: RequestFn = () => {
			callCount++;
			return new Promise((resolve) => {
				resolveRequest = resolve;
			});
		};
		const source = baseSource("http://example.invalid/deferred");
		const [a, b] = [
			controller.refresh(node, source, [], () => {}, { requestImpl: deferredRequest }),
			controller.refresh(node, source, [], () => {}, { requestImpl: deferredRequest }),
		];
		expect(resolveRequest).not.toBeNull();
		resolveRequest?.({ status: 200, text: JSON.stringify([{ id: "1", name: "One" }]) });
		await Promise.all([a, b]);
		expect(callCount).toBe(1);
	});

	it("R15: a save that changes the source while a refresh is in flight queues one follow-up refresh with the new config, rather than dropping it or firing both at once", async () => {
		const node = makeNode("n11");
		const controller = new ApiSourceController();
		let firstCalls = 0;
		let secondCalls = 0;
		let resolveFirst: ((result: { status: number; text: string }) => void) | null = null;
		const firstRequest: RequestFn = () => {
			firstCalls++;
			return new Promise((resolve) => {
				resolveFirst = resolve;
			});
		};
		const secondRequest: RequestFn = async () => {
			secondCalls++;
			return { status: 200, text: JSON.stringify([{ id: "new", name: "New" }]) };
		};
		const oldSource = baseSource("http://example.invalid/old");
		const newSource = baseSource("http://example.invalid/new");

		const first = controller.refresh(node, oldSource, [], () => {}, { requestImpl: firstRequest });
		// The user saves a changed config (different URL) before the first request resolves.
		const second = controller.refresh(node, newSource, [], () => {}, { requestImpl: secondRequest });
		expect(second).not.toBe(first);
		expect(secondCalls).toBe(0); // queued behind the first, not fired concurrently with the stale config

		resolveFirst?.({ status: 200, text: JSON.stringify([{ id: "old", name: "Old" }]) });
		await Promise.all([first, second]);

		expect(firstCalls).toBe(1);
		expect(secondCalls).toBe(1);
		// The final state reflects the *new* config's response — the old one's result was superseded,
		// not merged into the node under the new config.
		expect(node.apiCache?.rows).toEqual([{ id: "new", label: "New" }]);
	});

	it("R15: a repeated refresh with the *same* source while one is in flight still collapses into one request (E9 unaffected)", async () => {
		const node = makeNode("n12");
		const controller = new ApiSourceController();
		let calls = 0;
		let resolveRequest: ((result: { status: number; text: string }) => void) | null = null;
		const deferredRequest: RequestFn = () => {
			calls++;
			return new Promise((resolve) => {
				resolveRequest = resolve;
			});
		};
		const source = baseSource("http://example.invalid/same");
		const first = controller.refresh(node, source, [], () => {}, { requestImpl: deferredRequest });
		const second = controller.refresh(node, source, [], () => {}, { requestImpl: deferredRequest });
		expect(second).toBe(first);
		resolveRequest?.({ status: 200, text: JSON.stringify([{ id: "1", name: "One" }]) });
		await Promise.all([first, second]);
		expect(calls).toBe(1);
	});

	it("F1: always issues GET, regardless of anything else — no write verb ever reaches the request layer", async () => {
		const node = makeNode("n10");
		const controller = new ApiSourceController();
		let observedMethod: string | null = null;
		const spyRequest: RequestFn = async ({ method }) => {
			observedMethod = method;
			return { status: 200, text: JSON.stringify([{ id: "1", name: "One" }]) };
		};
		await controller.refresh(node, baseSource("http://example.invalid/spy"), [], () => {}, { requestImpl: spyRequest });
		expect(observedMethod).toBe("GET");
	});

	it("R3: lastSuccessAt survives a later failed refresh, and the tooltip keeps reporting it, not the failed attempt's own time", async () => {
		const node = makeNode("n11");
		const controller = new ApiSourceController();
		let now = 1_000_000;
		await controller.refresh(node, baseSource(`${base}/ok`), [], () => {}, { requestImpl: nodeFetchRequestImpl, now: () => now });
		expect(node.apiCache?.lastSuccessAt).toBe(1_000_000);

		now = 1_000_000 + 3 * 60 * 60 * 1000; // 3 hours later
		await controller.refresh(node, baseSource(`${base}/auth401`), [], () => {}, { requestImpl: nodeFetchRequestImpl, now: () => now });
		expect(node.apiCache?.ok).toBe(false);
		expect(node.apiCache?.lastSuccessAt).toBe(1_000_000);
		expect(dotTooltip(node.apiCache, now)).toBe("auth failed, last updated 3 h ago");
	});

	it("R3: a failed refresh keeps the previous cache's rows visible, not an empty list", async () => {
		const node = makeNode("n12");
		const controller = new ApiSourceController();
		await controller.refresh(node, baseSource(`${base}/ok`), [], () => {}, { requestImpl: nodeFetchRequestImpl });
		const rowsBefore = node.apiCache?.rows;
		expect(rowsBefore).toHaveLength(2);

		await controller.refresh(node, baseSource(`${base}/auth401`), [], () => {}, { requestImpl: nodeFetchRequestImpl });
		expect(node.apiCache?.ok).toBe(false);
		expect(node.apiCache?.rows).toEqual(rowsBefore);
	});

	it("R10/G13: the header (token) value never leaks into a cached error message, even on the auth failure it caused", async () => {
		const node = makeNode("n13");
		const controller = new ApiSourceController();
		const secretToken = "Bearer super-secret-token-xyz";
		await controller.refresh(node, baseSource(`${base}/auth401`), [{ key: "Authorization", value: secretToken }], () => {}, {
			requestImpl: nodeFetchRequestImpl,
		});
		expect(node.apiCache?.ok).toBe(false);
		expect(node.apiCache?.error).not.toContain(secretToken);
		expect(JSON.stringify(node.apiCache)).not.toContain(secretToken);
	});
});

describe("R17/E9 — doRefresh never rejects; any thrown error becomes a red-dot cache error", () => {
	it("a source with no mapping (mapResponseRows would read undefined.arrayField) is caught, not thrown, and reported as a failed refresh", async () => {
		const node = makeNode("n14");
		const controller = new ApiSourceController();
		const brokenSource = { url: `http://example.invalid/broken`, method: "GET", mode: "merge", refreshOnViewLoad: false } as unknown as ApiSourceConfig;
		const okRequest: RequestFn = async () => ({ status: 200, text: JSON.stringify([{ id: "1", name: "One" }]) });

		await expect(controller.refresh(node, brokenSource, [], () => {}, { requestImpl: okRequest })).resolves.toBeUndefined();
		expect(node.apiCache?.ok).toBe(false);
		expect(dotStateFor(node.apiCache)).toBe("red");
	});

	it("a corrupt apiItemOrder that reaches refresh (not an array) is caught by doRefresh instead of rejecting the whole promise", async () => {
		const node = makeNode("n15");
		node.apiItemOrder = {} as unknown as string[];
		const controller = new ApiSourceController();
		const okRequest: RequestFn = async () => ({ status: 200, text: JSON.stringify([{ id: "1", name: "One" }]) });

		await expect(controller.refresh(node, baseSource("http://example.invalid/ok"), [], () => {}, { requestImpl: okRequest })).resolves.toBeUndefined();
		expect(node.apiCache?.ok).toBe(false);
		expect(dotStateFor(node.apiCache)).toBe("red");
	});

	it("a caught error still keeps the previous good cache's rows, same as an ordinary failed refresh (E1/R3)", async () => {
		const node = makeNode("n16");
		const controller = new ApiSourceController();
		const okRequest: RequestFn = async () => ({ status: 200, text: JSON.stringify([{ id: "1", name: "One" }]) });
		await controller.refresh(node, baseSource("http://example.invalid/ok"), [], () => {}, { requestImpl: okRequest, now: () => 1000 });
		expect(node.apiCache?.rows).toHaveLength(1);

		const brokenSource = { url: `http://example.invalid/broken`, method: "GET", mode: "merge", refreshOnViewLoad: false } as unknown as ApiSourceConfig;
		await controller.refresh(node, brokenSource, [], () => {}, { requestImpl: okRequest, now: () => 2000 });
		expect(node.apiCache?.ok).toBe(false);
		expect(node.apiCache?.rows).toHaveLength(1);
		expect(node.apiCache?.lastSuccessAt).toBe(1000);
	});

	it("a queued R15 follow-up refresh still runs after the in-flight refresh throws, instead of being silently dropped", async () => {
		const node = makeNode("n17");
		const controller = new ApiSourceController();
		let resolveFirst: ((result: { status: number; text: string }) => void) | null = null;
		const firstRequest: RequestFn = () =>
			new Promise((resolve) => {
				resolveFirst = resolve;
			});
		let secondCalls = 0;
		const secondRequest: RequestFn = async () => {
			secondCalls++;
			return { status: 200, text: JSON.stringify([{ id: "new", name: "New" }]) };
		};
		const brokenSource = { url: "http://example.invalid/broken", method: "GET", mode: "merge", refreshOnViewLoad: false } as unknown as ApiSourceConfig;
		const newSource = baseSource("http://example.invalid/new");

		const first = controller.refresh(node, brokenSource, [], () => {}, { requestImpl: firstRequest });
		const second = controller.refresh(node, newSource, [], () => {}, { requestImpl: secondRequest });

		resolveFirst?.({ status: 200, text: JSON.stringify([{ id: "1", name: "One" }]) });
		await Promise.all([first, second]);

		expect(secondCalls).toBe(1);
		expect(node.apiCache?.rows).toEqual([{ id: "new", label: "New" }]);
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
