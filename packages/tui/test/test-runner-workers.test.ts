import { describe, expect, it } from "bun:test";
import { testWorkers } from "../scripts/test";

describe("tui test runner worker count", () => {
	it("uses every core when OMP_TEST_CONCURRENCY is unset, blank, all or max", () => {
		expect(testWorkers(undefined, 32)).toBe(32);
		expect(testWorkers("  ", 32)).toBe(32);
		expect(testWorkers("all", 32)).toBe(32);
		expect(testWorkers("MAX", 32)).toBe(32);
	});

	it("bounds the workers to OMP_TEST_CONCURRENCY, as the omp-gate container sets it", () => {
		expect(testWorkers("8", 32)).toBe(8);
		expect(testWorkers(" 3 ", 32)).toBe(3);
		expect(testWorkers("2.9", 32)).toBe(2);
	});

	it("never runs more workers than cores, nor fewer than one", () => {
		expect(testWorkers("64", 32)).toBe(32);
		expect(testWorkers(undefined, 0)).toBe(1);
		expect(testWorkers("4", 0)).toBe(1);
	});

	it("refuses a value that is not a positive count", () => {
		for (const bad of ["0", "-1", "0.5", "eight", "NaN", "Infinity"]) {
			expect(() => testWorkers(bad, 32)).toThrow(/Invalid OMP_TEST_CONCURRENCY/);
		}
	});
});
