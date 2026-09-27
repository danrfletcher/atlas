/** Resolution-only stand-in for the real "obsidian" package, which ships types but no runtime module
 * (its package.json has `"main": ""`), so vitest's resolver otherwise fails before a per-test
 * `vi.mock("obsidian", factory)` ever gets a chance to intercept it. Only wired via `vitest.config.ts`'s
 * `resolve.alias`, purely so that specifier resolves to a real file; any test that actually touches
 * these exports at runtime must supply its own `vi.mock("obsidian", ...)` with real fakes. */
export {};
