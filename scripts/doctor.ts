#!/usr/bin/env bun
/** Entry point for `bun run doctor`; the work lives in src/setup. */
import { doctorMain } from '../src/setup/doctor-cli';

process.exitCode = await doctorMain(process.argv.slice(2));
