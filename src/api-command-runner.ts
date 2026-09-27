import { spawn } from "child_process";
import { Notice } from "obsidian";

export interface CommandRunResult {
	ok: boolean;
	exitCode?: number | null;
	error?: string;
}

export interface CommandRunnerOptions {
	noticeImpl?: (message: string) => void;
	spawnImpl?: typeof spawn;
}

/**
 * G9b/E10: Executes a command in the background on desktop without using a shell (`shell: false`).
 *
 * Atlas stays responsive while the command runs.
 * If the command exits 0, no notice is shown.
 * If the command fails (non-zero exit code or executable not found / cannot spawn),
 * a brief notice shows the exit message.
 * Stacking multiple notices from a single run is prevented.
 */
export function executeApiCommand(argv: string[], options?: CommandRunnerOptions): Promise<CommandRunResult> {
	const notify = options?.noticeImpl ?? ((msg: string) => new Notice(msg));
	const spawner = options?.spawnImpl ?? spawn;

	return new Promise((resolve) => {
		if (argv.length === 0) {
			notify("Atlas: command is empty");
			resolve({ ok: false, error: "Command is empty" });
			return;
		}

		let notified = false;
		const notifyOnce = (msg: string) => {
			if (notified) return;
			notified = true;
			notify(msg);
		};

		const executable = argv[0];
		const args = argv.slice(1);

		let child: ReturnType<typeof spawn>;
		try {
			child = spawner(executable, args, {
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			notifyOnce(`Atlas: command failed — ${message}`);
			resolve({ ok: false, error: message });
			return;
		}

		let stderr = "";
		let stdout = "";

		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderr += chunk.toString();
		});

		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdout += chunk.toString();
		});

		child.on("error", (err: Error) => {
			notifyOnce(`Atlas: command failed — ${err.message}`);
			resolve({ ok: false, error: err.message });
		});

		child.on("close", (code: number | null) => {
			if (code === 0) {
				resolve({ ok: true, exitCode: 0 });
			} else {
				const exitMsg = stderr.trim() || stdout.trim() || (code !== null ? `exit code ${code}` : "process terminated");
				notifyOnce(`Atlas: command failed: ${exitMsg}`);
				resolve({ ok: false, exitCode: code, error: exitMsg });
			}
		});
	});
}
