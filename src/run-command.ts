// Run a trade/close command: print its JSON result, then exit explicitly.
//
// The Hyperliquid SDK starts a 60s asset-map refresh timer on the first
// exchange call (updateLeverage/placeOrder) and never unrefs it, so a command
// that only set process.exitCode would print its result and then keep running
// until killed — which an agent could read as a failure and retry. stdout is
// written synchronously for files and pipes on Linux, so nothing printed is lost.

export interface CommandIo {
  log(line: string): void;
  error(line: string): void;
  exit(code: number): void;
}

const processIo: CommandIo = {
  log: line => console.log(line),
  error: line => console.error(line),
  exit: code => process.exit(code),
};

/** Exit 0 on success, 1 when `failed(result)` says so or `run` throws. */
export async function runCommand<T>(run: () => Promise<T>, failed: (result: T) => boolean, io: CommandIo = processIo): Promise<void> {
  let code: number;
  try {
    const result = await run();
    io.log(JSON.stringify(result));
    code = failed(result) ? 1 : 0;
  } catch (e: any) {
    io.error(e?.message ?? String(e));
    code = 1;
  }
  io.exit(code);
}
