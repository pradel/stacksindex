import { execFileSync, spawn } from "node:child_process";
import console from "node:console";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { DEVNET_API_URL, LOCAL_DEVNET_API_URL, readChainTip, waitUntil } from "./chain.ts";
import { readSeedHistory } from "./seed.ts";

const CLARINET_VERSION = "3.25.0";

const PROJECT_DIR = path.resolve(import.meta.dirname, "../clarinet");

const LOG_FILE = path.join(PROJECT_DIR, ".cache", "devnet.log");

/** Cold starts pull every Docker image before booting the chain. */
const STARTUP_TIMEOUT_MS = 15 * 60_000;

const SHUTDOWN_TIMEOUT_MS = 60_000;

const INSTALL_HINT = `Install clarinet ${CLARINET_VERSION}: https://github.com/stx-labs/clarinet/releases/tag/v${CLARINET_VERSION}`;

function readClarinetVersion(): string {
  try {
    return execFileSync("clarinet", ["--version"], { encoding: "utf8" }).trim();
  } catch (error) {
    throw new Error(`clarinet was not found on PATH. ${INSTALL_HINT}`, { cause: error });
  }
}

async function waitForSeed(timeoutMs: number): Promise<void> {
  const seed = await waitUntil("the devnet seed deployment", readSeedHistory, timeoutMs);

  console.info(
    `[devnet] seed history ready: blocks ${seed.deployHeight}-${seed.endHeight} (${DEVNET_API_URL})`,
  );
}

/**
 * Clarinet names its containers `<service>.<project name>.devnet`. Checking
 * them catches a devnet that is still booting and does not serve the API yet;
 * starting a second one would clash on container names and tear the first down.
 */
function devnetContainersRunning(): boolean {
  try {
    return (
      execFileSync("docker", ["ps", "--quiet", "--filter", "name=.stacksindex-e2e-devnet.devnet"], {
        encoding: "utf8",
      }).trim() !== ""
    );
  } catch {
    // Without Docker, starting the devnet below reports the actual problem.
    return false;
  }
}

/**
 * Reuses a devnet that serves `DEVNET_API_URL` or is still booting; otherwise
 * starts one with Clarinet and stops it after the run.
 */
export default async function setup(): Promise<(() => Promise<void>) | undefined> {
  const reachable = await readChainTip().then(
    () => true,
    () => false,
  );

  // Only the local URL can be served by the devnet started below.
  if (!reachable && DEVNET_API_URL !== LOCAL_DEVNET_API_URL) {
    throw new Error(`STACKS_DEVNET_API_URL ${DEVNET_API_URL} is unreachable`);
  }

  if (reachable || devnetContainersRunning()) {
    console.info(`[devnet] reusing the devnet at ${DEVNET_API_URL}`);
    await waitForSeed(STARTUP_TIMEOUT_MS);

    return undefined;
  }

  const version = readClarinetVersion();

  if (version !== `clarinet ${CLARINET_VERSION}`) {
    throw new Error(`Expected clarinet ${CLARINET_VERSION}, found "${version}". ${INSTALL_HINT}`);
  }

  mkdirSync(path.dirname(LOG_FILE), { recursive: true });

  const logFd = openSync(LOG_FILE, "w");

  // Clarinet bind-mounts per-run data directories into its containers.
  // The bitcoind image runs as uid 1000: on Linux they must be world-writable.
  // `exec` keeps clarinet as the process that receives SIGINT.
  const devnet = spawn(
    "sh",
    ["-c", "umask 0000 && exec clarinet devnet start --no-dashboard --use-on-disk-deployment-plan"],
    { cwd: PROJECT_DIR, stdio: ["ignore", logFd, logFd] },
  );

  const exit = Promise.withResolvers<number | null>();
  const exited = exit.promise;

  devnet.once("exit", exit.resolve);

  closeSync(logFd);
  console.info(`[devnet] starting clarinet devnet, logs in ${LOG_FILE}`);

  const stop = async (): Promise<void> => {
    if (devnet.exitCode !== null) {
      return;
    }

    // Clarinet removes its containers and network on SIGINT.
    devnet.kill("SIGINT");

    const stopped = await Promise.race([
      exited.then(() => true),
      sleep(SHUTDOWN_TIMEOUT_MS, false, { ref: false }),
    ]);

    if (!stopped) {
      devnet.kill("SIGKILL");
      console.warn(`[devnet] clarinet did not stop within ${SHUTDOWN_TIMEOUT_MS}ms`);
    }
  };

  try {
    await Promise.race([
      waitForSeed(STARTUP_TIMEOUT_MS),
      exited.then((code) => {
        throw new Error(`clarinet devnet exited with code ${code} before the seed was deployed`);
      }),
    ]);
  } catch (error) {
    await stop();
    const logTail = readFileSync(LOG_FILE, "utf8").split("\n").slice(-40).join("\n");

    throw new Error(`Devnet startup failed. Last log lines:\n${logTail}`, { cause: error });
  }

  return stop;
}
