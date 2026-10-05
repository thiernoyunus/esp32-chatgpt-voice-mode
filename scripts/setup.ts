#!/usr/bin/env bun
/** Entry point for `bun run setup`; the work lives in src/setup. */
import { setupMain } from '../src/setup/setup-cli';

process.exitCode = await setupMain(process.argv.slice(2));
