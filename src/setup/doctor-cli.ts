/**
 * Command line for `bun run doctor`.
 *
 * Read-only: the only thing it can create is the optional report file, and
 * even then it refuses to overwrite one that already exists.
 */
import { writePrivateFileExclusive } from './files';
import {
  renderDoctorJson,
  renderDoctorText,
  runDoctor,
  type DoctorReport,
} from './doctor';
import type { CodexVersionProbe } from './codex-path';
import { parseArguments, parseStrictInteger, type FlagSpec } from './cli';

const FLAGS: readonly FlagSpec[] = [
  { name: 'json', takesValue: false },
  { name: 'report', takesValue: true },
  { name: 'firmware-dir', takesValue: true },
  { name: 'host', takesValue: true },
  { name: 'port', takesValue: true },
  { name: 'codex-bin', takesValue: true },
  { name: 'help', takesValue: false },
];

export const DOCTOR_USAGE = [
  'Usage: bun run doctor [options]',
  '',
  'Checks this Mac without changing anything: shared secret, device config,',
  'Codex, and a local listener.',
  '',
  '  --json                  print the report as JSON',
  '  --report <path>         also write the report to a new file (never overwrites)',
  '  --firmware-dir <path>   folder holding sdkconfig.defaults.local',
  '  --host <host>           listener address to check (must be this Mac)',
  '  --port <port>           listener port (default 8790)',
  '  --codex-bin <path>      Codex program to check, instead of the bundled one',
].join('\n');

export type DoctorCommandDeps = {
  readonly environment?: NodeJS.ProcessEnv;
  readonly workingDirectory?: string;
  readonly fetchImpl?: typeof fetch;
  readonly listenerTimeoutMilliseconds?: number;
  readonly probeVersion?: (executablePath: string) => Promise<CodexVersionProbe>;
  readonly codexFileExists?: (path: string) => boolean;
  readonly whichCodex?: () => string | null;
  readonly bundledCodexPath?: string;
  readonly now?: () => Date;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
};

export async function doctorMain(
  arguments_: readonly string[],
  deps: DoctorCommandDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const parsed = parseArguments(arguments_, FLAGS);
  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) {
      stderr(`${error}\n`);
    }
    stderr(`${DOCTOR_USAGE}\n`);
    return 2;
  }
  if (parsed.present.has('help')) {
    stdout(`${DOCTOR_USAGE}\n`);
    return 0;
  }

  const portText = parsed.values.get('port');
  const port = parseStrictInteger(portText);
  if (portText !== undefined && (port === null || port <= 0 || port > 65_535)) {
    stderr('Not a usable port. Pass --port with a number from 1 to 65535.\n');
    return 2;
  }

  let report: DoctorReport;
  try {
    const firmwareDirValue = parsed.values.get('firmware-dir');
    report = await runDoctor({
      environment: deps.environment,
      workingDirectory: deps.workingDirectory,
      firmwareDir: parsed.values.has('firmware-dir')
        ? firmwareDirValue !== undefined && firmwareDirValue.trim().length > 0 ? firmwareDirValue : null
        : undefined,
      codexBinOverride: parsed.values.get('codex-bin') ?? null,
      host: parsed.values.get('host'),
      port: port ?? undefined,
      fetchImpl: deps.fetchImpl,
      listenerTimeoutMilliseconds: deps.listenerTimeoutMilliseconds,
      probeVersion: deps.probeVersion,
      codexFileExists: deps.codexFileExists,
      whichCodex: deps.whichCodex,
      bundledCodexPath: deps.bundledCodexPath,
      now: deps.now,
    });
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  stdout(parsed.present.has('json') ? renderDoctorJson(report) : renderDoctorText(report));

  const reportPath = parsed.values.get('report');
  if (reportPath !== undefined) {
    try {
      writePrivateFileExclusive(reportPath, renderDoctorJson(report));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      stderr(
        code === 'EEXIST'
          ? `Refusing to overwrite the existing report file: ${reportPath}\n`
          : `Could not write the report file: ${reportPath}\n`,
      );
      return 1;
    }
  }

  return report.ok ? 0 : 1;
}
