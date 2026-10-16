/**
 * The stdin-driven psql session the native two-session qualification scripts share (qualify-*-native.mjs). Each
 * `send` writes SQL and resolves once psql has finished it, with the stdout it printed and the errors it raised.
 *
 * The completion marker goes to both streams. psql writes a command's error to stderr before it runs the next command,
 * so the `\warn` marker arrives after that error on the same pipe. Waiting for the stdout `\echo` alone (as every one
 * of these scripts did) could resolve before the error was read: a refusal check then saw nothing, and a "no error"
 * check passed on nothing. One clinic-status run at 14cc2e46 recorded exactly that ("cannot write into clinic A ()").
 */
export function psqlSender(child, name, timeoutCode, timeoutMs = 60_000) {
  let output = '', errors = '', marker = 0;
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { errors += chunk; });
  return function send(sql) {
    const id = `__done_${name}_${++marker}__`;
    const startOut = output.length, startErr = errors.length;
    child.stdin.write(`${sql}\n\\echo ${id}\n\\warn ${id}\n`);
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(Error(`${timeoutCode}:${name}`)), timeoutMs);
      const check = () => {
        if (output.includes(id, startOut) && errors.includes(id, startErr)) {
          clearTimeout(deadline); child.stdout.off('data', check); child.stderr.off('data', check);
          resolve({ output: output.slice(startOut, output.indexOf(id, startOut)).trim(), error: errors.slice(startErr, errors.indexOf(id, startErr)).trim() });
        }
      };
      child.stdout.on('data', check); child.stderr.on('data', check); check();
    });
  };
}
