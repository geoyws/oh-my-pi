#!/usr/bin/env bun
// Entry for scripts/four-dimension-coverage; see four-dimension.ts and docs/four-dimension-coverage.md.
import { main } from "./four-dimension";

process.exitCode = await main(process.argv.slice(2));
