/** Native API an addon must provide, derived from `index.d.ts` by `scripts/gen-enums.ts`. */
export interface RequiredNativeSurface {
	/** Exported function names (release-identity exports excluded). */
	functions: readonly string[];
	/** Exported class name → prototype method names (no constructors, statics, or accessors). */
	classes: Readonly<Record<string, readonly string[]>>;
}

export const requiredNativeSurface: RequiredNativeSurface;
