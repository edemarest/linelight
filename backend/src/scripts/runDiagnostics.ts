import { runDiagnosticsCli } from "./diagnostics/runner";

if (require.main === module) {
  runDiagnosticsCli(process.argv.slice(2)).catch((error) => {
    console.error("[diagnostics] failed", error);
    process.exitCode = 1;
  });
}

export { runDiagnosticsCli };
