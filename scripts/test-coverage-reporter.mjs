import { once } from "node:events";
import { appendFileSync } from "node:fs";
import { spec } from "node:test/reporters";

export const COVERAGE_COMPONENT_ENV = "REPOSITORY_TEST_COVERAGE_COMPONENT";
export const COVERAGE_SUMMARY_ENV = "REPOSITORY_TEST_COVERAGE_SUMMARY";

function isPercentage(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}

function emitWarning(warn, message) {
  try {
    warn(message);
  } catch {
    // A broken warning stream must not turn coverage reporting into a gate.
  }
}

export function coverageRow(event, component) {
  if (event?.type !== "test:coverage" || !component) return null;

  const totals = event.data?.summary?.totals;
  const values = [
    totals?.coveredLinePercent,
    totals?.coveredBranchPercent,
    totals?.coveredFunctionPercent,
  ];
  if (!values.every(isPercentage)) return null;
  return `| ${component} | ${values.map((value) => `${value.toFixed(2)}%`).join(" | ")} |\n`;
}

export function coverageSummaryCollector(options) {
  const { component, summaryPath, append, warn } = options;
  let coverageEvents = 0;
  let finalRow;

  return {
    observe(event) {
      if (event?.type !== "test:coverage") return;
      coverageEvents += 1;
      if (coverageEvents === 2) {
        emitWarning(warn, `warning: coverage summary: ${component}: duplicate coverage events; using final valid totals`);
      }

      const row = coverageRow(event, component);
      if (row) finalRow = row;
      else emitWarning(warn, `warning: coverage summary: ${component || "unknown component"}: invalid coverage summary`);
    },
    finish() {
      if (coverageEvents === 0) {
        emitWarning(warn, `warning: coverage summary: ${component}: missing coverage summary`);
        return;
      }
      if (!finalRow || !summaryPath) return;
      try {
        append(summaryPath, finalRow, "utf8");
      } catch (error) {
        emitWarning(warn, `warning: coverage summary: ${component}: could not append row: ${error.message}`);
      }
    },
  };
}

export async function* coverageReporter(source, options = {}) {
  const component = options.component ?? process.env[COVERAGE_COMPONENT_ENV];
  const summaryPath = options.summaryPath ?? process.env[COVERAGE_SUMMARY_ENV];
  const append = options.append ?? appendFileSync;
  const warn = options.warn ?? ((message) => console.error(message));
  const collector = coverageSummaryCollector({ component, summaryPath, append, warn });
  const specReporter = (options.specFactory ?? spec)();

  const forwardEvents = (async () => {
    try {
      for await (const event of source) {
        if (component && summaryPath) collector.observe(event);
        if (!specReporter.write(event)) await once(specReporter, "drain");
      }
      if (component && summaryPath) collector.finish();
      specReporter.end();
    } catch (error) {
      specReporter.destroy(error);
    }
  })();

  for await (const chunk of specReporter) yield chunk;
  await forwardEvents;
}

export default coverageReporter;
