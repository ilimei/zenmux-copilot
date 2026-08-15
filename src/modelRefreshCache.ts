/**
 * Tracks when the model list was last resolved, including an empty result.
 *
 * Empty results must be cached as well. Otherwise a provider with no API key
 * can be resolved continuously by VS Code's model discovery pipeline.
 */
export class ModelRefreshCache {
	private refreshedAt = 0;

	constructor(
		private readonly ttlMs: number,
		private readonly now: () => number = Date.now
	) {}

	shouldRefresh(silent: boolean): boolean {
		return !silent || this.refreshedAt === 0 || this.now() - this.refreshedAt > this.ttlMs;
	}

	markRefreshed(): void {
		this.refreshedAt = this.now();
	}

	invalidate(): void {
		this.refreshedAt = 0;
	}
}
