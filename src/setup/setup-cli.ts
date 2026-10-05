/**
 * Command line for `bun run setup`.
 *
 * It shows what it intends to write and only then writes it. Existing files
 * are never replaced, so running it twice is safe; the second run just says
 * everything is already in place.
 */
import { detectFirmwareDir, type SecretSource } from './files';
import { applySetupPlan, buildSetupPlan, buildSetupPreview, type SetupPlan } from './plan';
import { detectLanAddress } from './network';
import { parseArguments, parseStrictInteger, type FlagSpec } from './cli';

const FLAGS: readonly FlagSpec[] = [
  { name: 'dry-run', takesValue: false },
  { name: 'non-interactive', takesValue: false },
  { name: 'firmware-dir', takesValue: true },
  { name: 'host', takesValue: true },
  { name: 'port', takesValue: true },
  { name: 'device-id', takesValue: true },
  {
    name: 'board',
    takesValue: true,
  },
  { name: 'help', takesValue: false },
];

export const SETUP_USAGE = [
  'Usage: bun run setup [options]',
  '',
  'Prepares this Mac and the device so both hold the same secret. Existing',
  'files are never overwritten.',
  '',
  '  --dry-run                  show the plan and write nothing',
  '  --non-interactive          write without asking for confirmation',
  '  --firmware-dir <path>      device folder holding sdkconfig.defaults.local',
  '  --host <host>              address the device dials (this Mac on the LAN)',
  '  --port <port>              listener port (default 8790)',
  '  --device-id <id>           name the device reports (default follows the detected watch)',
  '  --board <esp32-s3-touch-lcd-1.85c|esp32-s3-touch-amoled-2.06>',
  '                             pin the watch this Mac is being wired for;',
  '                             overrides a stale sdkconfig in the firmware folder',
].join('\n');

export type SetupCommandDeps = {
  readonly environment?: NodeJS.ProcessEnv;
  readonly workingDirectory?: string;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly confirm?: (question: string) => Promise<boolean>;
  readonly detectHostAddress?: () => string | null;
  readonly randomSecret?: () => string;
  readonly isTty?: boolean;
};

function describeSecretSource(source: SecretSource): string {
  switch (source) {
    case 'environment':
      return 'taken from VOICEMODE_DEVICE_SECRET';
    case 'env-file':
      return 'reused from the existing Mac config';
    case 'firmware':
      return 'reused from the existing device config';
    case 'generated':
      return 'newly generated for both sides';
  }
}

const ACTION_WORDS: Record<string, string> = {
  create: 'create',
  keep: 'keep (already there, left untouched)',
};

export async function setupMain(
  arguments_: readonly string[],
  deps: SetupCommandDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const parsed = parseArguments(arguments_, FLAGS);
  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) {
      stderr(`${error}\n`);
    }
    stderr(`${SETUP_USAGE}\n`);
    return 2;
  }
  if (parsed.present.has('help')) {
    stdout(`${SETUP_USAGE}\n`);
    return 0;
  }

  const portText = parsed.values.get('port');
  const port = parseStrictInteger(portText);
  if (portText !== undefined && (port === null || port <= 0 || port > 65_535)) {
    stderr('Not a usable port. Pass --port with a number from 1 to 65535.\n');
    return 2;
  }

  const environment = deps.environment ?? process.env;
  const workingDirectory = deps.workingDirectory ?? process.cwd();
  const firmwareDirValue = parsed.values.get('firmware-dir');
  const firmwareDir = parsed.values.has('firmware-dir')
    ? firmwareDirValue !== undefined && firmwareDirValue.trim().length > 0 ? firmwareDirValue : null
    : detectFirmwareDir(workingDirectory, environment);
  const detectHost = deps.detectHostAddress ?? detectLanAddress;
  const host = parsed.values.get('host') ?? detectHost();

  let plan: SetupPlan;
  try {
    plan = buildSetupPlan({
      environment,
      firmwareDir,
      host,
      port: port ?? undefined,
      deviceId: parsed.values.get('device-id'),
      board: parsed.values.get('board') ?? null,
      randomSecret: deps.randomSecret,
    });
  } catch (error) {
    stderr(`Could not read the existing configuration: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const preview = buildSetupPreview(plan);

  const lines = [
    'esp32 voice mode setup - preview',
    `  this Mac:       ${preview.host ?? '(unknown - pass --host)'}:${preview.port}`,
    `  device id:      ${preview.deviceId}`,
  ];
  if (preview.board !== null) {
    lines.push(`  watch:          ${preview.board}`);
  } else {
    lines.push('  watch:          (not detected - pass --board)');
  }
  if (preview.buildCommand !== null) {
    lines.push(`  firmware build: ${preview.buildCommand}`);
  }
  lines.push(
    `  shared secret:  ${describeSecretSource(preview.secretSource)}`,
    `  Mac config:     ${ACTION_WORDS[preview.mac.action]} ${preview.mac.path}`,
  );
  if (preview.firmware !== null) {
    lines.push(`  device config:  ${ACTION_WORDS[preview.firmware.action]} ${preview.firmware.path}`);
  } else {
    lines.push('  device config:  not written (no firmware folder given)');
  }
  stdout(`${lines.join('\n')}\n`);

  for (const warning of preview.warnings) {
    stderr(`warning: ${warning}\n`);
  }
  if (preview.errors.length > 0) {
    for (const error of preview.errors) {
      stderr(`problem: ${error}\n`);
    }
    return 1;
  }

  if (parsed.present.has('dry-run')) {
    stdout('Dry run: nothing was written.\n');
    return 0;
  }

  if (!parsed.present.has('non-interactive')) {
    const isTty = deps.isTty ?? process.stdin.isTTY === true;
    if (!isTty) {
      stderr('Refusing to write without confirmation. Pass --non-interactive to proceed.\n');
      return 1;
    }
    const confirm = deps.confirm ?? (async (question: string) => {
      const answer = prompt(question);
      return typeof answer === 'string' && /^y(es)?$/i.test(answer.trim());
    });
    const approved = await confirm('Write these files? [y/N] ');
    if (!approved) {
      stdout('Nothing was written.\n');
      return 1;
    }
  }

  try {
    const { created } = applySetupPlan(plan);
    if (created.length === 0) {
      stdout(
        plan.warnings.length === 0
          ? 'Everything was already in place; nothing was written.\n'
          : 'Nothing was written; see the notes above.\n',
      );
    } else {
      stdout(`Wrote ${created.length} file(s):\n`);
      for (const filePath of created) {
        stdout(`  ${filePath}\n`);
      }
    }
  } catch (error) {
    stderr(`Could not write the files: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  return 0;
}
