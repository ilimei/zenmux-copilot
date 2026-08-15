const assert = require("node:assert/strict");
const test = require("node:test");

const { ModelRefreshCache } = require("../out/modelRefreshCache.js");

test("caches an empty silent model resolution", () => {
	let now = 1_000;
	const cache = new ModelRefreshCache(300_000, () => now);

	assert.equal(cache.shouldRefresh(true), true);
	cache.markRefreshed();
	assert.equal(cache.shouldRefresh(true), false);

	now += 300_001;
	assert.equal(cache.shouldRefresh(true), true);
});

test("refreshes after explicit invalidation", () => {
	const cache = new ModelRefreshCache(300_000, () => 1_000);

	cache.markRefreshed();
	assert.equal(cache.shouldRefresh(true), false);
	cache.invalidate();
	assert.equal(cache.shouldRefresh(true), true);
});

test("allows an interactive request to refresh a cached result", () => {
	const cache = new ModelRefreshCache(300_000, () => 1_000);

	cache.markRefreshed();
	assert.equal(cache.shouldRefresh(false), true);
});
